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
 * Whether a path is under the lane root. Git prints long paths; the root may be given in another
 * form of the same folder (a Windows 8.3 short name such as RUNNER~1, a symlink), so compare both.
 */
export function underRoot(p: string): boolean {
  if (isInside(p, config.root)) return true;
  try {
    return isInside(p, fs.realpathSync.native(config.root));
  } catch {
    return false;
  }
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

/** Folders under the lane root that no repository knows as a worktree (a failed removal's leftovers). */
export function leftovers(knownNames: readonly string[]): string[] {
  if (!fs.existsSync(config.root)) return [];
  const known = new Set(knownNames.map((n) => n.toLowerCase()));
  return fs.readdirSync(config.root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !known.has(e.name.toLowerCase()))
    .map((e) => path.join(config.root, e.name));
}
