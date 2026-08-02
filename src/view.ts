import type { Store } from './store.js';
import { CLI_NAME } from './product.js';

type Json = Record<string, unknown>;

export interface ViewOptions {
  instance: string;
  intervalSeconds: number;
  once: boolean;
  showContent: boolean;
}

export async function runView(store: Store, options: ViewOptions): Promise<void> {
  if (!options.once && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('持续 view 需要交互式终端；在管道或脚本中请使用 --once');
  }
  const render = () => renderStatusView(options.instance, store.status(options.showContent), process.stdout.columns ?? 120);
  if (options.once) {
    process.stdout.write(`${render()}\n`);
    return;
  }

  let rawMode = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const paint = () => process.stdout.write(`\u001b[2J\u001b[H${render()}\n`);
  const onData = (chunk: Buffer) => {
    const key = chunk.toString('utf8').toLowerCase();
    if (key === 'q' || key === '\u0003') resolveStop();
  };
  const onSignal = () => resolveStop();
  try {
    process.stdin.setRawMode?.(true);
    rawMode = true;
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    paint();
    timer = setInterval(paint, options.intervalSeconds * 1_000);
    await stopped;
  } finally {
    if (timer) clearInterval(timer);
    process.stdin.removeListener('data', onData);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (rawMode) process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }
}

export function renderStatusView(instance: string, snapshot: Record<string, unknown>, width = 120): string {
  const host = object(snapshot.host);
  const channels = array(snapshot.channels);
  const conversations = array(snapshot.conversations);
  const messages = array(snapshot.messages);
  const runtimeAdapters = array(snapshot.runtimeAdapters);
  const runtimes = array(snapshot.runtimes);
  const alerts = array(snapshot.alerts);
  const lines: string[] = [];
  lines.push(`${CLI_NAME} view  instance=${instance}  refreshed=${text(snapshot.generatedAt) ?? '-'}`);
  lines.push(`Host ${text(host.state) ?? 'unknown'}  pid=${text(host.pid) ?? '-'}  heartbeat=${age(host.heartbeatAt)}`);
  lines.push('');
  lines.push('CHANNELS');
  lines.push(...table(
    ['CHANNEL', 'PROFILE', 'STATE', 'PID', 'LAST EVENT', 'ERROR'],
    channels.map((row) => [row.channelId, row.profileId, row.state, row.pid, age(row.lastEventAt), row.error ?? '-']),
    width,
  ));
  lines.push('');
  lines.push(
    `MESSAGES received=${number(snapshot.received)} pending=${number(snapshot.pending_messages)}`
    + ` claimed=${number(snapshot.claimed_messages)} processed=${number(snapshot.processed)}`
    + ` failed=${number(snapshot.failed_messages)} outbox=${number(snapshot.pending_outbox)}/${number(snapshot.submitted)}`,
  );
  const messageHeaders = ['CHANNEL', 'CONVERSATION', 'SEQ', 'SENDER', 'STATE', 'ACTION', 'AGE'];
  if (messages.some((row) => row.preview !== undefined)) messageHeaders.push('PREVIEW');
  lines.push(...table(
    messageHeaders,
    messages.map((row) => {
      const values: unknown[] = [row.channelId, row.title, row.sequence, row.sender ?? '-', row.state, row.action ?? '-', age(row.receivedAt)];
      if (messageHeaders.includes('PREVIEW')) values.push(row.preview ?? '-');
      return values;
    }),
    width,
  ));
  lines.push('');
  lines.push('CONVERSATIONS');
  lines.push(...table(
    ['CHANNEL', 'TITLE', 'KIND', 'MODE', 'PENDING', 'WORKER', 'WARM UNTIL', 'RUNTIME'],
    conversations.map((row) => [
      row.channelId, row.title, row.kind, row.mode, row.pending, row.workerState,
      row.warmUntil ? age(row.warmUntil, true) : '-', row.runtimeId,
    ]),
    width,
  ));
  lines.push('');
  lines.push('RUNTIMES');
  lines.push(...table(
    ['RUNTIME', 'LABEL', 'STATE', 'MODEL', 'PROTOCOL', 'ERROR'],
    runtimeAdapters.map((row) => [
      row.runtimeId, row.label, row.state, row.model ?? '-', row.protocolFingerprintPrefix ?? '-', row.error ?? '-',
    ]),
    width,
  ));
  lines.push('');
  lines.push('SESSIONS / WORKERS');
  lines.push(...table(
    ['RUNTIME', 'CONVERSATION', 'WORKER', 'PID', 'SESSION', 'SESSION ID', 'GEN'],
    runtimes.map((row) => [
      row.runtimeId, row.conversation, row.workerState, row.processId ?? '-', row.sessionState,
      row.providerSessionPrefix ?? '-', row.generation ?? '-',
    ]),
    width,
  ));
  if (alerts.length > 0) {
    lines.push('');
    lines.push('ALERTS');
    lines.push(...alerts.map((row) => `- ${text(row.scope)}/${text(row.target)}: ${text(row.error)} (${age(row.at)})`));
  }
  lines.push('');
  lines.push('q / Ctrl+C 退出；默认不显示消息正文，按 --show-content 显式开启本地预览');
  return lines.join('\n');
}

function table(headers: string[], rows: unknown[][], width: number): string[] {
  if (rows.length === 0) return ['  (none)'];
  const usable = Math.max(60, width - 2);
  const natural = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => cell(row[index]).length),
  ));
  const separatorWidth = (headers.length - 1) * 2;
  let total = natural.reduce((sum, value) => sum + value, 0) + separatorWidth;
  const widths = [...natural];
  while (total > usable) {
    const index = widths.reduce((best, value, current) => value > widths[best]! ? current : best, 0);
    if (widths[index]! <= 6) break;
    widths[index]!--;
    total--;
  }
  const render = (row: unknown[]) => row.map((value, index) => pad(truncate(cell(value), widths[index]!), widths[index]!)).join('  ').trimEnd();
  return [render(headers), render(widths.map((value) => '-'.repeat(value))), ...rows.map(render)];
}

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function array(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cell(value: unknown): string {
  return text(value) ?? '-';
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

function pad(value: string, width: number): string {
  return value.padEnd(width, ' ');
}

function age(value: unknown, future = false): string {
  if (!value) return '-';
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return String(value);
  const delta = future ? timestamp - Date.now() : Date.now() - timestamp;
  const sign = delta < 0 ? '-' : '';
  const seconds = Math.max(0, Math.round(Math.abs(delta) / 1_000));
  if (seconds < 60) return `${future ? 'in ' : ''}${sign}${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${future ? 'in ' : ''}${sign}${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${future ? 'in ' : ''}${sign}${hours}h`;
}
