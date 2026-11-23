// calmrun (https://github.com/vannt-dev/calmrun), a machine-wide queue for heavy commands. When it
// is installed, `lane with` hands its commands to calmrun and `lane claim` takes a calmrun lease,
// so lane and calmrun share one budget and one emulator instead of two queues blind to each other.
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pidAlive } from './lock-state.ts';

/** calmrun's first version with `--needs`, `--label` and `--wait-timeout`. */
const MIN_VERSION = [0, 2, 0];
/** calmrun's first version with `hold` and `release`. */
const HOLD_VERSION = [0, 3, 0];
/** A calmrun lease lives as long as a lane claim may (see Locks: 3 hours), so no renewing. */
export const CLAIM_TTL_S = 3 * 3600;
/** calmrun's exit code for a wait that ran out (--wait-timeout). */
export const EXIT_WAIT_TIMEOUT = 75;

export interface Calmrun {
  file: string;
  version: number[];
  /** Whether it has `hold` and `release`; found on first use. */
  hold?: boolean;
}

/** `LANE_CALMRUN=0` (or false, no, off): lane keeps its own queue even when calmrun is installed. */
export function calmrunOff(): boolean {
  return ['0', 'false', 'no', 'off'].includes((process.env.LANE_CALMRUN ?? '').trim().toLowerCase());
}

const atLeast = (v: readonly number[], min: readonly number[]) => {
  for (let i = 0; i < min.length; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]!;
  return true;
};

/**
 * A program's full path from PATH: never from the current folder (a repository's own
 * `calmrun.cmd` must not stand in for it), so relative PATH entries are skipped.
 */
export function findOnPath(name: string): string | undefined {
  const win = process.platform === 'win32';
  const exts = win ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const raw of (process.env.PATH ?? '').split(path.delimiter)) {
    const dir = raw.replace(/^"(.*)"$/, '$1');
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** Windows: a .cmd/.bat (the npm shim) runs only through the shell, each argument quoted. */
function spawnTool(file: string, args: readonly string[], opts: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const q = (a: string) => (/^[\w./:=@+\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
    return spawnSync([file, ...args].map(q).join(' '), { ...opts, shell: true });
  }
  return spawnSync(file, args, opts);
}

let probed: { key: string; value: Calmrun | null } | undefined;

/**
 * The calmrun lane can hand work to: on PATH, version 0.2.0 or newer, and not turned off with
 * LANE_CALMRUN (`evenIfOff`: found anyway, to give back a lease taken before). Looked up once
 * per process and PATH.
 */
export function calmrun({ evenIfOff = false } = {}): Calmrun | null {
  if (!evenIfOff && calmrunOff()) return null;
  const key = process.env.PATH ?? '';
  if (probed?.key === key) return probed.value;
  let value: Calmrun | null = null;
  const file = findOnPath('calmrun');
  if (file) {
    const r = spawnTool(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    const m = /calmrun (\d+)\.(\d+)\.(\d+)/.exec(String(r.stdout ?? ''));
    const version = m ? m.slice(1).map(Number) : [];
    if (r.status === 0 && m && atLeast(version, MIN_VERSION)) value = { file, version };
  }
  probed = { key, value };
  return value;
}

export const versionText = (c: Calmrun) => c.version.join('.');

/**
 * Whether this calmrun has `hold` with `--for`: 0.3.0 or newer, or (a build between releases)
 * `hold --help` answers and names --for and --renew. A 0.2.0 runs `hold` as a command (and would
 * queue `hold emulator` as a job): its `hold --help` fails, so it is never called there.
 */
export function canHold(c: Calmrun): boolean {
  if (c.hold === undefined) {
    if (atLeast(c.version, HOLD_VERSION)) c.hold = true;
    else {
      const r = spawnTool(c.file, ['hold', '--help'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      const help = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      c.hold = r.status === 0 && /--for/.test(help) && /--renew/.test(help);
    }
  }
  return c.hold;
}

/** Whether this process runs inside a calmrun job (CALMRUN_HELD names that calmrun, still alive). */
export function insideCalmrun(): boolean {
  const pid = Number(process.env.CALMRUN_HELD);
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid);
}

export interface Job {
  /** `<lane>:<kind>`, seen in `calmrun status` and `calmrun stats`. */
  label: string;
  /** Points; none lets calmrun weigh the command by its own detection. */
  cost?: number;
  prio?: 'high' | 'normal';
  /** A named resource the job also takes (emulator, gpu). */
  needs?: string;
  waitTimeoutS?: number;
  ticket?: number;
}

/** The arguments for calmrun to run `argv` as this job. */
export function jobArgs(job: Job, argv: readonly string[]): string[] {
  const a: string[] = [];
  if (job.ticket !== undefined) a.push('--ticket', String(job.ticket));
  a.push('--label', job.label);
  if (job.cost !== undefined) a.push('--cost', String(job.cost));
  if (job.prio === 'high') a.push('--prio', 'high');
  if (job.needs) a.push('--needs', job.needs);
  if (job.waitTimeoutS !== undefined) a.push('--wait-timeout', String(job.waitTimeoutS));
  return [...a, '--', ...argv];
}

/** Runs the job through calmrun with the terminal passed through; its exit code (128 + n for signal n). */
export function runJob(c: Calmrun, job: Job, argv: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): number {
  const r = spawnTool(c.file, jobArgs(job, argv), { stdio: 'inherit', windowsHide: true, cwd, env });
  if (r.error) {
    console.error(`lane: could not start calmrun (${c.file}): ${r.error.message}`);
    return 1;
  }
  if (r.status === EXIT_WAIT_TIMEOUT && job.waitTimeoutS !== undefined) {
    console.error('lane: calmrun keeps your place for 10 minutes: run the same lane with again, adding ' +
      '--ticket <id> (the id calmrun printed above)');
  }
  if (r.status !== null) return r.status;
  const n = r.signal ? os.constants.signals[r.signal] : undefined;
  return n ? 128 + n : 1;
}

/**
 * Takes a calmrun lease on a resource for a claim, owned by the lane's folder: calmrun jobs that
 * need it wait, except jobs run inside that folder (the lane's own), which use it. Returns the
 * lease id, or the exit code when calmrun gave none (75: still in use when `waitS` ran out; 0
 * tries once).
 */
export function holdLease(c: Calmrun, resource: string, lanePath: string, label: string, waitS?: number): { lease?: string; code: number } {
  const args = ['hold', resource, '--for', lanePath, '--ttl', String(CLAIM_TTL_S), '--label', label];
  if (waitS !== undefined) args.push('--wait-timeout', String(waitS));
  const r = spawnTool(c.file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const lease = String(r.stdout ?? '').trim().split(/\r?\n/).pop()?.trim() ?? '';
  if (r.status === 0 && /^[\w.:-]{1,128}$/.test(lease)) return { lease, code: 0 };
  return { code: r.status ?? 1 };
}

/** Extends a lease by another claim's lifetime from now; false when calmrun no longer has it. */
export function renewLease(c: Calmrun, lease: string): boolean {
  const r = spawnTool(c.file, ['hold', '--renew', lease, '--ttl', String(CLAIM_TTL_S)],
    { stdio: 'ignore', windowsHide: true, timeout: 20_000 });
  return r.status === 0;
}

/** Gives a calmrun lease back; never throws (a lease already gone, or no calmrun, is fine). */
export function releaseLease(lease: string): void {
  const c = calmrun({ evenIfOff: true });
  if (!c || !canHold(c)) return;
  spawnTool(c.file, ['release', lease], { stdio: 'ignore', windowsHide: true, timeout: 20_000 });
}
