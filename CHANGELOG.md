# Changelog

## 0.6.0 (2026-11-06)

### Features

* A slot is claimed by locking it and reading the lock back with this hold's lease: when
  another session locked or made the slot first, lane leaves it alone and picks again.
* `lane clean` keeps a merged lane that is still held (follow-up rounds reuse it) unless its
  hold looks abandoned or `--force`; a lane with a claim or a process in it always stays.
* `lane sync` skips lanes in use and lanes with no history in common with the base.

## 0.5.0 (2026-11-05)

### Features

* Reusable slot pool: numbered worktrees held with `git worktree lock`, given back with
  `lane done`, dependencies and caches kept.
* Merged work found without GitHub (squash merges included), leases, left-behind holds
  (`lane free`), port ranges per slot (`lane port`).
* `lane verify`, `lane sync`, `lane brief`, lanes from pull requests (`lane new --pr`), a cap
  on heavy hooks and builds (`lane with build`), shared claims (`lane claim`).

## 0.1.0 (2026-11-05)

### Features

* One git worktree per task, written in TypeScript and run by Node without a build step.
