import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { configPath } from './paths.js';

export const CURRENT_CODEX_VERSION = 'codex-cli 0.145.0';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
export const DEFAULT_CODEX_EFFORT = 'low';
export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

const configSchema = z.object({
  version: z.literal(2),
  instance: z.string().min(1),
  identity: z.object({
    name: z.string().min(1),
    role: z.string().min(1),
    signature: z.string().min(1),
  }),
  channel: z.object({
    id: z.literal('dingtalk'),
    profileId: z.string().min(1).default('default'),
    command: z.string().min(1).default('dws'),
    profile: z.string().optional(),
  }),
  runtime: z.object({
    id: z.literal('codex'),
    command: z.string().min(1).default('codex'),
    version: z.string().min(1).default(CURRENT_CODEX_VERSION),
    model: z.string().trim().min(1).default(DEFAULT_CODEX_MODEL),
    effort: z.enum(CODEX_REASONING_EFFORTS).default(DEFAULT_CODEX_EFFORT),
    cwd: z.string().min(1),
    startupTimeoutSeconds: z.number().int().positive().default(120),
    turnTimeoutSeconds: z.number().int().positive().default(180),
  }),
  scheduling: z.object({
    quietWindowMilliseconds: z.number().int().min(0).max(60_000).default(300),
    maxBatchMessages: z.number().int().positive().max(200).default(20),
  }),
});

export type HostConfig = z.infer<typeof configSchema>;

export function defaultConfig(instance: string, cwd: string, name: string, role: string): HostConfig {
  return {
    version: 2,
    instance,
    identity: {
      name,
      role,
      signature: `- ${name}代回`,
    },
    channel: {
      id: 'dingtalk',
      profileId: 'default',
      command: 'dws',
    },
    runtime: {
      id: 'codex',
      command: 'codex',
      version: CURRENT_CODEX_VERSION,
      model: DEFAULT_CODEX_MODEL,
      effort: DEFAULT_CODEX_EFFORT,
      cwd: resolve(cwd),
      startupTimeoutSeconds: 120,
      turnTimeoutSeconds: 180,
    },
    scheduling: {
      quietWindowMilliseconds: 300,
      maxBatchMessages: 20,
    },
  };
}

export async function writeInitialConfig(config: HostConfig, path = configPath(config.instance)): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, YAML.stringify(config), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

export async function writeConfig(config: HostConfig, path = configPath(config.instance)): Promise<void> {
  const validated = configSchema.parse(config);
  await writeFile(path, YAML.stringify(validated), { encoding: 'utf8', mode: 0o600 });
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
