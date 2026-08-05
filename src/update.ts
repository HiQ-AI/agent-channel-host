import { execResolved, resolveCommand } from './command.js';
import { PRODUCT_VERSION } from './product.js';

export const PACKAGE_NAME = '@zzusp/agent-channel-host';

type UpdateRunner = (command: string, args: string[]) => Promise<string>;

export async function updateGlobalPackage(run: UpdateRunner = runUpdateCommand): Promise<Record<string, unknown>> {
  await run('npm', ['install', '--global', `${PACKAGE_NAME}@latest`]);
  const installed = JSON.parse(await run('npm', ['list', '--global', PACKAGE_NAME, '--depth=0', '--json'])) as {
    dependencies?: Record<string, { version?: string }>;
  };
  const installedVersion = installed.dependencies?.[PACKAGE_NAME]?.version?.trim();
  if (!installedVersion) throw new Error(`更新后未能确认全局安装的 ${PACKAGE_NAME} 版本`);
  return {
    ok: true,
    package: PACKAGE_NAME,
    previousVersion: PRODUCT_VERSION,
    installedVersion,
    restartRequired: true,
  };
}

async function runUpdateCommand(command: string, args: string[]): Promise<string> {
  const resolved = await resolveCommand(command);
  const result = await execResolved(resolved, args, {
    cwd: process.cwd(), encoding: 'utf8', timeout: 300_000, windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}
