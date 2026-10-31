// Real Copilot handshake only: no prompt, installation, or Coda data access.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert(process.env.CODA_PLUGIN_STATE && !process.env.CODA_PLUGIN_STATE.includes('/Coda/data/'), 'Use isolated CODA_PLUGIN_STATE');
const evidence = resolve(process.argv[2] ?? 'validation/mcp-copilot-result.json');
const cwd = mkdtempSync(join(tmpdir(), 'copilot-real-mcp-')), record = join(cwd, 'fixture.jsonl');
const logs = join(process.env.COPILOT_HOME ?? join(homedir(), '.copilot'), 'logs');
const before = new Set(readdirSync(logs));
const child = spawn(process.execPath, [fileURLToPath(new URL('../agent/entry.mjs', import.meta.url))], {
  cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map(); let nextId = 0, rest = '', stderr = '';
const summary = { cwd, promptCount: 0, result: 'FAIL' };
const closed = new Promise(resolve => child.once('close', code => {
  summary.exitCode = code;
  for (const p of pending.values()) p.reject(new Error(`Entry exited: ${code}`));
  pending.clear(); resolve();
}));
const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
child.stdout.setEncoding('utf8').on('data', chunk => {
  const lines = (rest + chunk).split('\n'); rest = lines.pop();
  for (const line of lines.filter(Boolean)) {
    const message = JSON.parse(line), p = pending.get(message.id);
    if (!message.method && p) {
      pending.delete(message.id);
      message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: 'No client tools in handshake probe' } });
    }
  }
});
async function request(method, params) {
  const id = ++nextId;
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ id, method, params }); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timeout`)), 90000); }),
    ]);
  } finally { clearTimeout(timer); pending.delete(id); }
}
try {
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'copilot-mcp-bridge-probe', version: '0.2.0' } });
  summary.agentInfo = initialized.agentInfo;
  const opened = await request('session/new', { cwd, mcpServers: [{
    name: 'bridge-fixture', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/stdio-mcp.mjs', import.meta.url))],
    env: [{ name: 'MCP_TEST_RECORD', value: record }],
  }] });
  summary.sessionId = opened.sessionId;
  const deadline = Date.now() + 60000;
  let candidates = [], fixtureEvents = [];
  do {
    candidates = readdirSync(logs).filter(name => !before.has(name) && /^process-.*\.log$/.test(name))
      .map(name => ({ path: join(logs, name), text: readFileSync(join(logs, name), 'utf8') }));
    try { fixtureEvents = readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse); } catch {}
    if (candidates.some(log => /Service initialized as client.*copilot-bridge-fixture/.test(log.text))
      && fixtureEvents.some(e => e.message?.method === 'tools/list')) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  const own = candidates.find(log => /copilot-bridge-fixture/.test(log.text));
  assert(own, 'No Copilot log with fixture initialization');
  summary.logPath = own.path;
  summary.logEvidence = own.text.split('\n').filter(line => /copilot-bridge-fixture|bridge-fixture|Rejecting non-http\/sse/.test(line));
  assert(!own.text.includes('Rejecting non-http/sse MCP server'));
  assert(own.text.includes('Service initialized as client'));
  summary.fixtureMethods = fixtureEvents.filter(e => e.message?.method).map(e => e.message.method);
  assert(summary.fixtureMethods.includes('initialize'));
  assert(summary.fixtureMethods.includes('notifications/initialized'));
  assert(summary.fixtureMethods.includes('tools/list'));
  summary.fixturePid = fixtureEvents.find(e => e.event === 'start').pid;
  summary.result = 'PASS';
} catch (error) { summary.error = error.message; process.exitCode = 1; }
finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await closed; clearTimeout(timer);
  if (summary.fixturePid) {
    try { process.kill(summary.fixturePid, 0); summary.childCleanedUp = false; }
    catch (error) { summary.childCleanedUp = error.code === 'ESRCH'; }
    if (!summary.childCleanedUp) { summary.result = 'FAIL'; process.exitCode = 1; }
  }
  summary.stderr = stderr.trim();
  writeFileSync(evidence, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
