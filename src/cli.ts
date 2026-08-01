#!/usr/bin/env node
import { Command } from 'commander';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultConfig, loadConfig, writeInitialConfig } from './config.js';
import { configPath, instanceDir, statePath } from './paths.js';
import { Store } from './store.js';
import { dwsDoctor, resolveExactGroup } from './dws.js';
import { verifyCodexProtocol } from './protocol.js';
import { runHost } from './host.js';
import { installUserService, removeUserService, windowsServicePlan } from './service.js';
import { AppServerSession } from './app-server.js';
import { MAX_IDLE_TIMEOUT_MINUTES } from './types.js';

const program = new Command();
program
  .name('dingtalk-codex')
  .description('将钉钉个人事件路由到每个会话独立的常驻 Codex App Server thread')
  .version('0.1.0');

program.command('init')
  .description('初始化一个不含凭据的用户级 Host instance')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--cwd <path>', 'Codex 会话工作目录')
  .option('--name <name>', '数字化员工名称', 'DingTalk Agent')
  .option('--role <role>', '默认角色定位', '在授权会话内提供职责范围内的分析和答复')
  .option('--dws-command <path>', 'DWS 命令或绝对路径', 'dws')
  .option('--codex-command <path>', 'Codex 命令或绝对路径', 'codex')
  .option('--dws-profile <profile>', '可选的 DWS corpId:userId profile')
  .action(async (options) => {
    const path = configPath(options.instance);
    await access(path).then(
      () => { throw new Error(`配置已存在：${path}`); },
      () => undefined,
    );
    const config = defaultConfig(options.instance, options.cwd, options.name, options.role);
    config.runtime.dwsCommand = options.dwsCommand;
    config.runtime.codexCommand = options.codexCommand;
    if (options.dwsProfile) config.runtime.dwsProfile = options.dwsProfile;
    await writeInitialConfig(config, path);
    const store = new Store(statePath(options.instance));
    store.close();
    print({ ok: true, instance: options.instance, configPath: path, statePath: statePath(options.instance) });
  });

program.command('doctor')
  .description('只读验证配置、DWS 状态和固定 Codex App Server 协议')
  .requiredOption('--instance <name>', 'instance 名称')
  .action(async (options) => {
    const config = await loadConfig(options.instance);
    const [dws, protocol] = await Promise.all([
      dwsDoctor(config),
      verifyCodexProtocol(config, join(instanceDir(options.instance), 'protocol')),
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
      codexVersion: protocol.codexVersion,
      protocolSchemaSha256: protocol.schemaSha256,
    });
  });

const conversation = program.command('conversation').description('管理允许进入 Host 的群聊/私聊');
conversation.command('add')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--kind <kind>', 'group 或 direct')
  .requiredOption('--title <title>', '显示名称；group 时用于精确搜索')
  .option('--responsibility <text>', '该会话的职责边界；省略时使用 identity.role')
  .option('--mode <mode>', 'shadow 或 reply', 'shadow')
  .option('--lifecycle <lifecycle>', 'resident 或 idle；默认 group=resident、direct=idle')
  .option('--idle-minutes <minutes>', 'idle 模式空闲释放分钟数，默认 5', parsePositiveInteger)
  .option('--open-dingtalk-id <id>', 'direct 对端的 openDingTalkId')
  .action(async (options) => {
    if (!['group', 'direct'].includes(options.kind)) throw new Error('--kind 必须是 group 或 direct');
    if (!['shadow', 'reply'].includes(options.mode)) throw new Error('--mode 必须是 shadow 或 reply');
    if (options.lifecycle !== undefined && !['resident', 'idle'].includes(options.lifecycle)) {
      throw new Error('--lifecycle 必须是 resident 或 idle');
    }
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
        sessionLifecycle: options.lifecycle,
        idleTimeoutMinutes: options.idleMinutes,
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

conversation.command('lifecycle')
  .description('设置 resident/idle 生命周期；运行中的 Host 需重启后生效')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--id <id>', 'conversation UUID')
  .requiredOption('--lifecycle <lifecycle>', 'resident 或 idle')
  .option('--idle-minutes <minutes>', 'idle 模式空闲释放分钟数；省略时保留当前值', parsePositiveInteger)
  .action(async (options) => {
    if (!['resident', 'idle'].includes(options.lifecycle)) {
      throw new Error('--lifecycle 必须是 resident 或 idle');
    }
    await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    try {
      if (!store.setConversationLifecycle(options.id, options.lifecycle, options.idleMinutes)) {
        throw new Error(`conversation 不存在：${options.id}`);
      }
      print({ ...publicConversation(store.getConversation(options.id)!), restartRequired: true });
    } finally {
      store.close();
    }
  });

program.command('status')
  .description('查看脱敏后的本地持久化状态')
  .requiredOption('--instance <name>', 'instance 名称')
  .action(async (options) => {
    await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    try {
      print({ instance: options.instance, ...store.status() });
    } finally {
      store.close();
    }
  });

program.command('run')
  .description('前台运行唯一 DWS owner 和每会话独立生命周期的 Codex session')
  .requiredOption('--instance <name>', 'instance 名称')
  .action(async (options) => runHost(await loadConfig(options.instance)));

program.command('verify')
  .description('不连接 DWS、不发送消息；验证指定会话的 thread start/resume/bootstrap/结构化 silent turn')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--id <id>', 'conversation UUID')
  .action(async (options) => {
    const config = await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    let session: AppServerSession | null = null;
    try {
      const target = store.getConversation(options.id);
      if (!target) throw new Error(`conversation 不存在：${options.id}`);
      const protocol = await verifyCodexProtocol(config, join(instanceDir(options.instance), 'protocol'));
      session = new AppServerSession(config, target, protocol, store);
      const startup = await session.start();
      const canary = await session.runDecision(`
[宿主离线验证事件；不是钉钉消息]
当前没有待处理消息，禁止发言。返回 action="silent"、responsibilityMatch=false、category="verify"、replyText=""、reasonCode="offline_canary"。
同时返回 workType="discussion"、delegation="not_required"。
`.trim());
      if (canary.status !== 'completed' || canary.decision?.action !== 'silent' || canary.decision.replyText !== '') {
        throw new Error('离线 canary 未返回严格 silent 决策');
      }
      print({
        ok: true,
        conversationId: target.id,
        startupMode: startup.mode,
        threadIdPrefix: startup.threadId.slice(0, 12),
        bootstrapPerformed: startup.bootstrapPerformed,
        canaryTurnIdPrefix: canary.turnId.slice(0, 12),
        action: canary.decision.action,
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
  id: string; kind: string; externalId: string; title: string; responsibility: string; mode: string;
  sessionLifecycle: string; idleTimeoutMinutes: number; enabled: boolean;
}): Record<string, unknown> {
  return {
    id: value.id,
    kind: value.kind,
    externalIdPrefix: value.externalId.slice(0, 12),
    title: value.title,
    responsibility: value.responsibility,
    mode: value.mode,
    sessionLifecycle: value.sessionLifecycle,
    idleTimeoutMinutes: value.idleTimeoutMinutes,
    enabled: value.enabled,
  };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_IDLE_TIMEOUT_MINUTES) {
    throw new Error(`分钟数必须是 1-${MAX_IDLE_TIMEOUT_MINUTES} 的正整数`);
  }
  return parsed;
}
