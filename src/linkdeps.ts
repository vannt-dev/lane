// Dependencies from a sibling slot: a new lane's node_modules made of hard links to the files
// of a lane installed from the same lockfile. Each lane owns its folders (deleting one, or
// `npm ci`, touches that lane only); only the file contents are shared on disk. Never a
// junction to a shared folder: `rm -rf node_modules/` through one empties it for every lane.
import fs from 'node:fs';
import path from 'node:path';
import { installStamp, LOCKFILES } from './detect.ts';
import type { Lane } from './lane.ts';

/** Folders in node_modules that tools write while they run: each lane makes its own. */
const OWN = new Set(['.cache', '.vite', '.vite-temp', '.vitest']);

/** The stamp of a checkout's lockfiles as they are now (what a slot records after installing). */
export function lockStamp(dir: string): string {
  const present = LOCKFILES.filter((f) => fs.existsSync(path.join(dir, f)));
  return installStamp(present.map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') })));
}

/**
 * Every node_modules folder npm installs for a lockfile: the root one and those of workspaces
 * whose packages were not hoisted (`packages/react/node_modules/...` keys of `packages`).
 */
export function nodeModulesDirs(lockText: string): string[] {
  const out = new Set(['node_modules']);
  let keys: string[] = [];
  try {
    keys = Object.keys((JSON.parse(lockText) as { packages?: Record<string, unknown> }).packages ?? {});
  } catch {
    return [...out];
  }
  for (const k of keys) {
    const at = k.indexOf('node_modules/');
    if (at > 0 && !k.startsWith('node_modules/')) out.add(k.slice(0, at + 'node_modules'.length));
  }
  return [...out];
}

/** Why a lane gets no link copy (null: it may), before a source is looked for. */
export function linkBlocker(dir: string): string | null {
  if (!fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm only (package-lock.json)';
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm links from its own store already';
  if (fs.existsSync(path.join(dir, 'patches'))) return 'patches/ rewrites files in node_modules, which would reach the other lanes';
  return null;
}

/**
 * A lane to copy from: installed from this very lockfile (its recorded stamp), still on it (no
 * `npm install` changed it since), with a node_modules.
 */
export function findSource(target: Lane, siblings: readonly Lane[], stamp: string): Lane | undefined {
  return siblings.find((l) =>
    l.dir !== target.dir && l.exists && l.meta().installStamp === stamp && lockStamp(l.dir) === stamp &&
    fs.existsSync(path.join(l.dir, 'node_modules')));
}

/**
 * Copies `from` to `to` with hard links for files. A link that points inside the source lane
 * (an npm workspace, a junction with a full path on Windows) is pointed at the same place in
 * the new lane. Returns the number of files linked.
 */
export function linkTree(from: string, to: string, fromRoot: string, toRoot: string, top = true): number {
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (top && OWN.has(e.name)) continue;
    const src = path.join(from, e.name);
    const dest = path.join(to, e.name);
    if (e.isSymbolicLink()) {
      copyLink(relink(fs.readlinkSync(src), fromRoot, toRoot), dest);
    } else if (e.isDirectory()) {
      files += linkTree(src, dest, fromRoot, toRoot, false);
    } else {
      fs.linkSync(src, dest);
      files++;
    }
  }
  return files;
}

/**
 * A link like the one copied. POSIX keeps the target as written. Windows: npm links folders
 * with junctions (a file symlink would need extra rights), and a junction needs a full path
 * (Node would resolve a relative one from the current folder, not from the link's).
 */
function copyLink(target: string, dest: string): void {
  if (process.platform !== 'win32') return fs.symlinkSync(target, dest);
  fs.symlinkSync(path.resolve(path.dirname(dest), target), dest, 'junction');
}

/** A link target inside the source lane, moved to the new lane; anything else unchanged. */
export function relink(target: string, fromRoot: string, toRoot: string): string {
  if (!path.isAbsolute(target)) return target;
  const plain = target.replace(/^\\\\\?\\/, '');
  const rel = path.relative(fromRoot, plain);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return target;
  return path.join(toRoot, rel);
}
