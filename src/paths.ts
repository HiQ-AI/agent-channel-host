import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DINGTALK_CODEX_HOME) return resolve(env.DINGTALK_CODEX_HOME);
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, 'dingtalk-codex-host');
  }
  return join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dingtalk-codex-host');
}

export function instanceDir(instance: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(dataRoot(env), 'instances', safeName(instance));
}

export function lockRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, 'dingtalk-codex-host', 'locks');
  }
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, 'dingtalk-codex-host');
  return join(homedir(), '.local', 'state', 'dingtalk-codex-host', 'locks');
}

export function configPath(instance: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(instanceDir(instance, env), 'config.yaml');
}

export function statePath(instance: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(instanceDir(instance, env), 'state.sqlite3');
}

export function safeName(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value)) {
    throw new Error('instance 只能包含字母、数字、点、下划线和连字符，长度不超过 64');
  }
  return value;
}
