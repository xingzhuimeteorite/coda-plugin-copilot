// Coda's session instructions (docs/agent-protocol.md「会话指令」) for an agent whose own ACP does not take `systemPrompt`: the
// entry declares that it does, keeps the parameter from the agent, and puts the text in front of the first prompt of a
// session the agent opened new, as a part of its own; a session it loaded has had them. A slash command is the agent's to
// read as one: the instructions wait for the next prompt. Kept the same in every plugin that relays a CLI's ACP.
const record = value => value && typeof value === 'object' && !Array.isArray(value);

// ACP's `systemPrompt`: its text, '' when there is none; throws on anything but text appended to the agent's own.
export function sessionInstructions(systemPrompt) {
  if (systemPrompt === undefined || systemPrompt === null) return '';
  if (systemPrompt.mode !== 'append') throw new Error('会话指令只支持 append 模式');
  const { content } = systemPrompt;
  if (!Array.isArray(content) || content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) throw new Error('会话指令只接受文本块');
  return content.map(block => block.text).join('\n\n');
}

// The part in front of the user's input: delimited, and said to be the client's, not the user's.
const OPENING = '<coda-session-instructions>';
export const instructionsBlock = text => ({ type: 'text', text: `${OPENING}\n`
  + 'Instructions from Coda, the client this session runs in, for the whole session. They are not part of the user\'s message.\n\n'
  + `${text}\n</coda-session-instructions>\n` });

export class SessionInstructions {
  // Coda's requests whose answers are read here, by id; the instructions of a session yet to have its first prompt.
  constructor() { this.asked = new Map(); this.waiting = new Map(); }
  // What Coda says: `agent`, what the agent is told, or `coda`, Coda's answer given here instead.
  fromCoda(message) {
    const { id, method, params } = message;
    if (!record(params)) return { agent: message };
    if (method === 'initialize' && id !== undefined) this.asked.set(id, { initialize: true });
    if (method === 'session/new' || method === 'session/load') {
      let text;
      try { text = sessionInstructions(params.systemPrompt); }
      catch (error) { return { coda: { jsonrpc: '2.0', id, error: { code: -32602, message: error.message } } }; }
      const { systemPrompt, ...rest } = params;
      if (method === 'session/new' && text && id !== undefined) this.asked.set(id, { text });
      return { agent: { ...message, params: rest } };
    }
    if (method === 'session/prompt' && Array.isArray(params.prompt) && this.waiting.has(params.sessionId)) {
      const first = params.prompt.find(block => block?.type === 'text');
      if (typeof first?.text === 'string' && first.text.trimStart().startsWith('/')) return { agent: message };
      const text = this.waiting.get(params.sessionId);
      this.waiting.delete(params.sessionId);
      return { agent: { ...message, params: { ...params, prompt: [instructionsBlock(text), ...params.prompt] } } };
    }
    return { agent: message };
  }
  // What the agent says, as said to Coda. A title the agent took from the first prompt's text begins with the instructions,
  // not with what the user asked: it is left out, and the session keeps the title Coda gives it.
  fromAgent(message) {
    const update = message?.method === 'session/update' && record(message.params) ? message.params.update : null;
    if (record(update) && update.sessionUpdate === 'session_info_update' && typeof update.title === 'string' && update.title.trimStart().startsWith(OPENING)) {
      const { title, ...rest } = update;
      return { ...message, params: { ...message.params, update: rest } };
    }
    if (!record(message) || !('id' in message) || 'method' in message) return message;
    const asked = this.asked.get(message.id);
    if (!asked) return message;
    this.asked.delete(message.id);
    if (!record(message.result)) return message;
    if (asked.text) {
      if (typeof message.result.sessionId === 'string') this.waiting.set(message.result.sessionId, asked.text);
      return message;
    }
    const capabilities = record(message.result.agentCapabilities) ? message.result.agentCapabilities : {};
    const sessions = record(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
    return { ...message, result: { ...message.result, agentCapabilities: { ...capabilities, sessionCapabilities: { ...sessions, systemPrompt: {} } } } };
  }
}
