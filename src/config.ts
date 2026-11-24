import fs from 'node:fs';
import path from 'node:path';
import { buildSlots } from './heavy.ts';

// Where lane works, from the environment. The two folders have no default: every machine keeps
// its clones somewhere else, and a guessed folder would put slots in the wrong place.
function folder(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: point it at ${FOLDERS[name]} (see lane --help)`);
  return value;
}

/** A folder with links resolved, as far as it exists yet (the rest is kept as written). */
function realFolder(p: string): string {
  let at = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(at) && path.dirname(at) !== at) {
    rest.unshift(path.basename(at));
    at = path.dirname(at);
  }
  try {
    return path.join(fs.realpathSync.native(at), ...rest);
  } catch {
    return path.resolve(p);
  }
}

const FOLDERS: Record<string, string> = {
  LANE_ROOT: 'the folder for the slots, e.g. setx LANE_ROOT D:/wt',
  LANE_REPOS: 'the folder holding the main clones, e.g. setx LANE_REPOS D:/code',
};

export const config = {
  /** The folder that holds the lanes (slots). */
  get root(): string {
    return folder('LANE_ROOT');
  },
  /** The folder that holds the main clones; `<repo>` names one of them. */
  get repos(): string {
    return folder('LANE_REPOS');
  },
  /**
   * A second folder for new slots, used when the drive of the lane root is short of space
   * (LANE_ROOT_SPARE); '' when there is none. Read at each call.
   */
  get spareRoot(): string {
    return process.env.LANE_ROOT_SPARE ?? '';
  },
  /** The lane root, then the spare one if set. Neither may hold the other: `lane clean` would see its slots as leftovers. */
  get roots(): string[] {
    const root = folder('LANE_ROOT');
    const spare = this.spareRoot;
    if (!spare) return [root];
    const norm = (p: string) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '') + path.sep;
    const nested = (x: string, y: string) => norm(x).startsWith(norm(y)) || norm(y).startsWith(norm(x));
    // as typed, and as the folders really are: a junction or symlink may put one inside the other
    if (nested(root, spare) || nested(realFolder(root), realFolder(spare))) {
      throw new Error(`LANE_ROOT_SPARE (${spare}) must be a folder of its own, not LANE_ROOT (${root}) nor inside or around it`);
    }
    return [root, spare];
  },
  /**
   * Free space a drive must have for a new slot, in GB (LANE_MIN_FREE_GB). Not set: 10 with a
   * spare root, else 0 (no check). Read at each call.
   */
  get minFreeGb(): number {
    const n = Number(process.env.LANE_MIN_FREE_GB);
    if (process.env.LANE_MIN_FREE_GB && n >= 0) return n;
    return this.spareRoot ? 10 : 0;
  },
  /** Slots per repository; a full pool lists who holds what instead of taking a slot. */
  maxSlots: Number(process.env.LANE_MAX_SLOTS || 4),
  /** Ports per slot: slot n owns the usual port + n x stride, up to stride ports. */
  portStride: Number(process.env.LANE_PORT_STRIDE || 10),
  /** npm dependencies as hard links from a lane on the same lockfile (`--link-deps` for one lane). */
  linkDeps: process.env.LANE_LINK_DEPS === '1',
  /**
   * Backups kept per lane of work thrown away (LANE_KEEP_BACKUPS, default 10; 0: none are
   * made). Read at each call.
   */
  get keepBackups(): number {
    const n = Number(process.env.LANE_KEEP_BACKUPS);
    return process.env.LANE_KEEP_BACKUPS && Number.isInteger(n) && n >= 0 ? n : 10;
  },
};

/**
 * Slots per repository in a pool: `LANE_POOLS="review=2,ci=1"` names a pool's own max, any
 * other pool (and the default one) has LANE_MAX_SLOTS. Read at each call.
 */
export function poolMax(pool: string): number {
  for (const part of (process.env.LANE_POOLS ?? '').split(',')) {
    const [name, n] = part.split('=').map((s) => s.trim());
    if (pool && name === pool && Number(n) > 0) return Number(n);
  }
  return config.maxSlots;
}

/** A pool name: short, lowercase, so it reads well in `lane list` and in LANE_POOLS. */
export function poolName(name: string | undefined): string {
  if (!name) return '';
  if (!/^[a-z0-9][a-z0-9-]{0,19}$/.test(name)) throw new Error(`--pool takes a short lowercase name like review: "${name}" is not one`);
  return name;
}

/**
 * Speed flags passed per command, never written to the repository's config: checkout with
 * all cores, and remember which folders have no untracked files.
 */
export const FAST = ['-c', 'checkout.workers=0', '-c', 'core.untrackedCache=true'];

/** The repository's hooks off: lane's own merges and rebases are not commits for review. */
export const NO_HOOKS = ['-c', 'core.hooksPath=.lane-no-hooks', '-c', 'user.name=lane', '-c', 'user.email=lane@localhost'];

/**
 * Untracked files worth carrying over from the main clone. A repository adds more, one path
 * per line, in an untracked `.lanecopy` file at its root.
 */
export const COPY_DEFAULT = ['.env', '.env.local', 'android/key.properties', '.claude/settings.local.json'];

/**
 * Slots of a `lane with` resource: `LANE_WITH_SLOTS="build=6,gpu=2"` sets them, else build has
 * as many as the machine suits (see buildSlots: cores less 2, one per 4 GB of RAM, at least 2)
 * and any other resource 1. Read at each call; `--slots` overrides it for one command.
 */
export function withSlotsFor(resource: string): number {
  for (const part of (process.env.LANE_WITH_SLOTS ?? '').split(',')) {
    const [name, n] = part.split('=').map((s) => s.trim());
    if (name === resource && Number.isInteger(Number(n)) && Number(n) > 0) return Number(n);
  }
  return resource === 'build' ? buildSlots() : 1;
}
