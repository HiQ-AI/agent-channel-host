import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HostConfig } from './config.js';
import { DwsSender, fetchRecentGroupHistory, type RecentGroupHistory } from './dws.js';
import { PRODUCT_ID } from './product.js';
import { delay } from './process-utils.js';
import { Store } from './store.js';
import type { Conversation, GroupOnboardingRecord } from './types.js';

type Row = Record<string, unknown>;

export interface DeliveryInspection {
  state: GroupOnboardingRecord['state'];
  historyLoaded: number;
  historyJudged: number;
  visibleMatches: number;
}

export interface DeliveryReconciliationResult extends DeliveryInspection {
  action: 'already_visible' | 'resent';
  backupPath: string;
  finalState: GroupOnboardingRecord['state'];
}

export interface DeliveryReconciliationDependencies {
  loadHistory?: (config: HostConfig, conversation: Conversation) => Promise<RecentGroupHistory>;
  send?: (conversation: Conversation, record: { text: string; uuid: string }) => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function inspectOnboardingDelivery(
  config: HostConfig,
  databasePath: string,
  conversationId: string,
  dependencies: DeliveryReconciliationDependencies = {},
): Promise<DeliveryInspection> {
  const snapshot = readReconciliationSnapshot(databasePath, conversationId);
  const history = await (dependencies.loadHistory ?? fetchRecentGroupHistory)(config, snapshot.conversation);
  return inspection(snapshot.onboarding, history);
}

export async function reconcileOnboardingDelivery(
  config: HostConfig,
  databasePath: string,
  conversationId: string,
  backupDirectory: string,
  dependencies: DeliveryReconciliationDependencies = {},
): Promise<DeliveryReconciliationResult> {
  const before = readReconciliationSnapshot(databasePath, conversationId);
  if (before.hostRunning) throw new Error('Host 仍在运行，拒绝协调 onboarding 发送');
  if (!['delivery_unknown', 'submitted'].includes(before.onboarding.state)) {
    throw new Error(`onboarding 状态必须是 delivery_unknown 或 submitted，当前为 ${before.onboarding.state}`);
  }
  const loadHistory = dependencies.loadHistory ?? fetchRecentGroupHistory;
  const latestHistory = await loadHistory(config, before.conversation);
  const beforeInspection = inspection(before.onboarding, latestHistory);
  const backupPath = await backupDatabase(databasePath, backupDirectory);
  const store = new Store(databasePath);
  try {
    if (store.status().hostState === 'running') throw new Error('Host 状态在备份后发生变化，拒绝协调发送');
    const current = store.getGroupOnboarding(conversationId);
    const conversation = store.getConversation(conversationId);
    if (!current || !conversation || !current.introText || !current.introUuid) {
      throw new Error('onboarding 协调目标不完整');
    }
    if (!['delivery_unknown', 'submitted'].includes(current.state) || current.introUuid !== before.onboarding.introUuid) {
      throw new Error('onboarding 状态在回查后发生变化，拒绝协调发送');
    }
    if (beforeInspection.visibleMatches > 0) {
      store.finishGroupOnboardingIntro(conversationId, 'delivered', null);
      return { ...beforeInspection, action: 'already_visible', backupPath, finalState: 'delivered' };
    }
    if (current.state === 'submitted') {
      throw new Error('DWS 已接受发送但群历史暂未可见，拒绝生成第二次发送');
    }

    const nextUuid = reconciliationUuid(conversation, current.introText, current.introUuid);
    const claimed = store.claimGroupOnboardingReconciliation(conversationId, current.introUuid, nextUuid);
    try {
      await (dependencies.send ?? ((target, record) => new DwsSender(config).send(target, record)))(
        conversation,
        { text: claimed.introText!, uuid: claimed.introUuid! },
      );
      store.finishGroupOnboardingIntro(conversationId, 'submitted', null);
    } catch (error) {
      store.finishGroupOnboardingIntro(conversationId, 'delivery_unknown', compactError(error));
      throw error;
    }

    const wait = dependencies.wait ?? delay;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) await wait(1_000);
      const readback = inspection(claimed, await loadHistory(config, conversation));
      if (readback.visibleMatches > 0) {
        store.finishGroupOnboardingIntro(conversationId, 'delivered', null);
        return { ...readback, action: 'resent', backupPath, finalState: 'delivered' };
      }
    }
    return { ...beforeInspection, action: 'resent', backupPath, finalState: 'submitted' };
  } finally {
    store.close();
  }
}

function readReconciliationSnapshot(databasePath: string, conversationId: string): {
  conversation: Conversation;
  onboarding: GroupOnboardingRecord;
  hostRunning: boolean;
} {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
    const conversation = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId) as Row | undefined;
    const onboarding = db.prepare('SELECT * FROM group_onboarding WHERE conversation_id=?').get(conversationId) as Row | undefined;
    const lease = db.prepare("SELECT expires_at_ms FROM host_lease WHERE lease_key='host'").get() as Row | undefined;
    if (!conversation || !onboarding) throw new Error('找不到指定群会话的 onboarding 状态');
    if (String(conversation.kind) !== 'group') throw new Error('只有群会话支持 onboarding 发送协调');
    if (!onboarding.intro_text || !onboarding.intro_uuid || !onboarding.intro_turn_id) {
      throw new Error('onboarding 没有完整的已判断回复');
    }
    return {
      conversation: mapConversation(conversation),
      onboarding: mapOnboarding(onboarding),
      hostRunning: Boolean(lease && Number(lease.expires_at_ms) > Date.now()),
    };
  } finally {
    db.close();
  }
}

function inspection(onboarding: GroupOnboardingRecord, history: RecentGroupHistory): DeliveryInspection {
  const expected = normalizeVisibleText(onboarding.introText!);
  return {
    state: onboarding.state,
    historyLoaded: onboarding.historyLoadedAt ? Number(onboarding.historyCount ?? 0) : 0,
    historyJudged: onboarding.introTurnId ? Number(onboarding.historyCount ?? 0) : 0,
    visibleMatches: history.messages.filter((message) => normalizeVisibleText(message.content) === expected).length,
  };
}

function normalizeVisibleText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

async function backupDatabase(databasePath: string, backupDirectory: string): Promise<string> {
  const directory = resolve(backupDirectory);
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = join(directory, `${basename(databasePath)}.${stamp}.bak`);
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  return destination;
}

function reconciliationUuid(conversation: Conversation, text: string, previousUuid: string): string {
  const hex = createHash('sha256').update(
    `${PRODUCT_ID}:onboarding:verified-resend:${conversation.channelId}:${conversation.channelProfileId}:${conversation.externalId}:${text}:${previousUuid}`,
  ).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function mapConversation(row: Row): Conversation {
  return {
    id: String(row.id), channelId: String(row.channel_id ?? 'dingtalk'),
    channelProfileId: String(row.channel_profile_id ?? 'default'), kind: 'group',
    externalId: String(row.external_id), title: String(row.title), responsibility: String(row.responsibility),
    mode: row.mode as Conversation['mode'], runtimeId: String(row.runtime_id ?? 'codex'),
    workerWarmSeconds: Number(row.worker_warm_seconds ?? 30), policyVersion: Number(row.policy_version ?? 1),
    sessionGeneration: Number(row.session_generation ?? 1), enabled: Boolean(row.enabled),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapOnboarding(row: Row): GroupOnboardingRecord {
  return {
    conversationId: String(row.conversation_id), state: row.state as GroupOnboardingRecord['state'],
    historyCount: row.history_count === null ? null : Number(row.history_count),
    historyLoadedAt: row.history_loaded_at ? String(row.history_loaded_at) : null,
    introTurnId: row.intro_turn_id ? String(row.intro_turn_id) : null,
    introText: row.intro_text ? String(row.intro_text) : null,
    introUuid: row.intro_uuid ? String(row.intro_uuid) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
}
