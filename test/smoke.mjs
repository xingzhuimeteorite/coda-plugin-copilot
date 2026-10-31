// One real prompt per evidence directory. All other checks are local or handshake-only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert(process.env.CODA_PLUGIN_STATE, 'Set an isolated CODA_PLUGIN_STATE before testing');
assert(process.env.COPILOT_TEST_EVIDENCE, 'Set COPILOT_TEST_EVIDENCE outside Coda data');
const evidence = process.env.COPILOT_TEST_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const autopilot = 'https://agentclientprotocol.com/protocol/session-modes#autopilot';
const cwd = mkdtempSync(join(tmpdir(), 'coda-copilot-smoke-'));
const child = spawn(process.execPath, [fileURLToPath(new URL('../agent/entry.mjs', import.meta.url))], { env: process.env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
const closed = new Promise(resolve => child.once('close', resolve));
const pending = new Map(), updates = [], summary = { cwd, promptCount: 0 };
let id = 0, rest = '', reply = '', stderr = '';
const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
child.stdout.setEncoding('utf8').on('data', text => {
  const lines = (rest + text).split('\n'); rest = lines.pop();
  for (const line of lines.filter(Boolean)) {
    const message = JSON.parse(line);
    if (!message.method && pending.has(message.id)) {
      const asked = pending.get(message.id); pending.delete(message.id); clearTimeout(asked.timer);
      message.error ? asked.reject(new Error(JSON.stringify(message.error))) : asked.resolve(message.result);
    } else if (message.method === 'session/update') {
      const update = message.params.update;
      updates.push(update);
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') reply += update.content.text;
    } else if (message.method && message.id !== undefined) {
      // A reply-only prompt requires no privileged actions; unexpected requests fail the smoke test.
      send({ id: message.id, error: { code: -32601, message: 'No client tools in this smoke test' } });
      summary.unexpectedRequest = message.method;
    }
  }
});
child.on('error', error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); });
child.on('close', code => { summary.exitCode = code; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Entry exited: ${code}`)); } pending.clear(); });
function request(method, params, timeout = 60000) {
  const requestId = `coda-smoke-${++id}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, timeout);
    pending.set(requestId, { resolve, reject, timer });
    send({ id: requestId, method, params });
  });
}
try {
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'coda-copilot-smoke', version: '0.1.0' } });
  summary.agentInfo = initialized.agentInfo;
  assert(initialized.agentCapabilities.sessionCapabilities.systemPrompt);
  summary.systemPrompt = true;
  const opened = await request('session/new', { cwd, mcpServers: [], systemPrompt: { mode: 'append', content: [{ type: 'text', text: 'Keep replies concise.' }] } });
  summary.sessionId = opened.sessionId;
  summary.initialMode = opened.modes?.currentModeId;
  summary.model = opened.configOptions?.find(option => option.category === 'model')?.currentValue;
  const mode = opened.configOptions?.find(option => option.category === 'mode');
  assert(mode, 'Native mode config option missing');
  const changed = await request('session/set_config_option', { sessionId: opened.sessionId, configId: mode.id, value: autopilot });
  summary.selectedMode = changed.configOptions?.find(option => option.category === 'mode')?.currentValue;
  summary.allowAll = changed.configOptions?.find(option => option.id === 'allow_all')?.currentValue;
  assert.equal(summary.selectedMode, autopilot);
  assert(updates.some(update => update.sessionUpdate === 'current_mode_update' && update.currentModeId === autopilot
    || update.sessionUpdate === 'config_option_update' && update.configOptions?.some(option => option.category === 'mode' && option.currentValue === autopilot)), 'No mode update notification');
  summary.modeNotifications = updates.filter(update => ['current_mode_update', 'config_option_update'].includes(update.sessionUpdate)).map(update => update.sessionUpdate);
  writeFileSync(join(evidence, 'prompt-sent.lock'), new Date().toISOString(), { flag: 'wx' });
  summary.promptCount = 1;
  const prompted = await request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: '只回复 OK' }] }, 90000);
  summary.stopReason = prompted.stopReason;
  summary.reply = reply;
  assert.equal(prompted.stopReason, 'end_turn');
  summary.exactReply = reply.trim() === 'OK';
  assert(reply.includes('OK'), 'No OK reply received');
  if (!summary.exactReply) summary.outputNote = 'Native ACP text contains extra/repeated content; inspect without deduplicating it.';
  assert.equal(summary.unexpectedRequest, undefined);
  summary.result = 'PASS';
} catch (error) {
  summary.result = 'FAIL'; summary.error = error.message; process.exitCode = 1;
  if (summary.sessionId) send({ method: 'session/cancel', params: { sessionId: summary.sessionId } });
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await closed; clearTimeout(timer);
  summary.stderr = stderr.trim();
  writeFileSync(join(evidence, 'smoke-updates.json'), JSON.stringify(updates, null, 2) + '\n');
  writeFileSync(join(evidence, 'smoke-result.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
