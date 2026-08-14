import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

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
  const listenIndex = args.indexOf('--listen');
  const endpoint = listenIndex >= 0 ? args[listenIndex + 1] : 'stdio://';
  if (endpoint?.startsWith('ws://')) return runWebSocketAppServer(endpoint);
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => handleAppServerMessage(
    JSON.parse(line), respond, notify,
    (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  ));
}

function runWebSocketAppServer(endpoint) {
  const url = new URL(endpoint);
  const server = createServer((request, response) => {
    if (request.url === '/readyz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end('[]');
    }
    response.writeHead(400);
    response.end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client, request));
  });
  sockets.on('connection', (client) => {
    const socketRespond = (id, result, error) => client.send(JSON.stringify(error
      ? { id, error: { code: -32000, message: error } }
      : { id, result }));
    const socketNotify = (method, params) => client.send(JSON.stringify({ method, params }));
    client.on('message', (data) => handleAppServerMessage(
      JSON.parse(data.toString()), socketRespond, socketNotify, (message) => client.send(JSON.stringify(message)),
    ));
  });
  server.listen(Number(url.port), url.hostname);
}

function handleAppServerMessage(message, sendResponse, sendNotification, sendRaw) {
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') return sendResponse(message.id, {});
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      if (message.params?.approvalPolicy !== 'never' || message.params?.sandbox !== 'danger-full-access') {
        return sendResponse(message.id, undefined, 'missing non-interactive thread policy');
      }
      const id = message.params.threadId ?? 'fake-app-server-session';
      return sendResponse(message.id, { thread: { id } });
    }
    if (message.method === 'thread/read') {
      return sendResponse(message.id, { thread: { id: message.params.threadId } });
    }
    if (message.method === 'turn/start') {
      const prompt = message.params?.input?.[0]?.text ?? '';
      if (prompt.includes('HUMAN_START') && message.params?.clientUserMessageId !== 'human-start-request') {
        return sendResponse(message.id, undefined, 'missing turn/start clientUserMessageId');
      }
      const turnId = String(message.params?.threadId ?? '').startsWith('parallel-')
        ? `turn-${message.params.threadId}` : 'fake-turn';
      sendResponse(message.id, { turn: { id: turnId } });
      sendNotification('turn/started', { turn: { id: turnId } });
      if (prompt.includes('APPROVAL_REQUEST')) {
        sendRaw({
          id: 'approval-1', method: 'item/commandExecution/requestApproval',
          params: { threadId: message.params.threadId, turnId, itemId: 'command-1' },
        });
      } else if (prompt.includes('ACTIVE_STEER')) {
        setTimeout(() => sendNotification('turn/completed', { turn: { id: turnId, status: 'completed' } }), 500);
      } else {
        sendNotification('turn/completed', { turn: { id: turnId, status: 'completed' } });
      }
      return;
    }
    if (message.method === 'turn/steer') {
      if (String(message.params?.expectedTurnId ?? '').startsWith('turn-parallel-')) {
        return sendResponse(message.id, { turnId: message.params.expectedTurnId });
      }
      if (message.params?.expectedTurnId !== 'fake-turn') return sendResponse(message.id, undefined, 'wrong expectedTurnId');
      if (message.params?.clientUserMessageId !== 'human-request-app-server') {
        return sendResponse(message.id, undefined, 'missing clientUserMessageId');
      }
      return sendResponse(message.id, { turnId: 'fake-turn' });
    }
    if (message.method === 'turn/interrupt') {
      sendResponse(message.id, {});
      return sendNotification('turn/completed', { turn: { id: message.params.turnId, status: 'interrupted' } });
    }
}

function respond(id, result, error) {
  process.stdout.write(`${JSON.stringify(error
    ? { id, error: { code: -32000, message: error } }
    : { id, result })}\n`);
}

function fail(id, message) {
  process.stdout.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}
