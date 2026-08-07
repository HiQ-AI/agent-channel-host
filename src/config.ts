import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { configPath } from './paths.js';
import { CONVERSATION_MODES } from './types.js';

export const MINIMUM_NODE_VERSION = 'v22.13.0';
export const MINIMUM_DWS_VERSION = 'dws v1.0.55';
export const MINIMUM_CODEX_VERSION = 'codex-cli 0.145.0';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
export const DEFAULT_CODEX_EFFORT = 'low';
export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const CHANNEL_SUBSCRIPTION_MODES = ['none', 'selected', 'all'] as const;
export type ChannelSubscriptionMode = typeof CHANNEL_SUBSCRIPTION_MODES[number];

const configSchema = z.object({
  version: z.literal(2),
  instance: z.string().min(1),
  identity: z.object({
    name: z.string().min(1),
  }),
  channel: z.object({
    id: z.literal('dingtalk'),
    enabled: z.boolean().default(true),
    profileId: z.string().min(1).default('default'),
    command: z.string().min(1).default('dws'),
    profile: z.string().optional(),
    subscriptions: z.object({
      groups: z.enum(CHANNEL_SUBSCRIPTION_MODES).default('selected'),
      directs: z.enum(CHANNEL_SUBSCRIPTION_MODES).default('selected'),
    }).default({ groups: 'selected', directs: 'selected' }),
    defaultModes: z.object({
      groups: z.enum(CONVERSATION_MODES).default('shadow'),
      directs: z.enum(CONVERSATION_MODES).default('shadow'),
    }).default({ groups: 'shadow', directs: 'shadow' }),
    selfMessagePollSeconds: z.number().int().min(1).max(300).default(5),
  }),
  runtime: z.object({
    id: z.literal('codex'),
    command: z.string().min(1).default('codex'),
    version: z.string().min(1).default(MINIMUM_CODEX_VERSION),
    model: z.string().trim().min(1).default(DEFAULT_CODEX_MODEL),
    effort: z.enum(CODEX_REASONING_EFFORTS).default(DEFAULT_CODEX_EFFORT),
    cwd: z.string().min(1),
    startupTimeoutSeconds: z.number().int().positive().default(120),
  }),
  scheduling: z.object({
    quietWindowMilliseconds: z.number().int().min(0).max(60_000).default(300),
    maxBatchMessages: z.number().int().positive().max(200).default(20),
  }),
});

export type HostConfig = z.infer<typeof configSchema>;

export function validateConfig(value: unknown): HostConfig {
  return configSchema.parse(value);
}

export function defaultConfig(instance: string, cwd: string, name: string): HostConfig {
  return {
    version: 2,
    instance,
    identity: {
      name,
    },
    channel: {
      id: 'dingtalk',
      enabled: true,
      profileId: 'default',
      command: 'dws',
      subscriptions: {
        groups: 'selected',
        directs: 'selected',
      },
      defaultModes: {
        groups: 'shadow',
        directs: 'shadow',
      },
      selfMessagePollSeconds: 5,
    },
    runtime: {
      id: 'codex',
      command: 'codex',
      version: MINIMUM_CODEX_VERSION,
      model: DEFAULT_CODEX_MODEL,
      effort: DEFAULT_CODEX_EFFORT,
      cwd: resolve(cwd),
      startupTimeoutSeconds: 120,
    },
    scheduling: {
      quietWindowMilliseconds: 300,
      maxBatchMessages: 20,
    },
  };
}

export function configuredChannels(config: HostConfig): HostConfig['channel'][] {
  return [config.channel];
}

export async function writeInitialConfig(config: HostConfig, path = configPath(config.instance)): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, YAML.stringify(config), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

export async function writeConfig(config: HostConfig, path = configPath(config.instance)): Promise<void> {
  const validated = configSchema.parse(config);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, YAML.stringify(validated), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function loadConfig(instance: string, path = configPath(instance)): Promise<HostConfig> {
  const raw = await readFile(path, 'utf8');
  const parsed = YAML.parse(raw) as { version?: unknown } | null;
  if (parsed?.version === 1) {
    throw new Error('配置 version=1 属于 App Server 预览版；请按 README 显式迁移为 version=2，Host 不会静默创建第二套 session');
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`配置无效：${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  if (result.data.instance !== instance) {
    throw new Error(`配置 instance=${result.data.instance} 与请求的 ${instance} 不一致`);
  }
  return result.data;
}
