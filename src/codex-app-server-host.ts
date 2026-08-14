import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import type { HostConfig } from './config.js';
import { commandArgs } from './command.js';
import { delay, stopChild, withTimeout } from './process-utils.js';
import type { CodexAppServerIdentity } from './codex-app-server.js';

export class CodexAppServerHost {
  readonly instanceId = randomUUID();
  readonly endpoint: string;
  private child: ChildProcess | null = null;
  private stopping = false;
  private stderrTail: string[] = [];
  private connections = new Set<WebSocket>();
  private terminalError: Error | null = null;

  private constructor(
    private readonly config: HostConfig,
    private readonly identity: CodexAppServerIdentity,
    port: number,
  ) {
    this.endpoint = `ws://127.0.0.1:${port}`;
  }

  static async start(config: HostConfig, identity: CodexAppServerIdentity): Promise<CodexAppServerHost> {
    const port = await reserveLoopbackPort();
    const host = new CodexAppServerHost(config, identity, port);
    await host.start();
    return host;
  }

  get processId(): number | null { return this.child?.pid ?? null; }
  get error(): Error | null { return this.terminalError; }
  get errorTail(): string { return this.stderrTail.join(' | '); }

  async connect(
    onMessage: (message: string) => void,
    onClose: (error: Error) => void,
  ): Promise<WebSocket> {
    if (this.terminalError) throw this.terminalError;
    const socket = new WebSocket(this.endpoint);
    await withTimeout(new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    }), this.config.runtime.startupTimeoutSeconds * 1_000, 'Codex App Server WebSocket 连接');
    this.connections.add(socket);
    socket.on('message', (data) => onMessage(data.toString()));
    socket.once('close', () => {
      this.connections.delete(socket);
      if (!this.stopping) onClose(this.terminalError ?? new Error('Codex App Server WebSocket 已断开'));
    });
    socket.on('error', (error) => {
      if (!this.stopping) onClose(error);
    });
    return socket;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const socket of this.connections) socket.close();
    this.connections.clear();
    this.child?.kill();
    await stopChild(this.child, 1_000);
    this.child = null;
  }

  private async start(): Promise<void> {
    const child = spawn(
      this.identity.command.file,
      commandArgs(this.identity.command, ['app-server', '--listen', this.endpoint]),
      { cwd: this.config.runtime.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env },
    );
    this.child = child;
    child.stdout?.resume();
    child.stderr?.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 30) this.stderrTail.shift();
      }
    });
    child.once('error', (error) => this.fail(error));
    child.once('exit', (code, signal) => {
      if (!this.stopping) this.fail(new Error(`共享 Codex App Server 意外退出：code=${code} signal=${signal}`));
    });
    await this.waitUntilReady();
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.config.runtime.startupTimeoutSeconds * 1_000;
    const readyz = `${this.endpoint.replace(/^ws:/, 'http:')}/readyz`;
    while (Date.now() < deadline) {
      if (this.terminalError) throw this.terminalError;
      try {
        const response = await fetch(readyz);
        if (response.ok) return;
      } catch {
        // The listener may not be bound yet.
      }
      await delay(50);
    }
    throw new Error(`Codex App Server readyz 超时；stderr tail: ${this.errorTail}`);
  }

  private fail(error: Error): void {
    this.terminalError ??= error;
    for (const socket of this.connections) socket.close();
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('无法分配 Codex App Server 回环端口');
  return port;
}
