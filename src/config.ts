import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { configPath } from './paths.js';

export const CURRENT_CODEX_VERSION = 'codex-cli 0.145.0';
export const CURRENT_SCHEMA_SHA256 = '1f66700d1cc3de4a5004e5614a6098878b405c7e7c5f8c9be97fc900d0ad6c68';

const configSchema = z.object({
  version: z.literal(1),
  instance: z.string().min(1),
  identity: z.object({
    name: z.string().min(1),
    role: z.string().min(1),
    signature: z.string().min(1),
  }),
  runtime: z.object({
    cwd: z.string().min(1),
    dwsCommand: z.string().min(1).default('dws'),
    codexCommand: z.string().min(1).default('codex'),
    dwsProfile: z.string().optional(),
    startupTimeoutSeconds: z.number().int().positive().default(120),
    turnTimeoutSeconds: z.number().int().positive().default(180),
  }),
  protocol: z.object({
    codexVersion: z.string().min(1),
    schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

export type HostConfig = z.infer<typeof configSchema>;

export function defaultConfig(instance: string, cwd: string, name: string, role: string): HostConfig {
  return {
    version: 1,
    instance,
    identity: {
      name,
      role,
      signature: `- ${name}代回`,
    },
    runtime: {
      cwd: resolve(cwd),
      dwsCommand: 'dws',
      codexCommand: 'codex',
      startupTimeoutSeconds: 120,
      turnTimeoutSeconds: 180,
    },
    protocol: {
      codexVersion: CURRENT_CODEX_VERSION,
      schemaSha256: CURRENT_SCHEMA_SHA256,
    },
  };
}

export async function writeInitialConfig(config: HostConfig, path = configPath(config.instance)): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, YAML.stringify(config), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

export async function loadConfig(instance: string, path = configPath(instance)): Promise<HostConfig> {
  const raw = await readFile(path, 'utf8');
  const result = configSchema.safeParse(YAML.parse(raw));
  if (!result.success) {
    throw new Error(`配置无效：${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  if (result.data.instance !== instance) {
    throw new Error(`配置 instance=${result.data.instance} 与请求的 ${instance} 不一致`);
  }
  return result.data;
}
