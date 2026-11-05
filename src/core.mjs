// Pure helpers: no git, no file system. Everything here has a unit test.
import path from 'node:path';

/** Folder-safe form of a task name: `fix/login bug` -> `fix-login-bug`. */
export function slug(task) {
  return String(task)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Where a lane lives: short on purpose, Windows has a path length limit. */
export function lanePath(root, repo, task) {
  return path.join(root, `${repo}-${slug(task)}`);
}

/** Work goes to develop when a repo has one (aegis-net, dfk, network-overrides). */
export function pickBase({ hasDevelop, originHead }) {
  if (hasDevelop) return 'develop';
  if (!originHead) throw new Error('cannot tell the default branch (origin/HEAD is not set)');
  return originHead.replace(/^origin\//, '');
}

/**
 * The install command for a checkout, from the lockfiles at its root.
 * npm ci keeps install scripts on purpose: `prepare` sets up the commit hooks.
 */
export function installCommands(files) {
  const has = (f) => files.includes(f);
  const out = [];
  if (has('pnpm-lock.yaml')) out.push('pnpm install --frozen-lockfile');
  else if (has('package-lock.json')) out.push('npm ci --no-audit --no-fund');
  if (has('pubspec.yaml')) out.push('flutter pub get');
  return out;
}

/** `git worktree list --porcelain` -> [{ path, head, branch, bare, detached }]. */
export function parseWorktrees(text) {
  const list = [];
  let cur = null;
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
export function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export function isInside(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase().replace(/[\\/]+$/, '') + path.sep;
  return c.startsWith(p);
}

/** One word for a PR's checks. */
export function checksState(rollup) {
  if (!rollup || rollup.length === 0) return 'none';
  const states = rollup.map((c) => String(c.conclusion || c.state || c.status || '').toUpperCase());
  if (states.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(s)))
    return 'fail';
  if (states.some((s) => ['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'].includes(s)))
    return 'pending';
  return 'pass';
}

/** `lane clean` removes a lane only when its PR is merged and nothing is left uncommitted. */
export function cleanable({ prState, dirty, unpushed }) {
  return prState === 'MERGED' && dirty === 0 && !unpushed;
}

/** `owner/name` from an origin URL (https or ssh). */
export function repoSlug(url) {
  const m = String(url).trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
