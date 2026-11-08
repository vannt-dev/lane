// Running programs. Everything else goes through these few functions.
import { spawnSync } from 'node:child_process';
import { gitEnv } from './git-env.ts';

/**
 * Runs a program without a shell, `input` on its stdin; returns trimmed stdout, throws with
 * stderr on failure. The buffer is large: `git log -p` of a busy branch is many megabytes.
 * A call that names a folder drops the repository variables a git hook exports (lane runs
 * inside wrapped hooks), because they would point git back at the hook's repository.
 */
export function run(cmd: string, args: readonly string[], cwd?: string, input?: string): string {
  const env = cwd === undefined ? undefined : gitEnv();
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})${msg ? `: ${msg}` : ''}`);
  }
  return r.stdout.trim();
}

/** Like run, but null instead of an error. */
export function tryRun(cmd: string, args: readonly string[], cwd?: string, input?: string): string | null {
  try {
    return run(cmd, args, cwd, input);
  } catch {
    return null;
  }
}

/**
 * Runs a fixed command line through the shell with its output shown live (npm, pnpm and
 * flutter are .cmd/.bat files on Windows, so they need a shell). Only for commands built
 * in this package, never for user text. It always runs in a lane folder, so like run() it
 * drops a hook's repository variables (git submodule update would act on the hook's repo).
 */
export function runLive(commandLine: string, cwd: string): boolean {
  return spawnSync(commandLine, { cwd, env: gitEnv(), shell: true, stdio: 'inherit', windowsHide: true }).status === 0;
}

/**
 * Runs a command given as argv. One element = a command line for the shell, as typed.
 * Several = run directly, so characters like > or & stay literal; Windows .cmd/.bat tools
 * cannot run without a shell, so they get one with each argument quoted.
 */
export function runArgv(argv: readonly string[], cwd?: string): number {
  const [cmd, ...args] = argv;
  if (cmd === undefined) throw new Error('no command given');
  const opts = { stdio: 'inherit', windowsHide: true, cwd } as const;
  if (args.length === 0) return spawnSync(cmd, { ...opts, shell: true }).status ?? 1;
  let r = spawnSync(cmd, args, opts);
  const code = errCode(r.error);
  if (r.error && process.platform === 'win32' && (code === 'ENOENT' || code === 'EINVAL')) {
    const q = (a: string) => (/^[\w./:=@+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
    r = spawnSync(argv.map(q).join(' '), { ...opts, shell: true });
  }
  return r.error ? 1 : (r.status ?? 1);
}

/** The `code` of a Node system error, if it has one. */
export function errCode(e: unknown): string | undefined {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

/** Blocks for a while (the CLI is synchronous by design). */
export function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
