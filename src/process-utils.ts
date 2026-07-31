import type { ChildProcess } from 'node:child_process';

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function stopChild(child: ChildProcess | null, timeoutMs = 5_000): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.stdin?.end();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await withTimeout(exited, timeoutMs, '子进程优雅退出');
  } catch {
    child.kill();
    await withTimeout(exited, timeoutMs, '子进程终止');
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
