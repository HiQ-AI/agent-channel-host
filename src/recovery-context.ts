import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HostConfig } from './config.js';
import { recoveryContext } from './prompts.js';
import type { Store } from './store.js';
import type { Conversation } from './types.js';

interface RecoveryPayload {
  version: 1;
  conversationId: string;
  contextVersion: number;
  policyVersion: number;
  content: string;
  updatedAt: string;
}

export async function publishRecoveryContext(
  config: HostConfig,
  conversation: Conversation,
  store: Pick<Store, 'getConversationContext' | 'recoveryContextFile'>,
): Promise<string> {
  const current = store.getConversationContext(conversation.id);
  const payload: RecoveryPayload = {
    version: 1,
    conversationId: conversation.id,
    contextVersion: current?.version ?? 0,
    policyVersion: conversation.policyVersion,
    content: recoveryContext(config, conversation, current),
    updatedAt: new Date().toISOString(),
  };
  const path = store.recoveryContextFile(conversation.id);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return path;
}

export async function readRecoveryContext(path: string): Promise<RecoveryPayload> {
  const raw = await readFile(path, 'utf8');
  if (raw.length > 64 * 1024) throw new Error('recovery context 超过 64 KiB');
  const value = JSON.parse(raw) as Partial<RecoveryPayload>;
  if (
    value.version !== 1
    || typeof value.conversationId !== 'string'
    || typeof value.contextVersion !== 'number'
    || typeof value.policyVersion !== 'number'
    || typeof value.content !== 'string'
    || typeof value.updatedAt !== 'string'
  ) {
    throw new Error('recovery context 格式无效');
  }
  return value as RecoveryPayload;
}
