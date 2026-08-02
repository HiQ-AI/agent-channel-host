#!/usr/bin/env node
import { readRecoveryContext } from './recovery-context.js';

const path = process.env.AGENT_CHANNEL_RECOVERY_CONTEXT;
if (!path) process.exit(0);

let input = '';
for await (const chunk of process.stdin) input += String(chunk);
const event = input ? JSON.parse(input) as { hook_event_name?: unknown; source?: unknown } : {};
if (event.hook_event_name !== 'SessionStart' || event.source !== 'compact') process.exit(0);

const payload = await readRecoveryContext(path);
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: payload.content,
  },
}));
