import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostName, panel, readUser } from '../scripts/panel.mjs';

const status = { isAuthenticated: true, authType: 'gh-cli', host: 'https://github.com', login: 'octo' };
const user = (quota, extra = {}) => ({ login: 'octo', quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
  quota_snapshots: { premium_interactions: { entitlement: 7000, quota_remaining: 4000.5, unlimited: false, overage_count: 0, ...quota } }, ...extra });

test('signed-out Copilot shows nothing, so the panel is hidden', () => {
  assert.deepEqual(panel({ isAuthenticated: false }, null), { items: [] });
});

test('live quota: remaining meter with reset time, used, account identity', () => {
  const [card] = panel(status, user()).items;
  assert.equal(card.identity, 'github-copilot:octo');
  assert.deepEqual(card.items[0], { type: 'meter', label: '剩余额度', value: '4,000.5 / 7,000', fraction: 4000.5 / 7000,
    time: '2026-11-01T00:00:00.000Z', timeLabel: '额度重置' });
  assert.deepEqual(card.items[1], { type: 'stat', label: '本月已用', value: '2,999.5' });
  assert.equal(card.items.some(i => i.type === 'button'), false);
});

test('overage, unlimited, and exhausted quotas', () => {
  const over = panel(status, user({ quota_remaining: -10, overage_count: 10 })).items[0].items;
  assert.equal(over[0].fraction, 0);
  assert.deepEqual(over[2], { type: 'stat', label: '超出套餐', value: '10' });
  assert.deepEqual(panel(status, user({ unlimited: true })).items[0].items[0], { type: 'stat', label: '额度', value: '不限量' });
});

test('quota of another account than Copilot signs in as is refused', () => {
  assert.throws(() => panel(status, { ...user(), login: 'someone' }), /octo.*someone/);
});

test('copilot login credentials are not read; the card says why', () => {
  const [card] = panel({ ...status, authType: 'user' }, null).items;
  assert.match(card.items[0].text, /copilot login/);
});

test('reads through the source Copilot authenticates with', async () => {
  let asked;
  assert.equal((await readUser(status, { gh: host => { asked = host; return 'gh'; } })), 'gh');
  assert.equal(asked, 'github.com');
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, init.headers.authorization]); return { ok: true, json: async () => 'env' }; };
  const env = { GH_TOKEN: 'b', COPILOT_GITHUB_TOKEN: 'a' };
  assert.equal(await readUser({ ...status, authType: 'env' }, { env, fetchImpl }), 'env');
  assert.deepEqual(calls, [['https://api.github.com/copilot_internal/user', 'token a']]);
  await readUser({ ...status, authType: 'env', host: 'https://acme.ghe.com' }, { env: { GITHUB_TOKEN: 'c' }, fetchImpl });
  assert.equal(calls[1][0], 'https://api.acme.ghe.com/copilot_internal/user');
  await assert.rejects(readUser({ ...status, authType: 'env' }, { env: {}, fetchImpl }), /没有这个变量/);
  assert.equal(await readUser({ ...status, authType: 'user' }, { gh: () => assert.fail('gh must not be used') }), null);
  assert.throws(() => hostName('https://exa mple.com'));
});

test('panel output passes the Coda runtime panel rules', { skip: !process.env.CODA_RUNTIME }, async () => {
  const { panelItems, panelDeclarations } = await import(`${process.env.CODA_RUNTIME}/src/resources/plugins/resources/panels/rules.mjs`);
  const [declared] = panelDeclarations(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).contributes.panels);
  for (const output of [panel(status, user()), panel(status, user({ quota_remaining: -1, overage_count: 1 })),
    panel(status, user({ unlimited: true })), panel({ ...status, authType: 'user' }, null), panel({ isAuthenticated: false }, null)]) {
    panelItems(JSON.stringify(output), declared);
  }
  assert.equal(declared.maxAgeMs, 300_000);
});
