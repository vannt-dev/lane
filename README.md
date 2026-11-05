# lane

One git worktree per task, so several tasks in one repo can be worked on at the same time,
each with its own Claude Code session, without stepping on each other.

A lane is a worktree at `F:/wt/<repo>-<task>` on its own branch. Claude Code already makes
worktrees (`claude -w`); `lane` adds what it does not do on this machine: the right base
branch, private submodules, untracked local files, dependencies, one view of every lane's
PR and CI, safe clean-up, and turns for the things only one lane can use at a time.

## Install

```sh
cd F:/ai-agent/lane && npm link    # puts `lane` on PATH
```

Node 22+, git, and `gh` (logged in) for PR and CI state.

## Commands

| Command | What it does |
| --- | --- |
| `lane new <repo> <task>` | New worktree from `origin/develop` if the repo has one, else the default branch. Branch = task name (`--branch` to change, `--base` to pick the base). Loads submodules, copies untracked `.env`, `.env.local`, `android/key.properties`, `.claude/settings.local.json` (more in an untracked `.lanecopy`, one path per line), installs dependencies from the lockfile (`--no-install` to skip), writes `CLAUDE.local.md` with the lane rules. `--open` starts Claude Code in a new Windows Terminal tab. |
| `lane list [--local]` | Every lane: branch, uncommitted and unpushed work, PR and CI. `--local` skips GitHub. |
| `lane clean [--yes]` | Lists lanes whose PR is merged and that have nothing uncommitted or unpushed; `--yes` removes them and their local branches. |
| `lane rm <lane> [--force]` | Removes one lane; refuses if work would be lost unless `--force`. |
| `lane claim <res>` / `lane release <res>` | Take and give back something only one lane may use (the Android emulator). `claim` waits until free; `--no-wait` fails instead. |
| `lane with <res> [--slots N] -- <cmd>` | Runs a command while holding one of N slots, freed when it ends. `build` has 2 slots by default (RAM). |
| `lane locks` | Who holds what. |

`<repo>` is a folder in `F:/ai-agent`. Override the folders with `LANE_REPOS` and `LANE_ROOT`.

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

## Known

- aegis-net builds on this machine need `--android-project-arg=kotlin.incremental=false`
  (pub cache on C:, checkout on F:); a lane is on F: too.
- Removing a lane falls back to a `\\?\` path delete when git hits Windows' path limit.

## Tests

```sh
npm test
```
