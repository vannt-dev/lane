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

/** Lines of a small list file (`.lanecopy`, `.lanecheck`): trimmed, no blanks, no `#` comments. */
export function listLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/**
 * The commands that check a checkout, used by `lane verify` and `lane sync`. A repository can name
 * its own (`custom`, from `.lanecheck` or `--cmd`); otherwise they follow what the checkout has.
 */
export function checkCommands(input: {
  files: readonly string[];
  scripts?: Readonly<Record<string, string>>;
  custom?: readonly string[];
}): string[] {
  if (input.custom && input.custom.length > 0) return [...input.custom];
  const has = (f: string) => input.files.includes(f);
  const out: string[] = [];
  if (has('package.json')) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : 'npm';
    for (const s of ['typecheck', 'lint', 'test']) if (input.scripts?.[s]) out.push(`${pm} run ${s}`);
  }
  if (has('pubspec.yaml')) out.push('flutter analyze', 'flutter test');
  if (has('Cargo.toml')) out.push('cargo test');
  if (has('go.mod')) out.push('go test ./...');
  return out;
}

/** Lockfiles: when one changes, a checkout needs its dependencies installed again. */
export const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'pubspec.lock', 'Cargo.lock', 'go.sum'];

/** The git hooks a lane may wrap. */
export const HOOK_NAMES = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'post-rewrite', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc',
];

/** Hooks heavy enough to wait for a build slot (they usually run the whole test suite). */
export const HEAVY_HOOKS = ['pre-push'];

/**
 * A lane's stand-in for one of the repository's hooks: it runs the original, through
 * `lane with build` when the hook is heavy, so a push does not add a third test run.
 */
export function hookWrapper(name: string, original: string): string {
  const target = original.replace(/\\/g, '/');
  const run = HEAVY_HOOKS.includes(name) ? `exec lane with build -- sh "${target}" "$@"` : `exec "${target}" "$@"`;
  return `#!/bin/sh\n# Written by lane: runs the repository's ${name} hook.\n${run}\n`;
}

/** What an agent working in a lane must know, to paste at the top of its task. */
export function briefText(input: {
  lane: string;
  path: string;
  branch: string;
  repo: string;
  mainClone: string;
  others: readonly string[];
  checks: readonly string[];
}): string {
  const p = input.path.replace(/\\/g, '/');
  const lines = [
    `## Where you work (lane ${input.lane})`,
    `- Your checkout: \`${p}\`, branch \`${input.branch}\` of ${input.repo}. Other tasks run in other lanes at the same time.`,
    `- Start every shell command with \`cd ${p} && \`; give every file tool an absolute path under \`${p}\`.`,
    `- Never read, edit or run anything in the main clone \`${input.mainClone.replace(/\\/g, '/')}\`` +
      (input.others.length ? ` or in the other lanes: ${input.others.map((o) => `\`${o.replace(/\\/g, '/')}\``).join(', ')}.` : '.'),
    '- Heavy commands (whole test suites, flutter/gradle/cargo builds) go through `lane with build -- <command>`: at most two run at once.',
    '- The Android emulator: `lane claim emulator` before using it, `lane release emulator` right after.',
    '- One pull request for this lane. Do not bump the version or edit the CHANGELOG: releases are made after the lanes merge.',
  ];
  if (input.checks.length) lines.push(`- Checks to pass before you push: ${input.checks.map((c) => `\`${c}\``).join(', ')}.`);
  return `${lines.join('\n')}\n`;
}
