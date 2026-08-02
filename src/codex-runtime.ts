import type { HostConfig } from './config.js';
import type { RuntimeAdapter } from './contracts.js';
import { CodexCommandSession, verifyCodexCommand, type CodexCommandIdentity } from './codex-command.js';
import type { Store } from './store.js';
import type { Conversation } from './types.js';

export class CodexRuntimeAdapter implements RuntimeAdapter {
  private constructor(
    private readonly config: HostConfig,
    private readonly store: Store,
    private readonly identity: CodexCommandIdentity,
  ) {}

  static async create(config: HostConfig, store: Store): Promise<CodexRuntimeAdapter> {
    const identity = await verifyCodexCommand(config);
    return new CodexRuntimeAdapter(config, store, identity);
  }

  get descriptor() {
    return {
      runtimeId: this.config.runtime.id,
      label: 'Codex CLI',
      model: this.config.runtime.model,
      protocolFingerprint: this.identity.fingerprint,
      contextRecovery: 'session-start-hook' as const,
    };
  }

  createSession(conversation: Conversation): CodexCommandSession {
    if (conversation.runtimeId !== this.descriptor.runtimeId) {
      throw new Error(`conversation runtime=${conversation.runtimeId}，当前 adapter=${this.descriptor.runtimeId}`);
    }
    return new CodexCommandSession(this.config, conversation, this.identity, this.store);
  }
}
