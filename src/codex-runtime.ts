import { join } from 'node:path';
import type { HostConfig } from './config.js';
import type { RuntimeAdapter } from './contracts.js';
import { instanceDir } from './paths.js';
import { verifyCodexProtocol } from './protocol.js';
import { AppServerSession, codexProtocolFingerprint } from './app-server.js';
import type { Store } from './store.js';
import type { CodexProtocolIdentity, Conversation } from './types.js';

export class CodexRuntimeAdapter implements RuntimeAdapter {
  private constructor(
    private readonly config: HostConfig,
    private readonly store: Store,
    private readonly protocol: CodexProtocolIdentity,
  ) {}

  static async create(config: HostConfig, store: Store): Promise<CodexRuntimeAdapter> {
    const protocol = await verifyCodexProtocol(config, join(instanceDir(config.instance), 'protocol'));
    return new CodexRuntimeAdapter(config, store, protocol);
  }

  get descriptor() {
    return {
      runtimeId: 'codex',
      label: 'Codex App Server',
      model: this.config.runtime.codexModel,
      protocolFingerprint: codexProtocolFingerprint(this.protocol),
    };
  }

  createSession(conversation: Conversation): AppServerSession {
    if (conversation.runtimeId !== this.descriptor.runtimeId) {
      throw new Error(`conversation runtime=${conversation.runtimeId}，当前 adapter=${this.descriptor.runtimeId}`);
    }
    return new AppServerSession(this.config, conversation, this.protocol, this.store);
  }
}
