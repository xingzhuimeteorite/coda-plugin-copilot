// Resources panel: the Copilot account this machine's Copilot CLI is signed in as, and its live AI Credits quota.
// Identity comes from Copilot itself (auth.getStatus); the quota from GitHub's /copilot_internal/user with that same
// credential. Copilot's own cached quota (account.getQuota) lags behind, so it is not shown.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cliEnv, copilotBinary } from '../agent/binary.mjs';
import { askCopilot } from '../agent/headless.mjs';

const ENV_TOKENS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
const USAGE_URL = 'https://github.com/settings/billing/ai_usage';
const format = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);

export function hostName(host = 'https://github.com') {
  const name = new URL(/^https?:\/\//.test(host) ? host : `https://${host}`).hostname;
  if (!/^[a-z0-9.-]+$/i.test(name)) throw new Error('Copilot 报告的 GitHub 主机无效');
  return name;
}

// Copilot's own precedence (`copilot help environment`): these variables, then a `copilot login`, then gh's login.
export async function readUser(status, { env = cliEnv(), fetchImpl = fetch, gh = ghApi } = {}) {
  const host = hostName(status.host);
  if (status.authType === 'gh-cli') return gh(host);
  if (status.authType === 'env') {
    const name = ENV_TOKENS.find(key => env[key]);
    if (!name) throw new Error('Copilot 使用环境变量中的令牌，但面板进程里没有这个变量');
    const api = host === 'github.com' ? 'https://api.github.com' : `https://api.${host}`;
    const response = await fetchImpl(`${api}/copilot_internal/user`, {
      headers: { authorization: `token ${env[name]}`, accept: 'application/json', 'user-agent': 'coda-copilot-plugin' },
      signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`GitHub 拒绝读取额度（HTTP ${response.status}）`);
    return response.json();
  }
  return null;
}

function ghApi(host) {
  try {
    return JSON.parse(execFileSync('gh', ['api', '--hostname', host, '/copilot_internal/user'],
      { env: cliEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }));
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim().split('\n').pop();
    throw new Error(`经 gh 读取额度失败：${detail}`);
  }
}

const card = (login, items) => ({ items: [{ type: 'card', title: login, subtitle: 'Copilot · AI Credits', identity: `github-copilot:${login}`, items }] });
const link = { type: 'markdown', text: `[GitHub 官方用量](${USAGE_URL})` };

export function panel(status, user) {
  if (!status?.isAuthenticated || !status.login) return { items: [] };
  if (!user) {
    const text = status.authType === 'user'
      ? 'Copilot 使用自己的登录（copilot login），面板不读取它保存的凭据，因此没有实时额度。'
      : `Copilot 的登录方式（${status.authType ?? '未知'}）没有可读的额度。`;
    return card(status.login, [{ type: 'error', text }, link]);
  }
  if (user.login !== status.login) throw new Error(`Copilot 登录的是 ${status.login}，额度查到的却是 ${user.login}`);
  const quota = user.quota_snapshots?.premium_interactions;
  if (!quota) return card(status.login, [{ type: 'error', text: 'GitHub 没有返回这个账号的 Copilot 额度。' }, link]);
  if (quota.unlimited) return card(status.login, [{ type: 'stat', label: '额度', value: '不限量' }, link]);
  const total = quota.entitlement, remaining = quota.quota_remaining ?? quota.remaining;
  if (![total, remaining].every(Number.isFinite) || total < 0) throw new Error('GitHub 返回的额度数据格式不正确');
  const left = Math.max(0, remaining);
  const reset = Date.parse(user.quota_reset_date_utc ?? user.quota_reset_date);
  return card(status.login, [
    { type: 'meter', label: '剩余额度', value: `${format(left)} / ${format(total)}`, fraction: total ? Math.min(1, left / total) : 0,
      ...(Number.isFinite(reset) ? { time: new Date(reset).toISOString(), timeLabel: '额度重置' } : {}) },
    { type: 'stat', label: '本月已用', value: format(Math.max(0, total - remaining)) },
    ...(quota.overage_count > 0 ? [{ type: 'stat', label: '超出套餐', value: format(quota.overage_count) }] : []),
    link]);
}

async function main() {
  const binary = copilotBinary();
  if (!binary) throw new Error('找不到 Copilot CLI；请在「设置 › 插件」重新准备 GitHub Copilot。');
  const { 'auth.getStatus': status } = await askCopilot(binary, ['auth.getStatus']);
  const user = status?.isAuthenticated ? await readUser(status) : null;
  console.log(JSON.stringify(panel(status, user)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
