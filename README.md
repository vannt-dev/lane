# lane

One git worktree per task, so several tasks in one repo can be worked on at the same time,
each with its own Claude Code session, without stepping on each other.

A lane is a worktree at `F:/wt/<repo>-<task>` on its own branch. Claude Code already makes
worktrees (`claude -w`); `lane` adds what it does not do on this machine: the right base
branch, private submodules, untracked local files, dependencies, one view of every lane's
PR and CI, safe clean-up, and turns for the things only one lane can use at a time.

## Install

```sh
git clone https://github.com/vannt-dev/lane && cd lane
npm install && npm link    # puts `lane` on PATH
```

Node 22.18+, git, and `gh` (logged in) for PR and CI state.

Written in TypeScript and run as is: Node strips the types, so there is no build step.
`npm install` only brings the type checker. Install from a clone with `npm link` as above:
Node does not run `.ts` files that sit inside `node_modules`, so `npm install -g` from the
registry or a git URL would not work.

## Commands

| Command | What it does |
| --- | --- |
| `lane new <repo> <task>` | New worktree from `origin/develop` if the repo has one, else the default branch. Branch = task name (`--branch` to change, `--base` to pick the base). Loads submodules, copies untracked `.env`, `.env.local`, `android/key.properties`, `.claude/settings.local.json` (more in an untracked `.lanecopy`, one path per line), installs dependencies from the lockfile (`--no-install` to skip), writes `CLAUDE.local.md` with the lane rules. `--open` starts Claude Code in a new Windows Terminal tab. |
| `lane new <repo> --pr <n>` | A lane on an existing pull request: its own branch, tracking it, when the PR is in the repo; a local `pr-<n>` branch for a PR from a fork. To test a release PR or finish someone's work. |
| `lane list [--local]` | Every lane: branch, uncommitted and unpushed work, PR and CI. `--local` skips GitHub. |
| `lane clean [--yes]` | Lists lanes whose PR is merged and that have nothing uncommitted or unpushed (a squash-merged lane still on the PR's last commit counts as pushed); `--yes` removes them and their local branches, then fast-forwards each main clone that has no changes of its own. |
| `lane rm <lane> [--force]` | Removes one lane; refuses if work would be lost unless `--force`. |
| `lane verify <repo> [--cmd C]... [--keep]` | Merges every open lane of the repo on top of the base branch in a throwaway checkout (`<repo>-verify`), installs, and runs the checks. Reports lanes whose text conflicts, and fails when the lanes together break the checks even though each passes alone. The checkout is removed when all is well, kept to look at otherwise. |
| `lane sync <repo> [--push] [--cmd C]...` | After a lane merged: rebases each other open lane onto the new base (skipping lanes with uncommitted work or a merged PR), reinstalls when a lockfile changed, runs the checks. A conflicting rebase is aborted and the lane left as it was. `--push` force-pushes (with lease) the lanes that pass. |
| `lane brief [<lane>]` | The rules for an agent working in a lane (its path, branch, the main clone and other lanes to stay out of, the build slots, the checks), to paste at the top of its task: an agent started by another session does not read `CLAUDE.local.md`. |
| `lane claim <res>` / `lane release <res>` | Take and give back something only one lane may use (the Android emulator). `claim` waits until free; `--no-wait` fails instead. |
| `lane with <res> [--slots N] -- <cmd>` | Runs a command while holding one of N slots, freed when it ends. `build` has 2 slots by default (RAM). |
| `lane locks` | Who holds what. |

`<repo>` is a folder in `F:/ai-agent`. Override the folders with `LANE_REPOS` and `LANE_ROOT`.

**Checks** (`verify`, `sync`, `brief`): `--cmd` (repeatable), else an untracked `.lanecheck` file in
the main clone (one command per line), else what the checkout has: the `typecheck`, `lint` and
`test` scripts of `package.json` (with pnpm when it has `pnpm-lock.yaml`), `flutter analyze` and
`flutter test`, `cargo test`, `go test ./...`. Each check holds a `build` slot.

**A typical round** with two tasks in one repo:

```sh
lane new repokeeper feat/a && lane new repokeeper feat/b   # one Claude Code session in each
lane brief repokeeper-feat-a                                # paste into an agent's task instead
lane verify repokeeper        # before merging: do the two lanes still pass together?
# merge the PR of feat/a, then:
lane sync repokeeper --push   # feat/b onto the new main, checks again, pushed
lane clean --yes              # merged lanes go, the main clone is pulled
```

## How the pieces share

- All lanes of a repo share one `.git`: commits, branches and fetches made in one lane are
  visible in the others at once. A branch can be checked out in only one lane at a time.
- Each lane has its own files, `node_modules` and build output. Package caches are shared
  (pnpm store, npm cache, Flutter pub cache), so installs are mostly copies and links.
- Locks live in `F:/wt/.locks`. A `claim` holds until `lane release`, or until its lane is
  removed, or after 3 hours. A `with` slot is freed when its command ends, even on a crash.
- `CLAUDE.local.md` tells Claude Code in the lane to claim the emulator, wrap heavy builds
  in `lane with build`, keep one PR per lane, and leave versions and CHANGELOG alone (releases
  are made after the lanes merge, so lanes do not conflict there). It is ignored by git via
  the repo's `.git/info/exclude`.
- When the repo has a `pre-push` hook (lefthook and husky both run the test suite there), the
  lane gets its own hooks folder (`core.hooksPath` in the worktree's config; the repo gets
  `extensions.worktreeConfig`): `pre-push` runs through `lane with build`, every other hook runs
  as before. The main clone and other lanes keep their hooks.
- `verify` and `sync` merge and rebase with the repo's hooks off: they are lane's own steps,
  not commits for review.

## Known

- aegis-net builds on this machine need `--android-project-arg=kotlin.incremental=false`
  (pub cache on C:, checkout on F:); a lane is on F: too.
- Removing a lane falls back to a `\\?\` path delete when git hits Windows' path limit.

## Development

```sh
npm run typecheck   # tsc --noEmit, strict
npm test            # node --test, runs the .ts tests directly
```

CI runs both on Windows and Ubuntu, on the oldest supported Node (22.18).

| File | What is in it |
| --- | --- |
| `bin/lane.ts` | Command line parsing |
| `src/commands.ts` | The commands (git, gh, file system) |
| `src/locks.ts` | Claims and build slots |
| `src/core.ts` | Pure helpers (names, base branch, install command, PR state) |
| `src/sh.ts` | Running programs |
