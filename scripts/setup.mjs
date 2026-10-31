import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { CLI_VERSION, cliEnv, copilotBinary, npmCli } from '../agent/binary.mjs';

try {
  let binary = copilotBinary();
  if (!binary) {
    if (!process.env.CODA_PLUGIN_STATE) throw new Error('缺少 CODA_PLUGIN_STATE：请由 Coda 运行插件 setup');
    const prefix = join(process.env.CODA_PLUGIN_STATE, 'cli');
    mkdirSync(prefix, { recursive: true });
    const installed = spawnSync(process.execPath, [npmCli(), 'install', '--prefix', prefix, '--no-audit', '--no-fund', '--save-exact', `@github/copilot@${CLI_VERSION}`],
      { env: { ...cliEnv(), PATH: `${dirname(process.execPath)}${delimiter}${cliEnv().PATH}` }, stdio: ['ignore', 2, 2] });
    if (installed.status !== 0) throw new Error(`Copilot 安装失败（${installed.error?.message ?? installed.status ?? installed.signal}）`);
    binary = copilotBinary();
  }
  if (!binary) throw new Error('找不到 Copilot 原生执行文件');
  const version = spawnSync(binary, ['--version', '--no-auto-update'], { env: cliEnv(), encoding: 'utf8', timeout: 30_000 });
  if (version.status !== 0) throw new Error(`Copilot 无法运行：${version.error?.message ?? version.stderr ?? version.signal}`);
  console.log(`${version.stdout.trim()}\n${binary}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
