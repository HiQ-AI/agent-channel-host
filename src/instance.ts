import { access } from 'node:fs/promises';
import {
  defaultConfig, writeInitialConfig, type HostConfig,
} from './config.js';
import { configPath, statePath } from './paths.js';
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
