import { spawnSync } from 'node:child_process';

/** Run a program without a shell; returns trimmed stdout, throws with stderr on failure. */
export function run(cmd, args, { cwd, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.error) {
    if (allowFail) return null;
    throw r.error;
  }
  if (r.status !== 0) {
    if (allowFail) return null;
    const msg = (r.stderr || r.stdout || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})${msg ? `: ${msg}` : ''}`);
  }
  return r.stdout.trim();
}

export const git = (cwd, ...args) => run('git', args, { cwd });
export const gitTry = (cwd, ...args) => run('git', args, { cwd, allowFail: true });

/**
 * Run a fixed command line through the shell with output shown live
 * (npm, pnpm and flutter are .cmd/.bat files on Windows, so they need a shell).
 * Only ever called with commands built in this package, never with user text.
 */
export function runLive(commandLine, cwd) {
  const r = spawnSync(commandLine, { cwd, shell: true, stdio: 'inherit', windowsHide: true });
  return r.status === 0;
}
