import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lockRoot } from './paths.js';

interface LockBody {
  ownerId: string;
  pid: number;
  instance: string;
  createdAt: string;
}

export class OwnerLock {
  readonly ownerId = randomUUID();
  readonly path: string;
  private handle: FileHandle | null = null;

  constructor(instance: string, profile: string | undefined, env: NodeJS.ProcessEnv = process.env) {
    const key = createHash('sha256').update(profile ?? 'default-profile').digest('hex').slice(0, 24);
    this.path = join(lockRoot(env), `dws-${key}.lock`);
    this.instance = instance;
  }

  private readonly instance: string;

  async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.handle = await open(this.path, 'wx', 0o600);
        const body: LockBody = {
          ownerId: this.ownerId,
          pid: process.pid,
          instance: this.instance,
          createdAt: new Date().toISOString(),
        };
        await this.handle.writeFile(`${JSON.stringify(body)}\n`, 'utf8');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.readExisting();
        if (existing && isProcessAlive(existing.pid)) {
          throw new Error(`DWS profile 已由 instance=${existing.instance} pid=${existing.pid} 持有`);
        }
        await unlink(this.path).catch(() => undefined);
      }
    }
    throw new Error('无法取得 DWS owner lock');
  }

  private async readExisting(): Promise<LockBody | null> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as LockBody;
    } catch {
      return null;
    }
  }

  async release(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.handle = null;
    const existing = await this.readExisting();
    if (existing?.ownerId === this.ownerId) await unlink(this.path).catch(() => undefined);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
