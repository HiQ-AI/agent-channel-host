import { randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import {
  defaultConfig, loadConfig, writeInitialConfig, type HostConfig,
} from './config.js';
import { configPath, instanceDir, statePath } from './paths.js';
import { Store } from './store.js';

export interface InitializeInstanceInput {
  instance: string;
  cwd: string;
  name: string;
  role: string;
  dwsCommand?: string;
  codexCommand?: string;
  model?: string;
  effort?: HostConfig['runtime']['effort'];
  dwsProfile?: string;
  channelEnabled?: boolean;
}

export interface InitializedInstance {
  config: HostConfig;
  configFile: string;
  stateFile: string;
}

export interface ManagedInstanceState {
  name: string;
  store: Store;
  hostOwnership: 'attached' | 'view' | 'readonly';
}

export async function initializeInstance(
  input: InitializeInstanceInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InitializedInstance> {
  const configFile = configPath(input.instance, env);
  try {
    await access(configFile);
    throw new Error(`配置已存在：${configFile}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const config = defaultConfig(input.instance, input.cwd, input.name, input.role);
  config.channel.enabled = input.channelEnabled ?? true;
  if (input.dwsCommand !== undefined) config.channel.command = input.dwsCommand;
  if (input.codexCommand !== undefined) config.runtime.command = input.codexCommand;
  if (input.model !== undefined) config.runtime.model = input.model;
  if (input.effort !== undefined) config.runtime.effort = input.effort;
  if (input.dwsProfile !== undefined) config.channel.profile = input.dwsProfile;
  await writeInitialConfig(config, configFile);

  const stateFile = statePath(input.instance, env);
  const store = new Store(stateFile);
  try {
    store.setChannelConnection({
      channelId: config.channel.id,
      profileId: config.channel.profileId,
      label: 'DingTalk DWS',
      state: config.channel.enabled ? 'stopped' : 'disabled',
      ownerPid: null,
    });
    store.setRuntimeAdapter({
      runtimeId: config.runtime.id,
      label: 'Codex CLI',
      state: 'stopped',
      model: config.runtime.model,
      contextRecovery: 'session-start-hook',
    });
  } finally {
    store.close();
  }
  return { config, configFile, stateFile };
}

export async function deleteInstanceData(
  instance: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configFile = configPath(instance, env);
  await loadConfig(instance, configFile);
  const directory = instanceDir(instance, env);
  await rm(directory, { recursive: true });
  return directory;
}

export async function deleteConversationWithLifecycle<T extends ManagedInstanceState>(
  instance: T,
  conversationId: string,
  stopHost: (instance: T) => Promise<void>,
  startHost: (instance: T) => void,
): Promise<void> {
  if (instance.hostOwnership === 'attached') {
    throw new Error(`Instance ${instance.name} 由外部 Host 持有；请先停止外部 Host 再删除 Conversation`);
  }
  const restart = instance.hostOwnership === 'view';
  if (restart) await stopHost(instance);
  const leaseOwner = acquireDeletionLease(instance);
  try {
    if (!instance.store.deleteConversation(conversationId)) throw new Error('Conversation 已不存在');
  } finally {
    instance.store.releaseLease('host', leaseOwner);
    if (restart) startHost(instance);
  }
}

export async function deleteInstanceWithLifecycle<T extends ManagedInstanceState>(
  instance: T,
  stopHost: (instance: T) => Promise<void>,
  removeService: (instance: string) => Promise<unknown>,
  removeData: (instance: string) => Promise<unknown> = deleteInstanceData,
): Promise<void> {
  if (instance.hostOwnership === 'attached') {
    throw new Error(`Instance ${instance.name} 由外部 Host 持有；请先停止外部 Host 再删除 Instance`);
  }
  if (instance.hostOwnership === 'view') await stopHost(instance);
  const leaseOwner = acquireDeletionLease(instance);
  try {
    await removeService(instance.name);
  } catch (error) {
    instance.store.releaseLease('host', leaseOwner);
    throw error;
  }
  instance.store.close();
  await removeData(instance.name);
}

function acquireDeletionLease(instance: ManagedInstanceState): string {
  const owner = `management-delete:${process.pid}:${randomUUID()}`;
  if (!instance.store.acquireLease('host', owner, Date.now(), 30_000)) {
    throw new Error(`Instance ${instance.name} 的 Host 已重新运行；拒绝删除并请刷新状态`);
  }
  return owner;
}
