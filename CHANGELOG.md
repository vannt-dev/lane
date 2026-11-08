# Changelog

## [0.7.1](https://github.com/vannt-dev/lane/compare/v0.7.0...v0.7.1) (2026-11-08)


### Bug Fixes

* **list:** no unpushed count for a detached slot ([#10](https://github.com/vannt-dev/lane/issues/10)) ([9246da6](https://github.com/vannt-dev/lane/commit/9246da6b508ba5e3f8de9aa29582809f533cabe4))

## [0.7.0](https://github.com/vannt-dev/lane/compare/v0.6.0...v0.7.0) (2026-11-08)


### ⚠ BREAKING CHANGES

* LANE_ROOT and LANE_REPOS have no default; name the slot a held task has ([#4](https://github.com/vannt-dev/lane/issues/4))

### Features

* LANE_ROOT and LANE_REPOS have no default; name the slot a held task has ([#4](https://github.com/vannt-dev/lane/issues/4)) ([ecc6a25](https://github.com/vannt-dev/lane/commit/ecc6a2596617808fb303e24c430d97add7bc93c0))


### Bug Fixes

* keep a git hook's repository variables away from lane's git calls ([#2](https://github.com/vannt-dev/lane/issues/2)) ([334270a](https://github.com/vannt-dev/lane/commit/334270a90f8dd019ce8516096b485b609c76c257))
* runLive also drops a git hook's repository variables ([#3](https://github.com/vannt-dev/lane/issues/3)) ([53998e2](https://github.com/vannt-dev/lane/commit/53998e20c801e0e63937de4a38badaa1caba43b4))
* **sync:** check and push a lane already on the base but not pushed ([#9](https://github.com/vannt-dev/lane/issues/9)) ([c4177b9](https://github.com/vannt-dev/lane/commit/c4177b959daf2a9ef7768de78484193cf9a8abe7))
* **sync:** leave a lane whose work is already in the base ([#8](https://github.com/vannt-dev/lane/issues/8)) ([e119e24](https://github.com/vannt-dev/lane/commit/e119e245055fe183d868a4c2b2c854afee78d178))

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
