import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Json = Record<string, unknown>;

export type AgentTranscriptKind = 'user' | 'assistant' | 'reasoning' | 'tool';

export interface AgentTranscriptEntry {
  id: string;
  kind: AgentTranscriptKind;
  at: string | null;
  label: string;
  content: string;
  result?: string;
  error?: boolean;
}

export interface AgentTranscript {
  state: 'ready' | 'no-session' | 'not-found' | 'error';
  sessionIdPrefix: string | null;
  revision: string | null;
  entries: AgentTranscriptEntry[];
  message: string | null;
}

const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_ENTRIES = 500;
const locateCache = new Map<string, { path: string | null; checkedAt: number }>();
const transcriptCache = new Map<string, { revision: string; value: AgentTranscript }>();

export function readCodexTranscript(
  sessionId: string | null,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): AgentTranscript {
  if (!sessionId) return emptyTranscript('no-session', null, '尚未创建固定 Agent session；发送消息后将自动创建。');
  const prefix = sessionId.slice(0, 12);
  if (!SESSION_ID.test(sessionId)) return emptyTranscript('error', prefix, '固定 Agent session ID 格式无效。');
  const sessionsRoot = join(env.CODEX_HOME?.trim() || join(userHome, '.codex'), 'sessions');
  const path = locateRollout(sessionsRoot, sessionId);
  if (!path) return emptyTranscript('not-found', prefix, '尚未找到 Codex 执行记录；等待 Agent 开始运行。');
  try {
    const stat = statSync(path);
    const revision = `${stat.size}:${stat.mtimeMs}`;
    const cached = transcriptCache.get(path);
    if (cached?.revision === revision) return cached.value;
    const value: AgentTranscript = {
      state: 'ready', sessionIdPrefix: prefix, revision,
      entries: parseCodexRollout(readFileSync(path, 'utf8')).slice(-MAX_ENTRIES), message: null,
    };
    transcriptCache.set(path, { revision, value });
    return value;
  } catch (error) {
    return emptyTranscript('error', prefix, `读取 Codex 执行记录失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseCodexRollout(source: string): AgentTranscriptEntry[] {
  const entries: AgentTranscriptEntry[] = [];
  const tools = new Map<string, AgentTranscriptEntry>();
  let sequence = 0;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Json;
    try { event = JSON.parse(line) as Json; } catch { continue; }
    const payload = object(event.payload);
    const at = text(event.timestamp);
    if (event.type === 'event_msg' && payload.type === 'user_message') {
      pushText(entries, ++sequence, 'user', at, '真人/消息', text(payload.message));
      continue;
    }
    if (event.type === 'event_msg' && payload.type === 'agent_message') {
      pushText(entries, ++sequence, 'assistant', at, 'Agent', text(payload.message));
      continue;
    }
    if (event.type === 'event_msg' && payload.type === 'agent_reasoning') {
      pushText(entries, ++sequence, 'reasoning', at, '思考', text(payload.text));
      continue;
    }
    if (event.type !== 'response_item') continue;
    const type = text(payload.type);
    if (type === 'custom_tool_call' || type === 'function_call') {
      const callId = text(payload.call_id) ?? text(payload.id) ?? `tool-${sequence + 1}`;
      const name = text(payload.name) ?? 'tool';
      const entry: AgentTranscriptEntry = {
        id: `${++sequence}:tool:${callId}`, kind: 'tool', at, label: name,
        content: summarizeToolInput(name, payload.input ?? payload.arguments),
      };
      entries.push(entry);
      tools.set(callId, entry);
      continue;
    }
    if (type !== 'custom_tool_call_output' && type !== 'function_call_output') continue;
    const callId = text(payload.call_id) ?? text(payload.id);
    const result = callId ? tools.get(callId) : null;
    if (!result) continue;
    result.result = clip(toolOutputText(payload.output), 500);
    result.error = payload.is_error === true || payload.status === 'failed';
  }
  return entries;
}

function locateRollout(root: string, sessionId: string): string | null {
  const now = Date.now();
  const cacheKey = `${root}\0${sessionId}`;
  const cached = locateCache.get(cacheKey);
  if (cached && now - cached.checkedAt < 3_000) {
    if (!cached.path) return null;
    try { statSync(cached.path); return cached.path; } catch { /* rescan */ }
  }
  const suffix = `-${sessionId}.jsonl`.toLowerCase();
  let latest: { path: string; mtimeMs: number } | null = null;
  const walk = (directory: string): void => {
    let items;
    try { items = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && item.name.toLowerCase().endsWith(suffix)) {
        let mtimeMs = 0;
        try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
        if (!latest || mtimeMs > latest.mtimeMs) latest = { path, mtimeMs };
      }
    }
  };
  walk(root);
  const path = latest ? (latest as { path: string }).path : null;
  locateCache.set(cacheKey, { path, checkedAt: now });
  return path;
}

function pushText(
  entries: AgentTranscriptEntry[], sequence: number, kind: AgentTranscriptKind,
  at: string | null, label: string, value: string | null,
): void {
  const content = value?.trim();
  if (!content) return;
  entries.push({ id: `${sequence}:${kind}`, kind, at, label, content: clip(content, kind === 'assistant' ? 2_000 : 1_200) });
}

function summarizeToolInput(name: string, value: unknown): string {
  const input = parseObject(value);
  const candidate = text(input.command) ?? text(input.path) ?? text(input.file_path)
    ?? text(input.query) ?? text(input.prompt) ?? text(input.description)
    ?? text(input.url);
  if (candidate) return clip(candidate.replace(/\s+/g, ' ').trim(), 240);
  const serialized = JSON.stringify(input);
  return clip(serialized === '{}' ? name : serialized, 240);
}

function toolOutputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => {
    if (typeof item === 'string') return item;
    const row = object(item);
    return text(row.text) ?? text(row.output_text) ?? '';
  }).filter(Boolean).join('\n');
  if (value === null || value === undefined) return '(无输出)';
  return JSON.stringify(value);
}

function parseObject(value: unknown): Json {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Json;
  if (typeof value !== 'string') return { value: value ?? null };
  try { return object(JSON.parse(value)); } catch { return { input: value }; }
}

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function emptyTranscript(
  state: AgentTranscript['state'], sessionIdPrefix: string | null, message: string,
): AgentTranscript {
  return { state, sessionIdPrefix, revision: null, entries: [], message };
}
