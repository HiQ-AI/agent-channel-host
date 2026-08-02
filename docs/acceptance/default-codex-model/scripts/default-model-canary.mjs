import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(process.argv[2] ?? '.default-model-canary');
const cli = join(process.cwd(), 'dist', 'src', 'cli.js');
const env = { ...process.env, AGENT_CHANNEL_HOME: root };

await rm(root, { recursive: true, force: true });
try {
  await run(['init', '--instance', 'canary', '--cwd', process.cwd()]);
  const added = await run([
    'conversation', 'add', '--instance', 'canary', '--kind', 'direct', '--title', 'model-canary',
    '--open-dingtalk-id', 'model-canary-user',
  ]);
  const first = await run(['verify', '--instance', 'canary', '--id', added.id]);
  const second = await run(['verify', '--instance', 'canary', '--id', added.id]);
  if (first.model !== 'gpt-5.6-sol' || first.effort !== 'low') throw new Error('默认模型配置不正确');
  if (first.startupMode !== 'started' || second.startupMode !== 'resumed') throw new Error('未完成 start/resume');
  if (first.threadIdPrefix !== second.threadIdPrefix) throw new Error('resume 未保持原 thread');
  process.stdout.write(`${JSON.stringify({ ok: true, model: first.model, effort: first.effort, first, second }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function run(args) {
  const result = await execFileAsync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 240_000 });
  return JSON.parse(result.stdout);
}
