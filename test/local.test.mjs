import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionInstructions } from '../agent/instructions.mjs';
import { copilotBinary, onPath } from '../agent/binary.mjs';

test('session instructions precede only the first non-command prompt; resumed sessions do not repeat them', () => {
  const relay = new SessionInstructions();
  relay.fromCoda({ id: 1, method: 'initialize', params: {} });
  assert(relay.fromAgent({ id: 1, result: {} }).result.agentCapabilities.sessionCapabilities.systemPrompt);
  const params = { cwd: '/tmp', systemPrompt: { mode: 'append', content: [{ type: 'text', text: 'Coda rules' }] } };
  assert.equal(relay.fromCoda({ id: 2, method: 'session/new', params }).agent.params.systemPrompt, undefined);
  relay.fromAgent({ id: 2, result: { sessionId: 'new' } });
  const prompt = text => ({ id: 3, method: 'session/prompt', params: { sessionId: 'new', prompt: [{ type: 'text', text }] } });
  assert.deepEqual(relay.fromCoda(prompt('/help')).agent, prompt('/help'));
  assert.match(relay.fromCoda(prompt('Hello')).agent.params.prompt[0].text, /Coda rules/);
  assert.deepEqual(relay.fromCoda(prompt('Again')).agent, prompt('Again'));
  relay.fromCoda({ id: 4, method: 'session/load', params: { ...params, sessionId: 'loaded' } });
  relay.fromAgent({ id: 4, result: {} });
  const loaded = { method: 'session/prompt', params: { sessionId: 'loaded', prompt: [{ type: 'text', text: 'Resume' }] } };
  assert.deepEqual(relay.fromCoda(loaded).agent, loaded);
  const bad = relay.fromCoda({ id: 5, method: 'session/new', params: { systemPrompt: { mode: 'override', content: [] } } });
  assert.equal(bad.coda.error.code, -32602);
});

test('PATH Copilot takes precedence; empty or relative PATH segments never resolve project files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-path-'));
  mkdirSync(join(dir, 'bin'));
  const binary = join(dir, 'bin', 'copilot'); writeFileSync(binary, '#!/bin/sh\nexit 0\n'); chmodSync(binary, 0o755);
  assert.equal(onPath('copilot', `.:${join(dir, 'bin')}`), binary);
  assert.equal(onPath('copilot', ':'), null);
  const before = process.env.CODA_USER_PATH;
  try { process.env.CODA_USER_PATH = join(dir, 'bin'); assert.equal(copilotBinary(), binary); }
  finally { if (before === undefined) delete process.env.CODA_USER_PATH; else process.env.CODA_USER_PATH = before; }
});
