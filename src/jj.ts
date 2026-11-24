// Jujutsu (jj). A main clone that is a colocated jj repository (`.jj` next to `.git`) gets its
// slots as jj workspaces that are git worktrees too (`jj workspace add --colocate`, jj 0.46 and
// later), so both tools see every slot. Everything else lane does stays on the git side.
import fs from 'node:fs';
import path from 'node:path';
import { samePath } from './fsutil.ts';
import { run, tryRun } from './proc.ts';

/** The first jj whose `workspace add` can make the git worktree too. */
export const JJ_MIN: readonly [number, number] = [0, 46];

/** How a folder uses jj: not at all, colocated with git, or a jj repository with no `.git`. */
export function jjKind(dir: string): 'none' | 'colocated' | 'separate' {
  if (!isDir(path.join(dir, '.jj'))) return 'none';
  return fs.existsSync(path.join(dir, '.git')) ? 'colocated' : 'separate';
}

const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();

/** `jj 0.47.1-d16ee...` -> [0, 47]; null for other text. */
export function parseJjVersion(text: string): [number, number] | null {
  const m = text.match(/^jj\s+(\d+)\.(\d+)/m);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function jjSupported(v: readonly [number, number]): boolean {
  return v[0] > JJ_MIN[0] || (v[0] === JJ_MIN[0] && v[1] >= JJ_MIN[1]);
}

let version: [number, number] | null | undefined;

/** The installed jj's version, or null when there is no jj on PATH (asked once per run). */
export function jjVersion(): [number, number] | null {
  if (version === undefined) version = parseJjVersion(tryRun('jj', ['--version']) ?? '');
  return version;
}

/** One workspace of a jj repository. */
export interface JjWorkspace {
  name: string;
  root: string;
  /** The change id of its working-copy commit (`@`), short. */
  change: string;
}

const LIST_TEMPLATE = 'name ++ "\\t" ++ root ++ "\\t" ++ target.change_id().shortest(8) ++ "\\n"';

/** `jj workspace list` with LIST_TEMPLATE -> the workspaces. */
export function parseWorkspaces(text: string): JjWorkspace[] {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [name, root, change] = line.split('\t');
    return name && root ? [{ name, root, change: change ?? '' }] : [];
  });
}

/**
 * The workspaces of the jj repository in `cloneDir`. Without touching any working copy: a
 * snapshot from here would record the main clone's and the other slots' files as jj changes.
 */
export function jjWorkspaces(cloneDir: string): JjWorkspace[] {
  const out = tryRun('jj', ['--ignore-working-copy', 'workspace', 'list', '-T', LIST_TEMPLATE], cloneDir);
  return out === null ? [] : parseWorkspaces(out);
}

/** The workspace whose root is `dir`, if jj knows one there (a folder gone already included). */
export function workspaceAt(list: readonly JjWorkspace[], dir: string): JjWorkspace | undefined {
  return list.find((w) => samePath(canonical(w.root), canonical(dir)));
}

/** The long form of a path (Windows runners give temp folders as 8.3 short names), when it can be read. */
function canonical(p: string): string {
  for (const [base, rest] of [[p, ''], [path.dirname(p), path.basename(p)]] as const) {
    try {
      return path.join(fs.realpathSync.native(base), rest);
    } catch {
      // not there: try its parent, else leave it as given
    }
  }
  return p;
}

/**
 * A new workspace `name` at `dest` with its own git worktree (detached at the main clone's
 * parent commit; lane switches it to the task's branch next). jj snapshots the main clone's
 * working copy first, as every jj command run there does.
 */
export function addWorkspace(cloneDir: string, dest: string, name: string): void {
  run('jj', ['workspace', 'add', '--colocate', '--name', name, dest], cloneDir);
}

/** Stops jj tracking a workspace; jj removes its git worktree too when that is still there. */
export function forgetWorkspace(cloneDir: string, name: string): boolean {
  return tryRun('jj', ['--ignore-working-copy', 'workspace', 'forget', name], cloneDir) !== null;
}
