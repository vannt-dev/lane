// Pure helpers: no git, no file system. Everything here has a unit test.
import path from 'node:path';

export interface Worktree {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
  detached: boolean;
}

export interface Check {
  conclusion?: string | null;
  state?: string | null;
  status?: string | null;
}

export type ChecksState = 'none' | 'pass' | 'pending' | 'fail';

/** Folder-safe form of a task name: `fix/login bug` -> `fix-login-bug`. */
export function slug(task: string): string {
  return task
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Where a lane lives: short on purpose, Windows has a path length limit. */
export function lanePath(root: string, repo: string, task: string): string {
  return path.join(root, `${repo}-${slug(task)}`);
}

/** Work goes to develop when a repo has one (aegis-net, dfk, network-overrides). */
export function pickBase({ hasDevelop, originHead }: { hasDevelop: boolean; originHead: string }): string {
  if (hasDevelop) return 'develop';
  if (!originHead) throw new Error('cannot tell the default branch (origin/HEAD is not set)');
  return originHead.replace(/^origin\//, '');
}

/**
 * The install command for a checkout, from the lockfiles at its root.
 * npm ci keeps install scripts on purpose: `prepare` sets up the commit hooks.
 */
export function installCommands(files: readonly string[]): string[] {
  const has = (f: string) => files.includes(f);
  const out: string[] = [];
  if (has('pnpm-lock.yaml')) out.push('pnpm install --frozen-lockfile');
  else if (has('package-lock.json')) out.push('npm ci --no-audit --no-fund');
  if (has('pubspec.yaml')) out.push('flutter pub get');
  return out;
}

/** `git worktree list --porcelain` -> one entry per worktree. */
export function parseWorktrees(text: string): Worktree[] {
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: '', branch: '', bare: false, detached: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') cur.bare = true;
    else if (line === 'detached') cur.detached = true;
  }
  return list;
}

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

const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'];
const WAITING = ['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'];

/** One word for a PR's checks. */
export function checksState(rollup: readonly Check[] | null | undefined): ChecksState {
  if (!rollup || rollup.length === 0) return 'none';
  const states = rollup.map((c) => String(c.conclusion || c.state || c.status || '').toUpperCase());
  if (states.some((s) => FAILED.includes(s))) return 'fail';
  if (states.some((s) => WAITING.includes(s))) return 'pending';
  return 'pass';
}

/**
 * `lane clean` removes a lane only when its PR is merged and nothing would be lost. After a squash
 * merge GitHub deletes the branch, so the lane's commits are on no remote any more; they are safe
 * when the lane still sits on the commit the PR was merged from.
 */
export function cleanable(s: {
  prState: string | undefined;
  dirty: number;
  unpushed: boolean;
  atPrHead?: boolean;
}): boolean {
  return s.prState === 'MERGED' && s.dirty === 0 && (!s.unpushed || s.atPrHead === true);
}

/** `owner/name` from an origin URL (https or ssh). */
export function repoSlug(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
