import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const record = event => {
  if (process.env.MCP_TEST_RECORD) appendFileSync(process.env.MCP_TEST_RECORD, JSON.stringify(event) + '\n');
};
record({ event: 'start', pid: process.pid, cwd: process.cwd(), marker: process.env.MCP_TEST_MARKER });
if (process.env.MCP_TEST_IGNORE_TERM) process.on('SIGTERM', () => {});
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  record({ event: 'message', message });
  if (message.id === undefined || !message.method) return;
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'copilot-bridge-fixture', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ id, result: { tools: [{ name: 'bridge_delay', description: 'Echo a value after two seconds', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }] } });
  } else if (method === 'tools/call') {
    await new Promise(resolve => setTimeout(resolve, params.arguments?.delay ?? 2000));
    send({ id, result: { content: [{ type: 'text', text: params.arguments?.value ?? 'done' }] } });
  } else if (method === 'fixture/push') {
    send({ method: 'notifications/tools/list_changed' });
    send({ id: 'server-request', method: 'roots/list' });
    send({ id, result: {} });
  } else if (method === 'fixture/exit') process.exit(0);
  else send({ id, error: { code: -32601, message: 'Method not found' } });
});
