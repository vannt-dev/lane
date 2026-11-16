// A task's own branch, left behind once the slot moved off it: a tool in the slot switched to a
// branch of its own, or a review checked out something else. A give-back deletes only the
// branch the slot is on, so this one stayed. lane deletes it when it holds nothing.
import type { MainClone } from './checkout.ts';
import type { Lane } from './lane.ts';
import { log } from './text.ts';

/**
 * Whether lane may delete `branch` of `clone`: it exists, no worktree has it checked out, and
 * every commit of it is on a remote (a branch made for a task and never committed to has none
 * of its own).
 */
export function emptyBranch(clone: MainClone, branch: string | undefined): branch is string {
  if (!branch || !clone.hasRef(`refs/heads/${branch}`)) return false;
  if (clone.worktrees().some((w) => w.branch === branch)) return false;
  return clone.tryGit('rev-list', '--count', branch, '--not', '--remotes=origin') === '0';
}

/** Deletes such a branch; '' when it is not one (see emptyBranch), else what was done. */
export function dropEmptyBranch(clone: MainClone, branch: string | undefined): string {
  if (!emptyBranch(clone, branch) || clone.tryGit('branch', '-D', branch) === null) return '';
  return `task branch ${branch} deleted (no commits of its own)`;
}

/** For `lane clean`: such branches of slots given back (detached, not held), each named, and their deletions. */
export function branchDrops(lanes: readonly Lane[]): Array<() => void> {
  return lanes.filter((l) => l.exists && !l.branch && l.locked === null).flatMap((l) => {
    const b = l.taskBranch();
    if (!emptyBranch(l.clone, b)) return [];
    log(`delete branch ${b}  (task branch of ${l.name}, no commits of its own)`);
    return [() => log(dropEmptyBranch(l.clone, b))];
  });
}
