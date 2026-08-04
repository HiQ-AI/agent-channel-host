import { execFile } from 'node:child_process';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { access } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ResolvedCommand {
  kind: 'native' | 'node-script';
  file: string;
  target: string;
}

const cache = new Map<string, Promise<ResolvedCommand>>();

export function resolveCommand(command: string): Promise<ResolvedCommand> {
  const existing = cache.get(command);
  if (existing) return existing;
  const pending = resolveCommandUncached(command);
  cache.set(command, pending);
  return pending;
}

async function resolveCommandUncached(command: string): Promise<ResolvedCommand> {
  if (process.platform !== 'win32') return { kind: 'native', file: command, target: command };
  const extension = extname(command).toLowerCase();
  const commandName = basename(command, extension).toLowerCase();
  if (commandName === 'codex' && extension !== '.exe') {
    const codexJs = await findCodexJs(command);
    if (codexJs) return { kind: 'node-script', file: process.execPath, target: codexJs };
  }
  if (['.ps1', '.cmd', '.bat'].includes(extension)) {
    throw new Error(`不支持通过 ${extension} shim 启动 JSONL 子进程；请提供原生 .exe（Codex npm launcher 会自动解析 codex.js）`);
  }
  if (extension === '.exe') {
    await access(command);
    return { kind: 'native', file: command, target: command };
  }

  const lookup = basename(command, extension || undefined);
  try {
    const found = await execFileAsync('where.exe', [lookup], { encoding: 'utf8', windowsHide: true });
    const candidates = found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lookup.toLowerCase() === 'codex') {
      for (const candidate of candidates) {
        const codexJs = await findCodexJs(candidate);
        if (codexJs) return { kind: 'node-script', file: process.execPath, target: codexJs };
      }
    }
    const executable = candidates.find((item) => extname(item).toLowerCase() === '.exe');
    if (executable) return { kind: 'native', file: executable, target: executable };
    if (candidates.length > 0) {
      throw new Error(`命令 ${command} 只解析到脚本 shim；请提供原生 .exe`);
    }
  } catch {
    // Fall through to the native command so the caller receives the operating system error.
  }
  return { kind: 'native', file: command, target: command };
}

export function commandArgs(command: ResolvedCommand, args: string[]): string[] {
  if (command.kind === 'native') return args;
  return [command.target, ...args];
}

async function findCodexJs(command: string): Promise<string | null> {
  const extension = extname(command).toLowerCase();
  const directories: string[] = [];
  if (extension && ['.ps1', '.cmd', '.bat'].includes(extension)) directories.push(dirname(command));
  if (!extension) {
    try {
      const found = await execFileAsync('where.exe', ['codex.cmd'], { encoding: 'utf8', windowsHide: true });
      directories.push(...found.stdout.split(/\r?\n/).filter(Boolean).map((item) => dirname(item.trim())));
    } catch {
      // Keep looking in explicitly supplied paths only.
    }
  }
  for (const directory of new Set(directories)) {
    const candidate = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next package-manager launcher directory.
    }
  }
  return null;
}

export function execResolved(
  command: ResolvedCommand,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command.file, commandArgs(command, args), options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    // PowerShell/npm shims can keep waiting while their inherited stdin pipe is open.
    child.stdin?.end();
  });
}
