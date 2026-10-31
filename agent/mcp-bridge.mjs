// A process-local transport adapter: ACP stdio MCP -> loopback Streamable HTTP.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const hasId = message => Object.hasOwn(message, 'id');
const rpcError = (id, message, code = -32603) => ({ jsonrpc: '2.0', id, error: { code, message } });
const isRequest = message => typeof message.method === 'string' && hasId(message);
function valid(message) {
  return message && typeof message === 'object' && !Array.isArray(message) && message.jsonrpc === '2.0'
    && (!hasId(message) || message.id === null || typeof message.id === 'string' || typeof message.id === 'number')
    && (typeof message.method === 'string' || hasId(message) && (Object.hasOwn(message, 'result') || message.error));
}

class StdioBridge {
  constructor(config, cwd) {
    this.pending = new Map();
    this.sessions = new Map();
    this.nextId = 0;
    this.path = `/mcp/${randomUUID()}`;
    this.child = spawn(config.command, config.args ?? [], {
      cwd, env: { ...process.env, ...Object.fromEntries((config.env ?? []).map(({ name, value }) => [name, value])) },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.on('error', error => this.fail(error.message));
    this.child.stdin.on('error', error => this.fail(error.message));
    this.child.once('exit', () => this.fail('MCP stdio process exited'));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try {
        const messages = JSON.parse(line);
        for (const message of Array.isArray(messages) ? messages : [messages]) this.receive(message);
      } catch { this.fail('Invalid JSON from MCP stdio process'); void this.close(); }
    });
    this.child.stdout.once('end', () => this.fail('MCP stdout closed'));
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(error => {
        if (!res.headersSent) this.reply(res, 500, rpcError(null, error.message));
        else res.destroy();
      });
    });
    // Tool calls may wait 45 seconds or longer. No socket/request deadline for them.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 120_000;
    this.server.timeout = 0;
  }
  async start() {
    const spawned = once(this.child, 'spawn');
    this.server.listen(0, '127.0.0.1');
    await Promise.all([spawned, once(this.server, 'listening')]);
    if (this.failure) throw new Error(this.failure);
    this.url = `http://127.0.0.1:${this.server.address().port}${this.path}`;
    return this;
  }
  reply(res, status, body, sse = false, sessionId) {
    if (res.destroyed) return;
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = sse ? 'text/event-stream' : 'application/json';
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    res.writeHead(status, headers);
    res.end(body === undefined ? undefined : sse ? `event: message\ndata: ${JSON.stringify(body)}\n\n` : JSON.stringify(body));
  }
  async handle(req, res) {
    const respond = (status, body) => this.reply(res, status, body);
    if (req.url !== this.path) return respond(404);
    if (req.headers.origin && req.headers.origin !== new URL(this.url).origin) return respond(403);
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && !this.sessions.has(sessionId)) return respond(404);
    // No standalone server-push stream, replay, or client-initiated session deletion.
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return respond(405);
    }
    if (this.failure) return respond(503, rpcError(null, this.failure));
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return respond(415);
    const accepts = (req.headers.accept ?? '*/*').split(',').map(item => item.split(';')[0].trim());
    const json = accepts.includes('application/json') || accepts.includes('*/*');
    const sse = !json && accepts.includes('text/event-stream');
    if (!json && !sse) return respond(406);
    let body = '', bytes = 0;
    req.setEncoding('utf8');
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024 * 1024) return respond(413);
      body += chunk;
    }
    let input;
    try { input = JSON.parse(body); }
    catch { return respond(400, rpcError(null, 'Parse error', -32700)); }
    const batch = Array.isArray(input), messages = batch ? input : [input];
    if (!messages.length || !messages.every(valid)) return respond(400, rpcError(null, 'Invalid Request', -32600));
    if (this.failure) return respond(503, rpcError(null, this.failure));
    const initializes = messages.filter(message => message.method === 'initialize' && isRequest(message));
    if (initializes.length > 1) return respond(400, rpcError(null, 'Only one initialize per HTTP request', -32600));
    if (!sessionId && !initializes.length) return respond(400, rpcError(null, 'Mcp-Session-Id required', -32600));
    const session = sessionId ? this.sessions.get(sessionId) : { id: randomUUID(), ids: new Map() };
    const version = req.headers['mcp-protocol-version'];
    if (version && version !== session.version && version !== initializes[0]?.params?.protocolVersion) {
      return respond(400, rpcError(null, 'Unsupported MCP-Protocol-Version', -32600));
    }
    const ids = messages.filter(isRequest).map(message => message.id);
    if (new Set(ids).size !== ids.length || ids.some(id => session.ids.has(id))) {
      return respond(400, rpcError(null, 'Duplicate in-flight request id', -32600));
    }
    // Register every request before writing: fast stdio replies cannot race registration.
    const results = messages.map(message => {
      if (!isRequest(message)) return null;
      return new Promise(resolve => {
        const internalId = ++this.nextId;
        session.ids.set(message.id, internalId);
        this.pending.set(internalId, response => {
          session.ids.delete(message.id);
          resolve({ ...response, id: message.id });
        });
      });
    });
    for (const message of messages) {
      let forwarded = message;
      if (isRequest(message)) forwarded = { ...message, id: session.ids.get(message.id) };
      else if (message.method === 'notifications/cancelled' && session.ids.has(message.params?.requestId)) {
        forwarded = { ...message, params: { ...message.params, requestId: session.ids.get(message.params.requestId) } };
      }
      this.write(forwarded);
    }
    if (!results.some(Boolean)) return respond(202);
    const responses = await Promise.all(results.filter(Boolean));
    let initialized;
    if (initializes.length) {
      initialized = responses.find(response => response.id === initializes[0].id && response.result);
      if (initialized) {
        session.version = initialized.result.protocolVersion;
        this.sessions.set(session.id, session);
      }
    }
    this.reply(res, 200, batch ? responses : responses[0], sse, initialized ? session.id : undefined);
  }
  write(message) {
    if (this.failure) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  receive(message) {
    if (!valid(message)) throw new Error('Invalid MCP message');
    if (typeof message.method === 'string') {
      // Server-push is deliberately unsupported. Fail requests instead of leaving the server hung.
      if (hasId(message)) this.write(rpcError(message.id, 'Server-initiated requests are not supported by this bridge', -32601));
      return;
    }
    const complete = this.pending.get(message.id);
    this.pending.delete(message.id);
    complete?.(message);
  }
  fail(reason) {
    this.failure ??= reason;
    for (const [id, complete] of this.pending) complete(rpcError(id, this.failure));
    this.pending.clear();
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.fail('MCP bridge closed');
      this.server.closeAllConnections();
      await new Promise(resolve => this.server.close(resolve));
      this.child.stdin.end();
      this.child.kill();
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 800);
      await this.exited;
      clearTimeout(timer);
      this.lines.close();
      this.sessions.clear();
    })();
    return this.closing;
  }
}

export class McpBridges {
  constructor() { this.bridges = new Map(); this.closed = false; }
  async rewrite(message) {
    if (!message.method || !Array.isArray(message.params?.mcpServers)) return message;
    const mcpServers = [];
    for (const config of message.params.mcpServers) {
      if (!config.command || config.type && config.type !== 'stdio') { mcpServers.push(config); continue; }
      if (this.closed) throw new Error('MCP bridges stopped');
      // cwd is deliberately not part of identity: reload/resume reuses the first process and its cwd.
      const env = Object.entries(Object.fromEntries((config.env ?? []).map(({ name, value }) => [name, value]))).sort(([a], [b]) => a.localeCompare(b));
      const key = JSON.stringify([config.name, config.command, config.args ?? [], env]);
      let ready = this.bridges.get(key);
      if (!ready) {
        const bridge = new StdioBridge(config, message.params.cwd ?? process.cwd());
        ready = bridge.start().catch(async error => { await bridge.close(); this.bridges.delete(key); throw error; });
        this.bridges.set(key, ready);
      }
      const bridge = await ready;
      if (this.closed) { await bridge.close(); throw new Error('MCP bridges stopped'); }
      mcpServers.push({ type: 'http', name: config.name, url: bridge.url, headers: [] });
    }
    return { ...message, params: { ...message.params, mcpServers } };
  }
  close() {
    this.closed = true;
    return Promise.allSettled([...this.bridges.values()].map(async ready => (await ready).close()));
  }
}
