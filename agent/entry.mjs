// Native ACP with Coda session instructions and stdio MCP transport adaptation.
import { spawn } from 'node:child_process';
import { copilotBinary, cliEnv } from './binary.mjs';
import { SessionInstructions } from './instructions.mjs';
import { McpBridges } from './mcp-bridge.mjs';

const binary = copilotBinary();
if (!binary) {
  console.error('找不到 Copilot CLI；请重新运行插件 setup（设置 › 插件）。');
  process.exit(1);
}
const copilot = spawn(binary, ['--acp', '--no-auto-update'], { env: cliEnv(), stdio: ['pipe', 'pipe', 'inherit'] });
const instructions = new SessionInstructions();
const bridges = new McpBridges();
let incoming = Promise.resolve();
const send = (stream, message) => stream.write(`${JSON.stringify(message)}\n`);
let stopping = false, nativeInstructions = false, exitCode = 0;

// Split only on LF, preserving literal Unicode line separators inside JSON strings and partial UTF-8 chunks.
function read(stream, receive) {
  let rest = '';
  const take = text => {
    const lines = (rest + text).split('\n'); rest = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { receive(JSON.parse(line)); }
      catch (error) { console.error(`ACP 转发失败：${error.message}`); exitCode = 1; stop(); }
    }
  };
  stream.setEncoding('utf8').on('data', take).on('end', () => take('\n'));
}
read(process.stdin, message => {
  incoming = incoming.then(async () => {
    if (stopping) return;
    try { message = await bridges.rewrite(message); }
    catch (error) {
      if (message.id !== undefined) send(process.stdout, { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
      else console.error(`MCP 桥接失败：${error.message}`);
      return;
    }
    if (stopping) return;
    if (nativeInstructions) { send(copilot.stdin, message); return; }
    const { agent, coda } = instructions.fromCoda(message);
    send(coda ? process.stdout : copilot.stdin, coda ?? agent);
  }).catch(error => { console.error(`ACP 转发失败：${error.message}`); exitCode = 1; stop(); });
});
read(copilot.stdout, message => {
  if (message.result?.agentCapabilities?.sessionCapabilities?.systemPrompt) nativeInstructions = true;
  send(process.stdout, nativeInstructions ? message : instructions.fromAgent(message));
});
function stop() {
  if (stopping) return;
  stopping = true;
  void bridges.close();
  copilot.stdin.end();
  copilot.kill();
  setTimeout(() => copilot.kill('SIGKILL'), 800).unref();
}
copilot.stdin.on('error', error => { if (!stopping) { console.error(error.message); exitCode = 1; stop(); } });
process.stdout.on('error', stop);
copilot.on('error', error => { console.error(`Copilot 启动失败：${error.message}`); exitCode = 1; stop(); });
copilot.on('close', async code => {
  const finalCode = stopping ? exitCode : code ?? 1;
  stop();
  await bridges.close();
  process.exit(finalCode);
});
process.stdin.on('end', stop);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
