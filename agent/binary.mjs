import { accessSync, constants, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export const CLI_VERSION = '1.0.105';
export function executable(path) {
  try { accessSync(path, constants.X_OK); return path; } catch { return null; }
}
// Use the actual process environment, never an interactive/login shell. Exclude project-relative PATH entries.
export function onPath(name, path = process.env.CODA_USER_PATH ?? process.env.PATH ?? '') {
  return path.split(delimiter).filter(isAbsolute).map(dir => executable(join(dir, name))).find(Boolean) ?? null;
}
export function copilotBinary() {
  const binary = onPath('copilot');
  if (binary) return binary;
  if (!process.env.CODA_PLUGIN_STATE) return null;
  // Run the installed native binary directly: npm-loader.js uses spawnSync, which obscures signal forwarding.
  try {
    const require = createRequire(join(process.env.CODA_PLUGIN_STATE, 'cli', 'package.json'));
    const platform = process.platform === 'linux' && process.report.getReport().header.glibcVersionRuntime === undefined ? 'linuxmusl' : process.platform;
    return executable(require.resolve(`@github/copilot-${platform}-${process.arch}`));
  } catch { return null; }
}
export function npmCli() {
  // Coda ships npm beside its own Node. System npm is only a fallback; run its JS with Coda's Node.
  const npm = executable(join(dirname(process.execPath), 'npm')) ?? onPath('npm');
  if (!npm) throw new Error('找不到 npm：需要 Coda Node 附带的 npm 或运行机 PATH 中的 npm');
  return realpathSync(npm);
}
export const cliEnv = () => ({ ...process.env, PATH: process.env.CODA_USER_PATH ?? process.env.PATH ?? '' });
