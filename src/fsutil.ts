// Paths and folder removal, with Windows' quirks handled.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { errCode, sleepMs, tryRun } from './proc.ts';
import { log } from './text.ts';

/** Case- and slash-insensitive path compare, as Windows sees paths. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase().replace(/[\\/]+$/, '') + path.sep;
  return c.startsWith(p);
}

/**
 * Which lane root a path is under: 0 the lane root, 1 the spare one, -1 none. Git prints long
 * paths; a root may be given in another form of the same folder (a Windows 8.3 short name such
 * as RUNNER~1, a symlink), so compare both.
 */
export function rootIndex(p: string): number {
  return config.roots.findIndex((root) => {
    if (isInside(p, root)) return true;
    try {
      return isInside(p, fs.realpathSync.native(root));
    } catch {
      return false;
    }
  });
}

/** Whether a path is under a lane root (the spare one counts). */
export const underRoot = (p: string) => rootIndex(p) >= 0;

/** The nearest folder of `dir` that exists: itself, or the parent it will be made in. */
function existing(dir: string): string {
  let at = path.resolve(dir);
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}

/** Facts about drives; a test may replace either. */
export const disk = {
  /** GB free for this user where `dir` is, or will be; null when it cannot be read. */
  freeGb(dir: string): number | null {
    try {
      const s = fs.statfsSync(existing(dir));
      return (s.bavail * s.bsize) / 1024 ** 3;
    } catch {
      return null;
    }
  },
  /** Whether two folders (made or to be made) are on one drive: a rename can move between them. */
  sameDrive(a: string, b: string): boolean {
    return fs.statSync(existing(a)).dev === fs.statSync(existing(b)).dev;
  },
};

/**
 * The root for a new slot: the first one whose drive has `minFreeGb` free (a drive that cannot
 * be read counts as having room). No check with `minFreeGb` 0. Throws with the figures when no
 * root has room: a slot made on a full drive fails halfway through its checkout or install.
 */
export function rootForNewSlot(roots: readonly string[], minFreeGb: number): string {
  const first = roots[0];
  if (first === undefined) throw new Error('no lane root');
  if (minFreeGb <= 0) return first;
  const seen: string[] = [];
  for (const root of roots) {
    const free = disk.freeGb(root);
    if (free === null || free >= minFreeGb) {
      if (root !== first) log(`disk: ${seen.join(', ')}, under ${minFreeGb} GB: the new slot goes to ${root}`);
      return root;
    }
    seen.push(`${root} has ${free.toFixed(1)} GB free`);
  }
  const spare = roots.length > 1 ? '' : ', or name a folder on another drive in LANE_ROOT_SPARE';
  throw new Error(`no room for a new slot: ${seen.join(', ')}, under ${minFreeGb} GB (LANE_MIN_FREE_GB). ` +
    `Free some space (lane clean, lane rm)${spare}`);
}

/** Deletes a folder; on Windows through the \\?\ form so long paths (node_modules, Gradle) work. */
export function rmFolder(dir: string): void {
  const target = process.platform === 'win32' ? '\\\\?\\' + path.resolve(dir) : dir;
  fs.rmSync(target, { recursive: true, force: true });
}

/** adb is often not on PATH; look in the usual Android SDK places too. */
function findAdb(): string | null {
  if (tryRun('adb', ['version']) !== null) return 'adb';
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const local = process.env.LOCALAPPDATA;
  const sdks = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, local && path.join(local, 'Android', 'Sdk')];
  return sdks
    .filter((s): s is string => Boolean(s))
    .map((s) => path.join(s, 'platform-tools', exe))
    .find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Deletes a lane folder and checks that it is gone: Windows may report success yet keep a
 * folder another program still has open. The usual one is the adb server (any `adb` command
 * starts it there); stopping it is harmless, the next adb command starts a new one.
 */
export function rmLaneFolder(dir: string): boolean {
  const gone = () => {
    try {
      rmFolder(dir);
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(errCode(e) ?? '')) throw e;
    }
    return !fs.existsSync(dir);
  };
  if (gone()) return true;
  const adb = findAdb();
  if (adb && tryRun(adb, ['kill-server']) !== null) {
    log('the folder was in use; stopped the adb server and tried again');
    sleepMs(1000);
    if (gone()) return true;
  }
  log(`WARNING: ${dir} is still in use by a running program; close it, then run: lane clean --yes`);
  return false;
}

/** Folders under the lane roots that no repository knows as a worktree (a failed removal's leftovers). */
export function leftovers(knownNames: readonly string[]): string[] {
  const known = new Set(knownNames.map((n) => n.toLowerCase()));
  return config.roots.filter((root) => fs.existsSync(root)).flatMap((root) =>
    fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !known.has(e.name.toLowerCase()))
      .map((e) => path.join(root, e.name)));
}
