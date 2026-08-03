import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { instanceDir, safeName } from './paths.js';
import { PRODUCT_ID } from './product.js';

const execFileAsync = promisify(execFile);

export interface ServicePlan {
  taskName: string;
  launcherPath: string;
  launcher: string;
  createArgs: string[];
}

export function windowsServicePlan(instance: string, cliPath: string, nodePath = process.execPath): ServicePlan {
  safeName(instance);
  const directory = instanceDir(instance);
  const launcherPath = join(directory, 'run-host.cmd');
  const logPath = join(directory, 'service.log');
  const launcher = `@echo off\r\n"${nodePath}" "${resolve(cliPath)}" run --instance "${instance}" >> "${logPath}" 2>&1\r\n`;
  const taskName = `${PRODUCT_ID}-${instance}`;
  return {
    taskName,
    launcherPath,
    launcher,
    createArgs: ['/Create', '/SC', 'ONLOGON', '/TN', taskName, '/TR', `"${launcherPath}"`, '/RL', 'LIMITED', '/F'],
  };
}

export async function installUserService(instance: string, cliPath: string): Promise<ServicePlan> {
  if (process.platform !== 'win32') throw new Error('首版 service install 仅支持 Windows 用户级计划任务；其他平台请用前台 run 接入进程管理器');
  const plan = windowsServicePlan(instance, cliPath);
  await mkdir(dirname(plan.launcherPath), { recursive: true });
  await writeFile(plan.launcherPath, plan.launcher, { encoding: 'utf8', mode: 0o700 });
  await chmod(plan.launcherPath, 0o700).catch(() => undefined);
  await execFileAsync('schtasks.exe', plan.createArgs, { encoding: 'utf8', windowsHide: true });
  await execFileAsync('schtasks.exe', ['/Run', '/TN', plan.taskName], { encoding: 'utf8', windowsHide: true });
  return plan;
}

export async function removeUserService(instance: string, check: boolean): Promise<ServicePlan> {
  if (process.platform !== 'win32') throw new Error('首版 service remove 仅支持 Windows 用户级计划任务');
  const plan = windowsServicePlan(instance, process.argv[1]!);
  if (check) return plan;
  await execFileAsync('schtasks.exe', ['/End', '/TN', plan.taskName], { encoding: 'utf8', windowsHide: true }).catch(() => undefined);
  await execFileAsync('schtasks.exe', ['/Delete', '/TN', plan.taskName, '/F'], { encoding: 'utf8', windowsHide: true });
  await rm(plan.launcherPath, { force: true });
  return plan;
}

export async function removeUserServiceIfInstalled(instance: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const plan = windowsServicePlan(instance, process.argv[1]!);
  try {
    await execFileAsync('schtasks.exe', ['/Query', '/TN', plan.taskName], { encoding: null, windowsHide: true });
  } catch (error) {
    const failure = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
    const detail = windowsCommandFailureDetail(failure);
    if (isWindowsTaskMissingFailure(failure)) return false;
    throw new Error(`无法查询 Windows 用户计划任务 ${plan.taskName}：${detail}`);
  }
  await execFileAsync('schtasks.exe', ['/End', '/TN', plan.taskName], { encoding: 'utf8', windowsHide: true }).catch(() => undefined);
  await execFileAsync('schtasks.exe', ['/Delete', '/TN', plan.taskName, '/F'], { encoding: 'utf8', windowsHide: true });
  await rm(plan.launcherPath, { force: true });
  return true;
}

export function windowsCommandFailureDetail(
  failure: Error & { stdout?: Buffer | string; stderr?: Buffer | string },
): string {
  const output = [decodeWindowsCommandOutput(failure.stdout), decodeWindowsCommandOutput(failure.stderr)]
    .filter(Boolean)
    .join('\n')
    .trim();
  return output || failure.message;
}

export function isWindowsTaskMissingFailure(
  failure: Error & { stdout?: Buffer | string; stderr?: Buffer | string },
): boolean {
  return /cannot find|does not exist|找不到/i.test(windowsCommandFailureDetail(failure));
}

function decodeWindowsCommandOutput(value: Buffer | string | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return new TextDecoder('gb18030').decode(value);
  }
}
