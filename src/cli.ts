#!/usr/bin/env node
import { Command } from 'commander';
import { access } from 'node:fs/promises';
import {
  CODEX_REASONING_EFFORTS, defaultConfig, loadConfig, writeConfig, writeInitialConfig,
} from './config.js';
import { configPath, statePath } from './paths.js';
import { Store } from './store.js';
import { dwsDoctor, resolveExactGroup } from './dws.js';
import { CodexCommandSession, verifyCodexCommand } from './codex-command.js';
import { runHost } from './host.js';
import { installUserService, removeUserService, windowsServicePlan } from './service.js';
import { MAX_WORKER_WARM_SECONDS } from './types.js';
import { assertInteractiveView, runView, shouldStartHostForView } from './view.js';
import { CLI_NAME } from './product.js';

const program = new Command();
program
  .name(CLI_NAME)
  .description('将 Channel 消息路由到每个会话独立、可恢复的 Agent runtime session')
  .version('0.4.0');

program.command('init')
  .description('初始化一个不含凭据的用户级 Host instance')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--cwd <path>', 'Codex 会话工作目录')
  .option('--name <name>', '数字化员工名称', 'DingTalk Agent')
  .option('--role <role>', '默认角色定位', '在授权会话内提供职责范围内的分析和答复')
  .option('--dws-command <path>', 'DWS 命令或绝对路径', 'dws')
  .option('--codex-command <path>', 'Codex 命令或绝对路径', 'codex')
  .option('--model <model>', '默认 Codex 模型', 'gpt-5.6-sol')
  .option('--effort <effort>', '默认推理强度', 'low')
  .option('--dws-profile <profile>', '可选的 DWS corpId:userId profile')
  .action(async (options) => {
    const path = configPath(options.instance);
    await access(path).then(
      () => { throw new Error(`配置已存在：${path}`); },
      () => undefined,
    );
    const config = defaultConfig(options.instance, options.cwd, options.name, options.role);
    config.channel.command = options.dwsCommand;
    config.runtime.command = options.codexCommand;
    config.runtime.model = options.model;
    config.runtime.effort = parseReasoningEffort(options.effort);
    if (options.dwsProfile) config.channel.profile = options.dwsProfile;
    await writeInitialConfig(config, path);
    const store = new Store(statePath(options.instance));
    store.setChannelConnection({
      channelId: config.channel.id, profileId: config.channel.profileId, label: 'DingTalk DWS',
      state: 'stopped', ownerPid: null,
    });
    store.setRuntimeAdapter({
      runtimeId: config.runtime.id, label: 'Codex CLI', state: 'stopped',
      model: config.runtime.model, contextRecovery: 'session-start-hook',
    });
    store.close();
    print({ ok: true, instance: options.instance, configPath: path, statePath: statePath(options.instance) });
  });

const configCommand = program.command('config').description('管理 Host instance 运行配置');
configCommand.command('model')
  .description('设置默认 Codex 模型和推理强度；运行中的 Host 需重启后生效')
  .requiredOption('--instance <name>', 'instance 名称')
  .option('--model <model>', '默认 Codex 模型')
  .option('--effort <effort>', '默认推理强度')
  .action(async (options) => {
    if (options.model === undefined && options.effort === undefined) {
      throw new Error('--model 和 --effort 至少提供一项');
    }
    const config = await loadConfig(options.instance);
    if (options.model !== undefined) {
      const model = String(options.model).trim();
      if (!model) throw new Error('--model 不能为空');
      config.runtime.model = model;
    }
    if (options.effort !== undefined) config.runtime.effort = parseReasoningEffort(options.effort);
    await writeConfig(config);
    print({
      ok: true,
      instance: options.instance,
      model: config.runtime.model,
      effort: config.runtime.effort,
      restartRequired: true,
    });
  });

program.command('doctor')
  .description('只读验证配置、DWS 状态和 Codex CLI command/resume 能力')
  .requiredOption('--instance <name>', 'instance 名称')
  .action(async (options) => {
    const config = await loadConfig(options.instance);
    const [dws, runtime] = await Promise.all([
      dwsDoctor(config),
      verifyCodexCommand(config),
    ]);
    const eventStatus = dws.eventStatus as Record<string, unknown>;
    const bus = eventStatus?.bus as Record<string, unknown> | undefined;
    const entry = bus?.entry as Record<string, unknown> | undefined;
    print({
      ok: true,
      configPath: configPath(options.instance),
      dwsVersion: dws.version,
      dwsBusState: entry?.state ?? 'unknown',
      dwsSubscriptions: Array.isArray(eventStatus?.subscriptions) ? eventStatus.subscriptions.length : 0,
      runtimeId: config.runtime.id,
      runtimeVersion: runtime.version,
      runtimeFingerprintPrefix: runtime.fingerprint.slice(0, 20),
      model: config.runtime.model,
      effort: config.runtime.effort,
      quietWindowMilliseconds: config.scheduling.quietWindowMilliseconds,
      maxBatchMessages: config.scheduling.maxBatchMessages,
    });
  });

const conversation = program.command('conversation').description('管理允许进入 Host 的群聊/私聊');
conversation.command('add')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--kind <kind>', 'group 或 direct')
  .requiredOption('--title <title>', '显示名称；group 时用于精确搜索')
  .option('--responsibility <text>', '该会话的职责边界；省略时使用 identity.role')
  .option('--mode <mode>', 'shadow 或 reply', 'shadow')
  .option('--warm-seconds <seconds>', '处理完成后保留 Worker 的秒数，默认 30；0 表示立即释放', parseWarmSeconds)
  .option('--open-dingtalk-id <id>', 'direct 对端的 openDingTalkId')
  .action(async (options) => {
    if (!['group', 'direct'].includes(options.kind)) throw new Error('--kind 必须是 group 或 direct');
    if (!['shadow', 'reply'].includes(options.mode)) throw new Error('--mode 必须是 shadow 或 reply');
    const config = await loadConfig(options.instance);
    const externalId = options.kind === 'group'
      ? (await resolveExactGroup(config, options.title)).openConversationId
      : options.openDingtalkId;
    if (!externalId) throw new Error('direct 会话必须提供 --open-dingtalk-id');
    const store = new Store(statePath(options.instance));
    try {
      const created = store.addConversation({
        kind: options.kind,
        externalId,
        title: options.title,
        responsibility: options.responsibility ?? config.identity.role,
        mode: options.mode,
        channelId: config.channel.id,
        channelProfileId: config.channel.profileId,
        runtimeId: config.runtime.id,
        workerWarmSeconds: options.warmSeconds,
      });
      print(publicConversation(created));
    } finally {
      store.close();
    }
  });

conversation.command('list')
  .requiredOption('--instance <name>', 'instance 名称')
  .action(async (options) => {
    await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    try {
      print({ conversations: store.listConversations().map(publicConversation) });
    } finally {
      store.close();
    }
  });

for (const enabled of [true, false]) {
  conversation.command(enabled ? 'enable' : 'disable')
    .requiredOption('--instance <name>', 'instance 名称')
    .requiredOption('--id <id>', 'conversation UUID')
    .action(async (options) => {
      await loadConfig(options.instance);
      const store = new Store(statePath(options.instance));
      try {
        if (!store.setConversationEnabled(options.id, enabled)) throw new Error(`conversation 不存在：${options.id}`);
        print({ ok: true, id: options.id, enabled });
      } finally {
        store.close();
      }
    });
}

conversation.command('mode')
  .description('显式切换 shadow/reply；运行中的 Host 需重启后生效')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--id <id>', 'conversation UUID')
  .requiredOption('--mode <mode>', 'shadow 或 reply')
  .action(async (options) => {
    if (!['shadow', 'reply'].includes(options.mode)) throw new Error('--mode 必须是 shadow 或 reply');
    await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    try {
      if (!store.setConversationMode(options.id, options.mode)) throw new Error(`conversation 不存在：${options.id}`);
      print({ ok: true, id: options.id, mode: options.mode, restartRequired: true });
    } finally {
      store.close();
    }
  });

conversation.command('worker')
  .description('设置按需 Worker 的 warm TTL；运行中的 Host 需重启后生效')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--id <id>', 'conversation UUID')
  .requiredOption('--warm-seconds <seconds>', '处理完成后保留 Worker 的秒数；0 表示立即释放', parseWarmSeconds)
  .action(async (options) => {
    await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    try {
      if (!store.setWorkerWarmSeconds(options.id, options.warmSeconds)) {
        throw new Error(`conversation 不存在：${options.id}`);
      }
      print({ ...publicConversation(store.getConversation(options.id)!), restartRequired: true });
    } finally {
      store.close();
    }
  });

program.command('status')
  .description('输出机器可读的脱敏状态快照')
  .requiredOption('--instance <name>', 'instance 名称')
  .option('--show-content', '在当前用户本地输出截断消息正文', false)
  .action(async (options) => {
    await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    try {
      print({ instance: options.instance, ...store.status(options.showContent) });
    } finally {
      store.close();
    }
  });

program.command('view')
  .description('启动或 attach Host，并打开总览、会话详情和设置管理界面')
  .requiredOption('--instance <name>', 'instance 名称')
  .option('--interval <seconds>', '刷新间隔秒数', parseViewInterval, 1)
  .option('--once', '只读渲染一次且不启动 Host；管道和脚本必须使用此模式', false)
  .option('--show-content', '在当前用户本地显示截断消息正文预览', false)
  .action(async (options) => {
    const config = await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    const viewOptions = {
      instance: options.instance,
      intervalSeconds: options.interval,
      once: options.once,
      showContent: options.showContent,
    };
    assertInteractiveView(viewOptions);
    let hostAbort: AbortController | null = null;
    let hostPromise: Promise<void> | null = null;
    let hostFailure: Error | null = null;
    const notices: string[] = [];
    try {
      const initialSnapshot = store.status();
      const startHost = shouldStartHostForView(options.once, initialSnapshot);
      const attached = !options.once && !startHost;
      if (startHost) {
        hostAbort = new AbortController();
        hostPromise = runHost(config, {
          signal: hostAbort.signal,
          handleProcessSignals: false,
          log: (record) => {
            notices.push(hostNotice(record));
            if (notices.length > 50) notices.shift();
          },
        }).catch((error) => {
          hostFailure = error as Error;
          notices.push(`Host 异常：${(error as Error).message}`);
        });
      }
      await runView(store, config, { ...viewOptions, attachedToExistingHost: attached, notices });
    } finally {
      hostAbort?.abort();
      await hostPromise;
      store.close();
    }
    if (hostFailure) throw hostFailure;
  });

program.command('run')
  .description('前台运行唯一 Channel owner 和事件驱动按需 runtime Worker')
  .requiredOption('--instance <name>', 'instance 名称')
  .action(async (options) => runHost(await loadConfig(options.instance)));

program.command('verify')
  .description('不连接 DWS、不发送消息；验证指定会话的 runtime CLI start/resume/结构化 silent turn')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--id <id>', 'conversation UUID')
  .action(async (options) => {
    const config = await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    let session: CodexCommandSession | null = null;
    try {
      const target = store.getConversation(options.id);
      if (!target) throw new Error(`conversation 不存在：${options.id}`);
      const runtime = await verifyCodexCommand(config);
      store.setRuntimeAdapter({
        runtimeId: config.runtime.id,
        label: 'Codex CLI',
        state: 'stopped',
        model: config.runtime.model,
        protocolFingerprint: runtime.fingerprint,
        contextRecovery: 'session-start-hook',
      });
      session = new CodexCommandSession(config, target, runtime, store);
      const startup = await session.start();
      const canary = await session.runDecision(`
[宿主离线验证事件；不是钉钉消息]
当前没有待处理消息，禁止发言。返回 action="silent"、responsibilityMatch=false、category="verify"、replyText=""、reasonCode="offline_canary"。
同时返回 workType="discussion"、delegation="not_required"。
返回 contextUpdate=null。
`.trim());
      if (canary.status !== 'completed' || canary.decision?.action !== 'silent' || canary.decision.replyText !== '') {
        throw new Error('离线 canary 未返回严格 silent 决策');
      }
      print({
        ok: true,
        conversationId: target.id,
        startupMode: startup.mode,
        providerSessionIdPrefix: session.currentSessionId?.slice(0, 12) ?? null,
        hostRunIdPrefix: canary.turnId.slice(0, 12),
        action: canary.decision.action,
        model: config.runtime.model,
        effort: config.runtime.effort,
      });
    } finally {
      await session?.stop().catch(() => undefined);
      store.close();
    }
  });

const service = program.command('service').description('管理 Windows 当前用户的常驻计划任务');
service.command('plan')
  .requiredOption('--instance <name>', 'instance 名称')
  .action((options) => print(windowsServicePlan(options.instance, process.argv[1]!)));
service.command('install')
  .requiredOption('--instance <name>', 'instance 名称')
  .action(async (options) => {
    await loadConfig(options.instance);
    const plan = await installUserService(options.instance, process.argv[1]!);
    print({ ok: true, taskName: plan.taskName, launcherPath: plan.launcherPath });
  });
service.command('remove')
  .requiredOption('--instance <name>', 'instance 名称')
  .option('--check', '只输出将删除的任务和 launcher，不改变状态', false)
  .action(async (options) => {
    const plan = await removeUserService(options.instance, options.check);
    print({ ok: true, check: options.check, taskName: plan.taskName, launcherPath: plan.launcherPath });
  });

program.parseAsync().catch((error: Error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function publicConversation(value: {
  id: string; channelId: string; channelProfileId: string; kind: string; externalId: string;
  title: string; responsibility: string; mode: string; runtimeId: string; workerWarmSeconds: number; enabled: boolean;
}): Record<string, unknown> {
  return {
    id: value.id,
    channelId: value.channelId,
    channelProfileId: value.channelProfileId,
    kind: value.kind,
    externalIdPrefix: value.externalId.slice(0, 12),
    title: value.title,
    responsibility: value.responsibility,
    mode: value.mode,
    runtimeId: value.runtimeId,
    workerWarmSeconds: value.workerWarmSeconds,
    enabled: value.enabled,
  };
}

function parseWarmSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_WORKER_WARM_SECONDS) {
    throw new Error(`秒数必须是 0-${MAX_WORKER_WARM_SECONDS} 的整数`);
  }
  return parsed;
}

function parseViewInterval(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 60) {
    throw new Error('--interval 必须是 0.1-60 秒');
  }
  return parsed;
}

function parseReasoningEffort(value: string): typeof CODEX_REASONING_EFFORTS[number] {
  if (!CODEX_REASONING_EFFORTS.includes(value as typeof CODEX_REASONING_EFFORTS[number])) {
    throw new Error(`--effort 必须是 ${CODEX_REASONING_EFFORTS.join('、')}`);
  }
  return value as typeof CODEX_REASONING_EFFORTS[number];
}

function hostNotice(record: Record<string, unknown>): string {
  const type = String(record.type ?? 'HOST_EVENT');
  const error = record.error ? `：${String(record.error)}` : '';
  return `${type}${error}`;
}
