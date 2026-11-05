import { spawnSync } from 'node:child_process';

/** Run a program without a shell; returns trimmed stdout, throws with stderr on failure. */
export function run(cmd: string, args: readonly string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})${msg ? `: ${msg}` : ''}`);
  }
  return r.stdout.trim();
}

/** Like run, but null instead of an error. */
export function tryRun(cmd: string, args: readonly string[], cwd?: string): string | null {
  try {
    return run(cmd, args, cwd);
  } catch {
    return null;
  }
}

export const git = (cwd: string, ...args: string[]): string => run('git', args, cwd);
export const gitTry = (cwd: string, ...args: string[]): string | null => tryRun('git', args, cwd);

/**
 * Run a fixed command line through the shell with output shown live
 * (npm, pnpm and flutter are .cmd/.bat files on Windows, so they need a shell).
 * Only ever called with commands built in this package, never with user text.
 */
export function runLive(commandLine: string, cwd: string): boolean {
  const r = spawnSync(commandLine, { cwd, shell: true, stdio: 'inherit', windowsHide: true });
  return r.status === 0;
}

/** The `code` of a Node system error, if it has one. */
export function errCode(e: unknown): string | undefined {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

/** Block for a while (the CLI is synchronous by design). */
export function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
