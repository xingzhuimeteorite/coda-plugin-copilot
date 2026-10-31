import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { McpBridges } from '../agent/mcp-bridge.mjs';

const fixture = fileURLToPath(new URL('./fixtures/stdio-mcp.mjs', import.meta.url));
const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
const config = (record, extra = []) => ({ name: 'fixture', command: process.execPath, args: [fixture], env: [
  { name: 'MCP_TEST_RECORD', value: record }, { name: 'MCP_TEST_MARKER', value: 'merged-env' }, ...extra,
] });
const events = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
async function post(url, body, session, accept = 'application/json, text/event-stream', extra = {}) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: accept,
    ...(session ? { 'Mcp-Session-Id': session } : {}), ...extra }, body: JSON.stringify(body) });
}
async function initialize(url) {
  const res = await post(url, rpc(0, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.serverInfo.name, 'copilot-bridge-fixture');
  const session = res.headers.get('mcp-session-id');
  assert(session);
  return session;
}
function dead(pid) { assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); }

test('HTTP transport: lifecycle, batches, SSE, concurrent IDs, env/cwd, reuse and cleanup', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-bridge-test-')), record = join(dir, 'events.jsonl');
  const bridges = new McpBridges(); t.after(() => bridges.close());
  const stdio = config(record, [{ name: 'MCP_TEST_IGNORE_TERM', value: '1' }]);
  const remote = { type: 'http', name: 'remote', url: 'https://example.invalid/mcp', headers: [] };
  const sse = { type: 'sse', name: 'remote-sse', url: 'https://example.invalid/sse', headers: [] };
  let rewritten;
  for (const method of ['session/new', 'session/load', 'session/resume', 'session/fork', 'extension/with-mcp']) {
    const original = { id: 1, method, params: { cwd: dir, mcpServers: [method === 'session/new' ? stdio : { ...stdio, type: 'stdio', env: [...stdio.env].reverse().map(({ name, value }) => ({ value, name })) }, remote, sse] } };
    const message = await bridges.rewrite(original);
    assert.equal(original.params.mcpServers[0].command, stdio.command);
    assert.equal(message.params.mcpServers[1], remote);
    assert.equal(message.params.mcpServers[2], sse);
    assert.deepEqual(Object.keys(message.params.mcpServers[0]).sort(), ['headers', 'name', 'type', 'url']);
    assert.equal(message.params.mcpServers[0].type, 'http');
    if (rewritten) assert.equal(message.params.mcpServers[0].url, rewritten);
    rewritten = message.params.mcpServers[0].url;
  }
  const session = await initialize(rewritten), other = await initialize(rewritten);
  assert.notEqual(session, other);
  const started = events(record).filter(e => e.event === 'start');
  assert.equal(started.length, 1); assert.equal(started[0].cwd, realpathSync(dir)); assert.equal(started[0].marker, 'merged-env');
  assert.equal((await post(rewritten, rpc(undefined, 'notifications/initialized'), session)).status, 202);
  const list = await post(rewritten, rpc(1, 'tools/list'), session);
  assert.equal((await list.json()).result.tools[0].name, 'bridge_delay');
  const before = Date.now();
  const calls = await Promise.all([
    post(rewritten, rpc('same', 'tools/call', { name: 'bridge_delay', arguments: { value: 'slow' } }), session).then(r => r.json()),
    post(rewritten, rpc('same', 'tools/call', { name: 'bridge_delay', arguments: { value: 'fast', delay: 10 } }), other).then(r => r.json()),
    post(rewritten, rpc(2, 'tools/list'), session).then(r => r.json()),
  ]);
  assert(Date.now() - before >= 1900);
  assert.equal(calls[0].id, 'same'); assert.equal(calls[0].result.content[0].text, 'slow');
  assert.equal(calls[1].id, 'same'); assert.equal(calls[1].result.content[0].text, 'fast');
  assert.equal(calls[2].id, 2); assert(calls[2].result.tools);
  // Cancellation IDs must be mapped to the same stdio ID as their active request.
  const cancelling = post(rewritten, rpc('cancel-me', 'tools/call', { arguments: { delay: 50 } }), session);
  for (let i = 0; i < 100; i++) {
    if (events(record).some(e => e.message?.params?.arguments?.delay === 50)) break;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal((await post(rewritten, rpc('cancel-me', 'tools/list'), session)).status, 400);
  assert.equal((await post(rewritten, rpc(undefined, 'notifications/cancelled', { requestId: 'cancel-me' }), session)).status, 202);
  await cancelling;
  const recorded = events(record).map(e => e.message).filter(Boolean);
  assert.equal(recorded.find(m => m.method === 'notifications/cancelled').params.requestId,
    recorded.find(m => m.params?.arguments?.delay === 50).id);
  assert.equal((await post(rewritten, { jsonrpc: '2.0', id: 'client-response', result: {} }, session)).status, 202);
  const batch = await post(rewritten, [rpc(3, 'tools/list'), rpc(undefined, 'notifications/initialized'), rpc(4, 'tools/call', { arguments: { value: 'batch', delay: 10 } })], session);
  assert.deepEqual((await batch.json()).map(r => r.id), [3, 4]);
  assert.equal((await post(rewritten, [rpc(undefined, 'notifications/initialized')], session)).status, 202);
  const stream = await post(rewritten, rpc(5, 'tools/list'), session, 'text/event-stream');
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.match(await stream.text(), /event: message\ndata: .*"id":5.*\n\n/);
  assert.equal((await fetch(rewritten, { headers: { 'Mcp-Session-Id': session } })).status, 405);
  assert.equal((await fetch(rewritten, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } })).status, 405);
  assert.equal((await post(rewritten, rpc(6, 'tools/list'))).status, 400);
  assert.equal((await post(rewritten, rpc(6, 'tools/list'), 'unknown')).status, 404);
  assert.equal((await post(rewritten, rpc(6, 'tools/list'), session, undefined, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await post(rewritten + '-wrong', rpc(6, 'tools/list'), session)).status, 404);
  assert.equal((await post(rewritten, [], session)).status, 400);
  assert.equal((await post(rewritten, rpc(6, 'tools/list'), session, undefined, { 'MCP-Protocol-Version': '2099-01-01' })).status, 400);
  assert.equal((await post(rewritten, rpc(6, 'fixture/push'), session)).status, 200);
  // Follow-up ensures the fixture has consumed the server-request rejection.
  await (await post(rewritten, rpc(7, 'tools/list'), session)).json();
  assert(events(record).some(e => e.message?.id === 'server-request' && e.message.error?.code === -32601));
  const waiting = post(rewritten, rpc(8, 'tools/call', { arguments: { delay: 60000 } }), session).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 30));
  await bridges.close(); await waiting;
  dead(started[0].pid);
  await assert.rejects(fetch(rewritten));
});

test('stdio exit fails pending requests and spawn failures close the endpoint', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-bridge-exit-'));
  const bridges = new McpBridges(); t.after(() => bridges.close());
  await assert.rejects(bridges.rewrite({ method: 'session/new', params: { cwd: dir, mcpServers: [{ name: 'bad', command: '/nonexistent-copilot-bridge-command' }] } }));
  const message = await bridges.rewrite({ method: 'session/new', params: { cwd: dir, mcpServers: [config(join(dir, 'events'))] } });
  const url = message.params.mcpServers[0].url, session = await initialize(url);
  const result = await post(url, rpc(1, 'fixture/exit'), session);
  assert.match((await result.json()).error.message, /exited|closed/);
  assert.equal((await post(url, rpc(2, 'tools/list'), session)).status, 503);
});

test('entry cleans up MCP child processes on stdin EOF and termination signals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-entry-cleanup-'));
  // Stand-in Copilot acknowledges ACP without using any network or Coda state.
  const { writeFileSync, chmodSync } = await import('node:fs');
  const fake = join(dir, 'copilot');
  writeFileSync(fake, `#!${process.execPath}\nimport readline from 'node:readline';\nreadline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\\n')});\n`);
  chmodSync(fake, 0o755);
  for (const signal of [null, 'SIGTERM', 'SIGINT', 'SIGHUP']) {
    const record = join(dir, `events-${signal}`);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../agent/entry.mjs', import.meta.url))], {
      cwd: dir, env: { ...process.env, CODA_USER_PATH: dir, CODA_PLUGIN_STATE: dir }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      child.stdin.write(JSON.stringify({ id: 1, method: 'session/new', params: { cwd: dir, mcpServers: [config(record)] } }) + '\n');
      await once(child.stdout, 'data');
      // The bridge spawned the fixture; use its HTTP initialize path indirectly only in other tests.
      // Wait for the fixture start record, not an arbitrary process-start delay.
      for (let i = 0; i < 100; i++) {
        try { if (events(record).length) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const pid = events(record)[0].pid;
      if (signal) child.kill(signal); else child.stdin.end();
      const [code] = await closed;
      assert.equal(code, 0, stderr); dead(pid);
    } finally { clearTimeout(timeout); child.kill('SIGKILL'); }
  }
});
