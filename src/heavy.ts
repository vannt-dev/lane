// What a heavy command is, for `lane with`: its kind (from the command itself), what it costs
// by default, the extra rules some kinds follow, and the memory the machine has left.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryRun } from './proc.ts';

export type Kind = 'vitest' | 'jest' | 'tsc' | 'build' | 'capture' | 'docker' | 'eslint' | 'pytest' | 'test';

/** Slots a kind takes when no --cost is given; a kind not listed, and an unknown command, take 1. */
export const KIND_COST: Partial<Record<Kind, number>> = { vitest: 2, jest: 2, tsc: 2, build: 2, capture: 2, docker: 2 };

/** The words of a command: a single string is split the way a shell would at spaces. */
function words(argv: readonly string[]): string[] {
  const list = argv.length === 1 ? (argv[0] ?? '').trim().split(/\s+/) : [...argv];
  return list.map((w) => path.basename(w.replace(/\\/g, '/')).replace(/\.(cmd|bat|exe|ps1|js|mjs|cjs)$/i, '').toLowerCase());
}

/** The kind of a command from the tools it names, or undefined for anything else. */
export function detectKind(argv: readonly string[]): Kind | undefined {
  const w = words(argv);
  const has = (...names: string[]) => names.some((n) => w.includes(n));
  const after = (tool: string, sub: string) => w.some((x, i) => x === tool && w.slice(i + 1).includes(sub));
  if (has('vitest')) return 'vitest';
  if (has('jest')) return 'jest';
  if (has('tsc', 'vue-tsc', 'tsgo')) return 'tsc';
  if (has('playwright', 'puppeteer', 'cypress')) return 'capture';
  if (has('docker-compose') || after('docker', 'compose') || after('docker', 'build') || after('docker', 'run')) return 'docker';
  if (has('eslint', 'oxlint', 'biome')) return 'eslint';
  if (has('pytest')) return 'pytest';
  if (after('vite', 'build') || after('next', 'build') || has('webpack', 'rollup', 'esbuild', 'gradlew', 'gradle', 'mvn') ||
    after('cargo', 'build') || after('flutter', 'build') || after('dotnet', 'build') || after('ng', 'build')) return 'build';
  if (after('cargo', 'test') || after('go', 'test') || after('flutter', 'test') || after('dotnet', 'test') || after('npm', 'test')) {
    return 'test';
  }
  return undefined;
}

/** The cost of a command: --cost when given, else its kind's, never more than the slots. */
export function costFor(kind: Kind | undefined, slots: number, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  return Math.min(KIND_COST[kind ?? 'test'] ?? 1, slots);
}

/** Workers for a test runner: LANE_VITEST_WORKERS, else 1 up to 4 cores, 2 up to 11, then 3. */
export function vitestWorkers(cores = os.availableParallelism()): number {
  const set = Number(process.env.LANE_VITEST_WORKERS);
  if (Number.isInteger(set) && set > 0) return set;
  return cores <= 4 ? 1 : cores < 12 ? 2 : 3;
}

/**
 * The command as it will run. vitest started directly (`vitest ...`, `npx vitest ...`, given as
 * separate words) gets `--maxWorkers=N` unless it sets its own workers; a command line given as
 * one string, or a package script, is never rewritten. `docker compose up` without `-d` is
 * refused: it would hold its slots until someone stops it.
 */
export function prepareArgv(argv: readonly string[]): string[] {
  const w = words(argv);
  const composeUp = (w.includes('docker-compose') || w.some((x, i) => x === 'docker' && w[i + 1] === 'compose')) && w.includes('up');
  if (composeUp && !w.includes('-d') && !w.includes('--detach')) {
    throw new Error('docker compose up holds its slots until it is stopped: add -d (or --detach)');
  }
  if (argv.length < 2) return [...argv];
  const runner = ['npx', 'pnpx', 'bunx'].includes(w[0] ?? '') || (['pnpm', 'yarn'].includes(w[0] ?? '') && w[1] === 'exec');
  const at = w[0] === 'vitest' ? 0 : runner ? w.indexOf('vitest') : -1;
  if (at < 0 || at > 2) return [...argv];
  if (argv.some((a) => /^--(maxWorkers|max-workers|pool|no-file-parallelism|fileParallelism)\b/.test(a))) return [...argv];
  return [...argv, `--maxWorkers=${vitestWorkers()}`];
}

/**
 * A lock name for the dependencies a command uses, so two test runs or builds never share one
 * node_modules at once: `deps-` and a short hash of its real path, or undefined when there is none.
 */
export function depsLockName(kind: Kind | undefined, cwd: string): string | undefined {
  if (kind !== 'vitest' && kind !== 'jest' && kind !== 'build') return undefined;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const nm = path.join(dir, 'node_modules');
    if (fs.existsSync(nm)) {
      let real = nm;
      try {
        real = fs.realpathSync.native(nm);
      } catch {
        // a broken link: the path as written still names it
      }
      return `deps-${crypto.createHash('sha1').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 12)}`;
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * Memory programs can still get, in bytes. Linux: MemAvailable; macOS: free, inactive and
 * speculative pages (os.freemem counts only free ones there, far too low); elsewhere os.freemem.
 */
export function availableMemory(): number {
  if (process.platform === 'linux') {
    try {
      const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (m) return Number(m[1]) * 1024;
    } catch {
      // no /proc: fall through
    }
  }
  if (process.platform === 'darwin') {
    const out = tryRun('vm_stat', []);
    const page = Number(/page size of (\d+) bytes/.exec(out ?? '')?.[1]);
    const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(out ?? '')?.[1] ?? 0);
    if (out && page > 0) return (pages('free') + pages('inactive') + pages('speculative')) * page;
  }
  return os.freemem();
}

const GB = 1024 ** 3;

/**
 * Memory that must stay free before another command starts beside a running one, in bytes:
 * LANE_WITH_MIN_FREE_GB (0 turns the check off), else an eighth of the RAM and at least 3 GB.
 */
export function minFreeMemory(total = os.totalmem()): number {
  const raw = process.env.LANE_WITH_MIN_FREE_GB;
  if (raw !== undefined && raw.trim() !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw) * GB;
  return Math.max(3 * GB, total / 8);
}

/**
 * Slots of `build` for this machine when LANE_WITH_SLOTS does not set them: logical cores less
 * 2, no more than one per 4 GB of RAM, at least 2.
 */
export function buildSlots(cores = os.availableParallelism(), total = os.totalmem()): number {
  return Math.max(2, Math.min(cores - 2, Math.floor(total / (4 * GB))));
}

/** How long a waiter may be passed by later, lighter ones (LANE_WITH_PASS_MIN minutes, 0: never). */
export function passLimitMs(): number {
  const raw = Number(process.env.LANE_WITH_PASS_MIN);
  return (Number.isFinite(raw) && raw >= 0 && process.env.LANE_WITH_PASS_MIN?.trim() ? raw : 10) * 60_000;
}

export const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;
