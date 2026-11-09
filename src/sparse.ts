// Sparse slots: a lane of a big repository that checks out only some of its folders (git's
// cone mode). The setting lives in the slot's own worktree config; the main clone keeps
// every file.
import fs from 'node:fs';
import path from 'node:path';
import type { Checkout, MainClone } from './checkout.ts';
import { FAST } from './config.ts';
import { listLines } from './text.ts';

/** Folders for `git sparse-checkout set --cone`: inside the repository, with forward slashes. */
export function sparseDirs(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const dir = raw.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    const parts = dir.split('/');
    const outside = dir === '' || dir.startsWith('/') || /^[A-Za-z]:/.test(dir) || parts.some((p) => p === '' || p === '.' || p === '..');
    if (outside || /[*?[\]!]/.test(dir)) throw new Error(`--sparse takes folders inside the repository, like app/web: "${raw}" is not one`);
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * Whether a file is checked out when the lane has only `dirs`: files at the root, files under
 * a chosen folder, and the files directly in the folders above one (cone mode). No folders
 * means the whole repository.
 */
export function inCone(file: string, dirs: readonly string[]): boolean {
  if (dirs.length === 0) return true;
  const f = file.replace(/\\/g, '/');
  const parent = path.posix.dirname(f);
  if (parent === '.') return true;
  return dirs.some((d) => f.startsWith(`${d}/`) || d.startsWith(`${parent}/`));
}

/**
 * The folders a new task's lane gets: `--sparse`, else the repository's untracked
 * `.lanesparse` (one folder per line), else none (the whole repository). `--no-sparse` wins
 * over `.lanesparse`.
 */
export function chosenDirs(clone: MainClone, opts: { sparse?: readonly string[]; full?: boolean }): string[] {
  if (opts.full && opts.sparse?.length) throw new Error('--sparse and --no-sparse: pick one');
  if (opts.full) return [];
  if (opts.sparse?.length) return sparseDirs(opts.sparse);
  return sparseDirs(listLines(clone.readFile('.lanesparse') ?? ''));
}

const isSparse = (co: Checkout) => co.tryGit('config', '--get', 'core.sparseCheckout') === 'true';

/** The folders a checkout is limited to; empty when it has every file. */
export function currentDirs(co: Checkout): string[] {
  if (!isSparse(co)) return [];
  return (co.tryGit('sparse-checkout', 'list') ?? '').split(/\r?\n/).filter(Boolean);
}

/** Limits a checkout to `dirs`, or gives it every file again when `dirs` is empty. */
export function applySparse(co: Checkout, dirs: readonly string[]): void {
  if (dirs.length > 0) co.git(...FAST, 'sparse-checkout', 'set', '--cone', '--', ...dirs);
  else if (isSparse(co)) co.git(...FAST, 'sparse-checkout', 'disable');
}

/** Chosen folders the checkout does not have: not in its commit (a typo, or added later). */
export function missingDirs(co: Checkout, dirs: readonly string[]): string[] {
  return dirs.filter((d) => !fs.existsSync(path.join(co.dir, d)));
}
