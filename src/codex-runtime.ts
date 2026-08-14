import type { HostConfig } from './config.js';
import type { RuntimeAdapter } from './contracts.js';
import { CodexAppServerSession, verifyCodexAppServer, type CodexAppServerIdentity } from './codex-app-server.js';
import { CodexAppServerHost } from './codex-app-server-host.js';
import type { Store } from './store.js';
import type { Conversation } from './types.js';

export class CodexRuntimeAdapter implements RuntimeAdapter {
  private constructor(
    private readonly config: HostConfig,
    private readonly store: Store,
    private readonly identity: CodexAppServerIdentity,
    private readonly appServer: CodexAppServerHost,
  ) {}

  static async create(config: HostConfig, store: Store): Promise<CodexRuntimeAdapter> {
    const identity = await verifyCodexAppServer(config);
    const appServer = await CodexAppServerHost.start(config, identity);
    return new CodexRuntimeAdapter(config, store, identity, appServer);
  }

  get descriptor() {
    return {
      runtimeId: this.config.runtime.id,
      label: 'Codex App Server',
      model: this.config.runtime.model,
      protocolFingerprint: this.identity.fingerprint,
      contextRecovery: 'runtime-native' as const,
      endpoint: this.appServer.endpoint,
      instanceId: this.appServer.instanceId,
      processId: this.appServer.processId,
    };
  }

  createSession(conversation: Conversation): CodexAppServerSession {
    if (conversation.runtimeId !== this.descriptor.runtimeId) {
      throw new Error(`conversation runtime=${conversation.runtimeId}，当前 adapter=${this.descriptor.runtimeId}`);
    }
    return new CodexAppServerSession(this.config, conversation, this.identity, this.store, this.appServer);
  }

  async stop(): Promise<void> { await this.appServer.stop(); }
}
