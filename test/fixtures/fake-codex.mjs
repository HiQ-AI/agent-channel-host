const args = process.argv.slice(2);
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
  complete();
}

function complete() {
  const text = JSON.stringify({
    action: 'silent',
    replyText: '',
  });
  process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
}
