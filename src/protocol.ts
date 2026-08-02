import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostConfig } from './config.js';
import type { CodexProtocolIdentity } from './types.js';
import { execResolved, resolveCommand } from './command.js';
const SCHEMA_FILE = 'codex_app_server_protocol.schemas.json';

export async function verifyCodexProtocol(config: HostConfig, protocolRoot: string): Promise<CodexProtocolIdentity> {
  const command = await resolveCommand(config.runtime.codexCommand);
  const version = await execResolved(command, ['--version'], {
    cwd: config.runtime.cwd,
    encoding: 'utf8',
    timeout: config.runtime.startupTimeoutSeconds * 1_000,
    windowsHide: true,
  });
  const actualVersion = version.stdout.trim();
  if (actualVersion !== config.protocol.codexVersion) {
    throw new Error(`Codex 版本不匹配：要求 ${config.protocol.codexVersion}，实际 ${actualVersion}`);
  }
  await mkdir(protocolRoot, { recursive: true });
  const tempDir = await mkdtemp(join(protocolRoot, 'verify-'));
  try {
    await execResolved(command, [
      'app-server', 'generate-json-schema', '--out', tempDir, '--experimental',
    ], {
      cwd: config.runtime.cwd,
      encoding: 'utf8',
      timeout: config.runtime.startupTimeoutSeconds * 1_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const schema = await readFile(join(tempDir, SCHEMA_FILE));
    const schemaSha256 = createHash('sha256').update(schema).digest('hex');
    if (schemaSha256 !== config.protocol.schemaSha256) {
      throw new Error(`Codex App Server schema SHA 不匹配：要求 ${config.protocol.schemaSha256}，实际 ${schemaSha256}`);
    }
    const schemaText = schema.toString('utf8');
    for (const method of ['model/list', 'thread/start', 'thread/resume', 'thread/loaded/list', 'turn/start', 'turn/interrupt']) {
      if (!schemaText.includes(`\"${method}\"`)) throw new Error(`Codex schema 缺少 ${method}`);
    }
    return { codexVersion: actualVersion, schemaSha256, schemaPath: `${actualVersion}/${SCHEMA_FILE}`, command };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
