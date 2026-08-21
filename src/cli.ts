#!/usr/bin/env node
import { Command } from 'commander';
import {
  CODEX_REASONING_EFFORTS, loadConfig, writeConfig,
} from './config.js';
import { configPath, discoverInstances, statePath } from './paths.js';
import { Store } from './store.js';
import { dwsDoctor, listRecentDwsDirectCandidates, resolveExactGroup, searchDwsGroups } from './dws.js';
import { verifyCodexAppServer } from './codex-app-server.js';
import { CodexRuntimeAdapter } from './codex-runtime.js';
import type { AgentSession } from './contracts.js';
import { runHost, type HostControl } from './host.js';
import {
  installUserService, removeUserService, removeUserServiceIfInstalled, windowsServicePlan,
} from './service.js';
import { MAX_RESPONSIBILITY_REMINDER_INTERVAL, MAX_WORKER_WARM_SECONDS } from './types.js';
import { updateGlobalPackage } from './update.js';
import {
  assertInteractiveView, bindHostToInteractiveView, runView, type SettingEntry, type ViewInstance,
} from './view.js';
import { CLI_NAME, PRODUCT_VERSION } from './product.js';
import {
  deleteConversationWithLifecycle, deleteInstanceWithLifecycle, initializeInstance, stopExternalHost,
} from './instance.js';

const program = new Command();
program
  .name(CLI_NAME)
  .description('将 Channel 消息路由到每个会话独立、可恢复的 Agent runtime session')
  .version(PRODUCT_VERSION);

program.command('update')
  .description('通过 npm 将 agent-channel-host 更新到 registry 最新版本')
  .action(async () => {
    print(await updateGlobalPackage());
  });

program.command('init')
  .description('初始化一个不含凭据的用户级 Host instance')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--cwd <path>', 'Codex 会话工作目录')
  .option('--name <name>', '数字化员工名称', 'DingTalk Agent')
  .option('--dws-command <path>', 'DWS 命令或绝对路径', 'dws')
  .option('--codex-command <path>', 'Codex 命令或绝对路径', 'codex')
  .option('--model <model>', '默认 Codex 模型', 'gpt-5.6-sol')
  .option('--effort <effort>', '默认推理强度', 'low')
  .option('--dws-profile <profile>', '可选的 DWS corpId:userId profile')
  .action(async (options) => {
    const initialized = await initializeInstance({
      instance: options.instance,
      cwd: options.cwd,
      name: options.name,
      dwsCommand: options.dwsCommand,
      codexCommand: options.codexCommand,
      model: options.model,
      effort: parseReasoningEffort(options.effort),
      dwsProfile: options.dwsProfile,
    });
    print({
      ok: true,
      instance: options.instance,
      configPath: initialized.configFile,
      statePath: initialized.stateFile,
    });
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
  .description('只读验证配置、DWS 状态和 Codex App Server steer 能力')
  .requiredOption('--instance <name>', 'instance 名称')
  .action(async (options) => {
    const config = await loadConfig(options.instance);
    const [dws, runtime] = await Promise.all([
      config.channel.enabled
        ? dwsDoctor(config)
        : Promise.resolve({ version: 'disabled', eventStatus: { bus: { entry: { state: 'disabled' } }, subscriptions: [] } }),
      verifyCodexAppServer(config),
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
  .option('--responsibility <text>', '该会话的职责边界；省略时沿用 Agent 自身职责')
  .option('--mode <mode>', 'shadow 或 reply；省略时使用对应 Channel 默认模式')
  .option('--warm-seconds <seconds>', '处理完成后保留 Worker 的秒数，默认 300；0 表示立即释放', parseWarmSeconds)
  .option('--reminder-interval <turns>', '职责周期提醒间隔，默认 15；0 表示关闭', parseReminderInterval)
  .option('--open-dingtalk-id <id>', 'direct 对端的 openDingTalkId')
  .action(async (options) => {
    if (!['group', 'direct'].includes(options.kind)) throw new Error('--kind 必须是 group 或 direct');
    const config = await loadConfig(options.instance);
    const mode = options.mode ?? (options.kind === 'group'
      ? config.channel.defaultModes.groups
      : config.channel.defaultModes.directs);
    if (!['shadow', 'reply'].includes(mode)) throw new Error('--mode 必须是 shadow 或 reply');
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
        responsibility: options.responsibility ?? '',
        mode,
        channelId: config.channel.id,
        channelProfileId: config.channel.profileId,
        runtimeId: config.runtime.id,
        workerWarmSeconds: options.warmSeconds,
        responsibilityReminderInterval: options.reminderInterval,
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

conversation.command('continue-task')
  .description('把中断任务可靠投递到父会话的下一个 turn')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--provider-session-id <id>', '完整 provider session ID')
  .requiredOption('--text <text>', '发送给 Agent 的文本')
  .requiredOption('--continuation-id <id>', '调用方稳定 continuation ID')
  .option('--conversation-id <id>', '预期 conversation UUID；提供时会严格校验')
  .option('--delivery <mode>', '固定为 next-turn', 'next-turn')
  .action(async (options) => {
    const config = await loadConfig(options.instance);
    const text = String(options.text).trim();
    const continuationId = String(options.continuationId).trim();
    if (!text) throw new Error('--text 不能为空');
    if (!continuationId) throw new Error('--continuation-id 不能为空');
    if (options.delivery !== 'next-turn') throw new Error('--delivery 只支持 next-turn');
    const store = new Store(statePath(options.instance));
    try {
      const admitted = store.admitTaskContinuation({
        conversationId: options.conversationId,
        expectedParentThreadId: String(options.providerSessionId),
        continuationId,
        text,
      });
      print({
        ok: true, admitted: admitted.admitted, conversationId: admitted.conversation.id,
        providerSessionId: String(options.providerSessionId), eventId: admitted.eventId,
        sequence: admitted.sequence, processingState: admitted.processingState, delivery: 'next-turn',
      });
    } finally {
      store.close();
    }
  });

conversation.command('intervention-state')
  .description('读取当前 Codex thread、活动 turn 与可介入状态')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--id <id>', 'conversation UUID')
  .action(async (options) => {
    await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    try {
      const target = store.getConversation(options.id);
      if (!target) throw new Error(`conversation 不存在：${options.id}`);
      const state = store.getInterventionTarget(target.id);
      const session = store.getSession(target.id);
      const threadId = state?.threadId ?? session?.providerSessionId ?? null;
      const turnId = state?.turnId ?? null;
      const hostRunning = store.status().hostState === 'running';
      const canSteer = Boolean(hostRunning && state?.canIntervene);
      const canStartTurn = Boolean(hostRunning && target.enabled && threadId && !turnId);
      const canSend = canSteer || canStartTurn;
      print({
        conversationId: target.id,
        threadId,
        turnId,
        canIntervene: canSteer,
        canSteer,
        canStartTurn,
        canSend,
        reasonCode: canSend ? null
          : !target.enabled ? 'conversation_disabled'
            : !hostRunning ? 'host_unavailable'
            : !threadId ? 'thread_unavailable'
              : 'runtime_unsupported',
        workerId: state?.workerId ?? null,
        updatedAt: state?.updatedAt ?? session?.updatedAt ?? null,
      });
    } finally {
      store.close();
    }
  });

conversation.command('message')
  .alias('intervene')
  .description('向 Conversation 提交幂等人工消息；忙时 steer，空闲时创建 turn')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--id <id>', 'conversation UUID')
  .requiredOption('--request-id <id>', '调用方稳定且唯一的请求 ID')
  .requiredOption('--expected-thread-id <id>', '提交前读取到的完整 threadId')
  .option('--expected-turn-id <id>', '活动状态提交前读取到的完整 turnId')
  .requiredOption('--text <text>', '介入内容')
  .option('--ttl-seconds <seconds>', '领取前有效秒数，默认 60', parseInterventionTtl, 60)
  .action(async (options) => {
    await loadConfig(options.instance);
    const requestId = requiredInterventionValue(options.requestId, '--request-id', 128);
    const expectedThreadId = requiredInterventionValue(options.expectedThreadId, '--expected-thread-id', 256);
    const expectedTurnId = options.expectedTurnId
      ? requiredInterventionValue(options.expectedTurnId, '--expected-turn-id', 256)
      : null;
    const instruction = requiredInterventionValue(options.text, '--text', 10_000);
    const store = new Store(statePath(options.instance));
    try {
      const submitted = store.submitIntervention({
        requestId,
        conversationId: String(options.id),
        expectedThreadId,
        expectedTurnId,
        instruction,
        expiresAt: new Date(Date.now() + Number(options.ttlSeconds) * 1_000),
      });
      print({ ok: true, created: submitted.created, ...publicIntervention(submitted.intervention) });
    } finally {
      store.close();
    }
  });

conversation.command('intervention-result')
  .description('按 requestId 查询人工介入的领取与执行结果')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--request-id <id>', '调用方提交时使用的 request ID')
  .action(async (options) => {
    await loadConfig(options.instance);
    const requestId = requiredInterventionValue(options.requestId, '--request-id', 128);
    const store = new Store(statePath(options.instance));
    try {
      const result = store.getIntervention(requestId);
      if (!result) throw new Error(`介入指令不存在：${requestId}`);
      print(publicIntervention(result));
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

conversation.command('reminder')
  .description('设置职责周期提醒间隔；0 关闭，1-99 表示每 N 个已完成 turn 提醒')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--id <id>', 'conversation UUID')
  .requiredOption('--interval <turns>', '0-99 的整数', parseReminderInterval)
  .action(async (options) => {
    await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    try {
      if (!store.setResponsibilityReminderInterval(options.id, options.interval)) {
        throw new Error(`conversation 不存在：${options.id}`);
      }
      print(publicConversation(store.getConversation(options.id)!));
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
  .description('启动或 attach 全部 instance Host，并打开总览下钻管理与独立全局设置界面')
  .option('--interval <seconds>', '刷新间隔秒数', parseViewInterval, 1)
  .option('--once', '只读渲染一次且不启动 Host；管道和脚本必须使用此模式', false)
  .option('--show-content', '在当前用户本地显示截断消息正文预览', false)
  .action(async (options) => {
    const viewOptions = {
      intervalSeconds: options.interval,
      once: options.once,
      showContent: options.showContent,
    };
    assertInteractiveView(viewOptions);
    const instanceNames = await discoverInstances();
    const instances: ViewInstance[] = [];
    try {
      for (const name of instanceNames) {
        instances.push({
          name,
          config: await loadConfig(name),
          configFile: configPath(name),
          store: new Store(statePath(name)),
          hostOwnership: 'readonly',
          notices: [],
        });
      }
    } catch (error) {
      for (const instance of instances) instance.store.close();
      throw error;
    }
    const startedHosts = new Map<string, { instance: ViewInstance; abort: AbortController; promise: Promise<void>; control: HostControl | null }>();
    const hostFailures: Array<{ instance: string; error: Error }> = [];
    const startManagedHost = (instance: ViewInstance) => {
      const abort = new AbortController();
      const managed = { instance, abort, promise: null as unknown as Promise<void>, control: null as HostControl | null };
      const promise = runHost(instance.config, {
        signal: abort.signal,
        handleProcessSignals: false,
        log: (record) => {
          instance.notices.push(hostNotice(record));
          if (instance.notices.length > 50) instance.notices.shift();
        },
        onControlReady: (control) => { managed.control = control; },
      }).catch((error) => {
        if (!abort.signal.aborted) {
          hostFailures.push({ instance: instance.name, error: error as Error });
          instance.notices.push(`Host 异常：${(error as Error).message}`);
        }
      }).finally(() => {
        if (startedHosts.get(instance.name)?.promise === promise) startedHosts.delete(instance.name);
      });
      instance.hostOwnership = 'view';
      managed.promise = promise;
      startedHosts.set(instance.name, managed);
    };
    const stopManagedHost = async (instance: ViewInstance) => {
      const current = startedHosts.get(instance.name);
      if (!current) return;
      current.abort.abort();
      await current.promise;
    };
    const restartManagedHost = async (instance: ViewInstance, entry: SettingEntry): Promise<string> => {
      if (!entry.restartHost) return `${entry.label} 已保存`;
      if (instance.hostOwnership !== 'view') {
        return `${entry.label} 已保存；当前是 ${instance.hostOwnership} Host，请重启外部 Host 后生效`;
      }
      await stopManagedHost(instance);
      startManagedHost(instance);
      return `${entry.label} 已保存；Instance Host 已按新配置重启`;
    };
    const refreshManagedHost = async (instance: ViewInstance, reason: string): Promise<string> => {
      if (instance.hostOwnership !== 'view') {
        return `${reason}；当前是 ${instance.hostOwnership} Host，请重启外部 Host 以补拉消息`;
      }
      await stopManagedHost(instance);
      startManagedHost(instance);
      return `${reason}；Instance Host 已重启并开始补拉消息`;
    };
    try {
      for (const instance of instances) {
        await bindHostToInteractiveView(options.once, instance, stopExternalHost, startManagedHost);
      }
      await runView(instances, viewOptions, {
        createInstance: async (input) => {
          const initialized = await initializeInstance({ ...input, channelEnabled: false });
          return {
            name: initialized.config.instance,
            config: initialized.config,
            configFile: initialized.configFile,
            store: new Store(initialized.stateFile),
            hostOwnership: 'readonly',
            notices: [],
          };
        },
        startInstance: async (instance) => {
          if (!options.once) startManagedHost(instance);
        },
        afterSettingApplied: restartManagedHost,
        afterConversationAdded: async (instance, conversation) => (
          refreshManagedHost(instance, `${conversation.kind === 'group' ? '已绑定群组' : '已添加私聊'}“${conversation.title}”`)
        ),
        searchGroups: async (instance, query) => (await searchDwsGroups(instance.config, query))
          .map((group) => ({ title: group.title, externalId: group.openConversationId })),
        listRecentDirects: async (instance) => (await listRecentDwsDirectCandidates(instance.config))
          .map((direct) => ({ title: direct.title, externalId: direct.openDingTalkId })),
        deleteConversation: async (instance, conversationId) => {
          await deleteConversationWithLifecycle(instance, conversationId, stopManagedHost, startManagedHost);
        },
        sendToAgent: async (instance, conversationId, text) => {
          const host = startedHosts.get(instance.name);
          if (!host) throw new Error('当前 Instance Host 未运行');
          if (!host.control) throw new Error('当前 Instance Host 正在启动，请稍后重试');
          host.control.submitConversationInput(conversationId, text);
        },
        deleteInstance: async (instance) => {
          await deleteInstanceWithLifecycle(instance, stopManagedHost, removeUserServiceIfInstalled);
        },
      });
    } finally {
      const activeHosts = [...startedHosts.values()];
      for (const host of activeHosts) host.abort.abort();
      await Promise.all(activeHosts.map((host) => host.promise));
      for (const instance of instances) instance.store.close();
    }
    if (hostFailures.length > 0) {
      throw new Error(hostFailures.map(({ instance, error }) => `${instance}: ${error.message}`).join('; '));
    }
  });

program.command('run')
  .description('前台运行唯一 Channel owner 和事件驱动按需 runtime Worker')
  .requiredOption('--instance <name>', 'instance 名称')
  .action(async (options) => runHost(await loadConfig(options.instance)));

program.command('verify')
  .description('不连接 DWS、不发送消息；验证指定会话的 App Server start/resume 与完成回执')
  .requiredOption('--instance <name>', 'instance 名称')
  .requiredOption('--id <id>', 'conversation UUID')
  .action(async (options) => {
    const config = await loadConfig(options.instance);
    const store = new Store(statePath(options.instance));
    let session: AgentSession | null = null;
    let runtime: CodexRuntimeAdapter | null = null;
    try {
      const target = store.getConversation(options.id);
      if (!target) throw new Error(`conversation 不存在：${options.id}`);
      runtime = await CodexRuntimeAdapter.create(config, store);
      const startupMode = store.getSession(target.id) ? 'resumed' : 'new';
      store.setRuntimeAdapter({
        runtimeId: config.runtime.id,
        label: 'Codex App Server',
        state: 'stopped',
        model: config.runtime.model,
        protocolFingerprint: runtime.descriptor.protocolFingerprint,
        contextRecovery: 'runtime-native',
        endpoint: runtime.descriptor.endpoint,
        instanceId: runtime.descriptor.instanceId,
        processId: runtime.descriptor.processId,
      });
      session = runtime.createSession(target);
      await session.start();
      const canary = await session.deliver(`
[宿主离线验证事件；不是钉钉消息]
当前没有待处理消息。请确认 runtime session 能正常接收本事件。
`.trim());
      if (canary.status !== 'completed') throw new Error('离线 canary 未成功传入 runtime');
      print({
        ok: true,
        conversationId: target.id,
        startupMode,
        providerSessionIdPrefix: session.currentSessionId?.slice(0, 12) ?? null,
        hostRunIdPrefix: canary.turnId.slice(0, 12),
        delivery: 'forwarded',
        model: config.runtime.model,
        effort: config.runtime.effort,
        appServerEndpoint: runtime.descriptor.endpoint,
        appServerInstanceId: runtime.descriptor.instanceId,
      });
    } finally {
      await session?.stop().catch(() => undefined);
      await runtime?.stop().catch(() => undefined);
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
  title: string; responsibility: string; mode: string; runtimeId: string; workerWarmSeconds: number;
  responsibilityReminderInterval: number; enabled: boolean;
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
    responsibilityReminderInterval: value.responsibilityReminderInterval,
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

function parseReminderInterval(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_RESPONSIBILITY_REMINDER_INTERVAL) {
    throw new Error(`提醒间隔必须是 0-${MAX_RESPONSIBILITY_REMINDER_INTERVAL} 的整数`);
  }
  return parsed;
}

function parseInterventionTtl(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3_600) {
    throw new Error('--ttl-seconds 必须是 1-3600 的整数');
  }
  return parsed;
}

function requiredInterventionValue(value: unknown, option: string, maxLength: number): string {
  const parsed = String(value ?? '').trim();
  if (!parsed) throw new Error(`${option} 不能为空`);
  if (parsed.length > maxLength) throw new Error(`${option} 最长 ${maxLength} 个字符`);
  return parsed;
}

function publicIntervention(value: import('./types.js').RuntimeIntervention): Record<string, unknown> {
  return {
    requestId: value.requestId,
    conversationId: value.conversationId,
    expectedThreadId: value.expectedThreadId,
    expectedTurnId: value.expectedTurnId,
    state: value.state,
    expiresAt: value.expiresAt,
    resultCode: value.resultCode,
    resultMessage: value.resultMessage,
    actualThreadId: value.actualThreadId,
    actualTurnId: value.actualTurnId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
  };
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
