import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  runAppServer();
} else {
const isResume = args[0] === 'exec' && args[1] === 'resume';
const prompt = args.at(-1) ?? '';
const sessionId = isResume ? args.at(-2) : 'fake-session-fixed';

process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);

if (prompt.includes('SLOW_SHORT')) {
  setTimeout(complete, 1_200);
} else if (prompt.includes('SLOW')) {
  setTimeout(complete, 5_000);
} else if (prompt.includes('FAIL')) {
  process.stderr.write('simulated failure\n');
  process.exitCode = 7;
} else {
  complete(prompt.includes('ECHO_PROMPT') ? prompt : null);
}
}

function complete(echo = null) {
  const text = JSON.stringify(echo === null
    ? { action: 'silent', replyText: '' }
    : { action: 'reply', replyText: echo });
  process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
}

function runAppServer() {
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') return respond(message.id, {});
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      if (message.params?.approvalPolicy !== 'never' || message.params?.sandbox !== 'danger-full-access') {
        return fail(message.id, 'missing non-interactive thread policy');
      }
      const id = message.params.threadId ?? 'fake-app-server-session';
      return respond(message.id, { thread: { id } });
    }
    if (message.method === 'turn/start') {
      const turnId = 'fake-turn';
      respond(message.id, { turn: { id: turnId } });
      notify('turn/started', { turn: { id: turnId } });
      const prompt = message.params?.input?.[0]?.text ?? '';
      if (prompt.includes('APPROVAL_REQUEST')) {
        process.stdout.write(`${JSON.stringify({
          id: 'approval-1', method: 'item/commandExecution/requestApproval',
          params: { threadId: message.params.threadId, turnId, itemId: 'command-1' },
        })}\n`);
      } else if (prompt.includes('ACTIVE_STEER')) {
        setTimeout(() => notify('turn/completed', { turn: { id: turnId, status: 'completed' } }), 500);
      } else {
        notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
      }
      return;
    }
    if (message.method === 'turn/steer') {
      if (message.params?.expectedTurnId !== 'fake-turn') return fail(message.id, 'wrong expectedTurnId');
      if (message.params?.clientUserMessageId !== 'human-request-app-server') {
        return fail(message.id, 'missing clientUserMessageId');
      }
      return respond(message.id, { turnId: 'fake-turn' });
    }
    if (message.method === 'turn/interrupt') {
      respond(message.id, {});
      return notify('turn/completed', { turn: { id: message.params.turnId, status: 'interrupted' } });
    }
  });
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function fail(id, message) {
  process.stdout.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}
