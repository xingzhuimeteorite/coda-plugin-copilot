// Ask the Copilot CLI itself over its headless JSON-RPC (the transport @github/copilot-sdk uses), so the panel sees the
// same authentication the agent does. The process lives only for the questions asked.
import { spawn } from 'node:child_process';
import { cliEnv } from './binary.mjs';

export async function askCopilot(binary, methods, { timeoutMs = 20_000, env = cliEnv() } = {}) {
  const child = spawn(binary, ['--headless', '--no-auto-update', '--stdio', '--log-level', 'none'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = Buffer.alloc(0), nextId = 0, stderr = '';
  const fail = error => { for (const reject of pending.values()) reject(error); pending.clear(); };
  child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-2000); });
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
      if (!Number.isFinite(length)) { fail(new Error('Copilot 返回了无法识别的消息')); child.kill(); return; }
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
      buffer = buffer.subarray(end + 4 + length);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'Copilot 返回错误'));
      else waiter.resolve(message.result);
    }
  });
  child.on('error', error => fail(new Error(`Copilot 启动失败：${error.message}`)));
  child.on('close', code => fail(new Error(`Copilot 提前退出（${code}）${stderr.trim() ? `：${stderr.trim().split('\n').pop()}` : ''}`)));
  child.stdin.on('error', () => {});
  const call = method => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject: error => reject(error) });
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: {} });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  const timer = setTimeout(() => { fail(new Error('Copilot 没有及时答复')); child.kill('SIGKILL'); }, timeoutMs);
  try {
    const results = {};
    for (const method of methods) results[method] = await call(method);
    return results;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}
