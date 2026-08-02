import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DATA_HOME_ENV, LEGACY_DATA_HOME_ENV, PRODUCT_ID } from './product.js';

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env[DATA_HOME_ENV]) return resolve(env[DATA_HOME_ENV]);
  if (env[LEGACY_DATA_HOME_ENV]) {
    throw new Error(`${LEGACY_DATA_HOME_ENV} 已重命名为 ${DATA_HOME_ENV}；请显式迁移状态目录后更新环境变量`);
  }
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, PRODUCT_ID);
  }
  return join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), PRODUCT_ID);
}

export function instanceDir(instance: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(dataRoot(env), 'instances', safeName(instance));
}

export function lockRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, PRODUCT_ID, 'locks');
  }
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, PRODUCT_ID);
  return join(homedir(), '.local', 'state', PRODUCT_ID, 'locks');
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
