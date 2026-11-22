# lane

[![CI](https://github.com/vannt-dev/lane/actions/workflows/ci.yml/badge.svg)](https://github.com/vannt-dev/lane/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@vannt-dev/lane)](https://www.npmjs.com/package/@vannt-dev/lane)
[![npm downloads](https://img.shields.io/npm/d18m/@vannt-dev/lane)](https://www.npmjs.com/package/@vannt-dev/lane)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-vannt--dev.github.io%2Flane-c6f36b)](https://vannt-dev.github.io/lane/)

Run several tasks of one git repository at the same time, each in its own worktree (a
"lane"), usually with one coding agent per lane, without the tasks stepping on each other.

Lanes are **slots**: numbered worktrees `<lane root>/<repo>-<n>` that are reused. A task
holds a slot with `git worktree lock` and gives it back when its work is pushed; the folder,
its dependencies and build caches stay, so the next task starts in seconds instead of
checking out and installing again.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vannt-dev/lane/main/docs/diagrams/overview-dark.svg">
  <img alt="lane new takes a slot of the pool for a task: it locks the worktree, makes the task's branch, copies the env files and installs only when the lockfiles changed. Each held slot has its own agent and pushes its own pull request. Free slots keep their dependencies and caches. Lanes claim shared things such as the emulator and two build slots. When a pull request merges, lane verify, lane sync and lane clean check the other lanes on the new base and give merged slots back." src="https://raw.githubusercontent.com/vannt-dev/lane/main/docs/diagrams/overview-light.svg">
</picture>

## Why

Coding agents work best one task per checkout. `git worktree` gives each task its own folder,
but on its own it leaves the hard parts to you: a fresh worktree needs its dependencies
installed again, two agents fight over one Android emulator or one dev-server port, heavy
builds run four at a time and run out of memory, and two branches that merge cleanly as
text can still break each other once both are in. lane handles those parts:

- **Reused slots.** A task takes a slot, the slot keeps `node_modules` and build caches, and
  dependencies are installed again only when a lockfile changed.
- **Safe holds.** A slot is held with `git worktree lock` and a lease; another session never
  takes it, and `lane done` refuses to give back work that is not on the remote.
- **Shared things.** `lane claim emulator`, `lane with build -- <cmd>` (heavy commands wait in
  line for a shared budget of build slots, at low CPU priority) and a port range per slot
  (`lane port 3000`).
- **Merge safety.** `lane verify` merges all open lanes together and runs the checks before
  the first one merges; `lane sync` rebases the rest and checks them again after.
- **Agent notes.** Each lane gets a `CLAUDE.local.md` (and `lane brief` for sub-agents) with
  these rules, so Claude Code in the lane follows them.

lane works with any agent or none. With [junto](https://github.com/vannt-dev/junto) each lane
keeps its own task, and `/junto:status all` shows every lane's task in one table.

## Install

Node 22.18+, git, and `gh` (logged in) for pull request and CI state.

```sh
npm install -g @vannt-dev/lane    # puts `lane` on PATH, and `git lane` works too
```

From a clone instead (`npm install` builds `dist`, which the `lane` command runs):

```sh
git clone https://github.com/vannt-dev/lane && cd lane
npm install && npm link
```

Then tell lane where your clones are and where the slots go. Both are required; lane stops
with a message naming the missing one.

```sh
# Windows (new terminals pick it up)
setx LANE_REPOS D:/code
setx LANE_ROOT D:/wt

# macOS / Linux: in ~/.bashrc, ~/.zshrc or similar
export LANE_REPOS="$HOME/code"
export LANE_ROOT="$HOME/wt"
```

lane was built and is used daily on Windows; CI runs it on Windows, Ubuntu and macOS.
`lane new --open` starts Claude Code in a new Windows Terminal tab on Windows, in a new tmux
window inside tmux; elsewhere (or when that fails) it prints the command to run.

## Quick start

```sh
lane new myrepo feat/login        # slot myrepo-1 on a new branch feat/login, ready to work in
cd "$LANE_ROOT/myrepo-1" && claude
# ... commit, push, open the pull request ...
lane done myrepo-1               # once pushed: the slot goes back to the pool, caches kept
lane list                         # every lane: held or free, branch, changes, PR and CI
```

| Variable | Meaning |
| --- | --- |
| `LANE_REPOS` | Required. `<repos folder>`: the folder holding the main clones; `<repo>` names one of them |
| `LANE_ROOT` | Required. `<lane root>`: the folder for the slots (and `.locks`) |
| `LANE_MAX_SLOTS` | Slots per repository (default 4) |
| `LANE_PORT_STRIDE` | Ports per slot (default 10): slot n owns the usual port + n x stride onwards |
| `LANE_LINK_DEPS` | `1`: every `lane new` links npm dependencies from a lane on the same lockfile (see Dependencies from another lane) |
| `LANE_POOLS` | Max slots of named pools, e.g. `review=2,ci=1` (see Pools) |
| `LANE_ROOT_SPARE` | A second folder for new slots, on another drive, used when the lane root's drive is short of space (see A spare root) |
| `LANE_MIN_FREE_GB` | Free space a drive must have for a new slot, in GB. Not set: 10 with `LANE_ROOT_SPARE`, else no check |
| `LANE_WITH_SLOTS` | Slots of `lane with` resources, e.g. `build=6,gpu=1` (default: build suits the machine, see `lane tune`; others 1) |
| `LANE_LOW_CPU` | `0`: commands run by `lane with` keep normal CPU priority (default: below normal) |
| `LANE_WITH_MIN_FREE_GB` | Free memory a `lane with` command needs to start beside a running one (default: an eighth of the RAM, at least 3; `0`: off) |
| `LANE_WITH_PASS_MIN` | Minutes a waiting command may be passed by later, lighter ones (default 10; `0`: strict order) |
| `LANE_VITEST_WORKERS` | `--maxWorkers` given to vitest started by `lane with` (default: 1 up to 4 cores, 2 up to 11, then 3) |

## Commands

| Command | What it does |
| --- | --- |
| `lane new <repo> <task>` | Takes a slot for the task: the slot it had before, else a free one, else a new one (up to `LANE_MAX_SLOTS`). Locks it (`<task> @ <time> #<lease>`; the lease names this hold), puts it on a new branch (the task name, or `--branch`) from `origin/develop` if the repository has one, else the default branch (`--base` to choose). Loads submodules, copies untracked `.env`, `.env.local`, `android/key.properties`, `.claude/settings.local.json` (more in an untracked `.lanecopy`), installs dependencies only when the lockfiles changed since the slot last installed (npm, pnpm, yarn, bun, Flutter, uv; `--no-install` to skip), writes `CLAUDE.local.md`, then runs the repository's `postCreate` commands (see Repository hooks). `--open` starts Claude Code in a new Windows Terminal tab, or a tmux window inside tmux; elsewhere it prints the command. `--agent <name>` starts another agent instead (see Other agents). `--sparse <folder>` (repeatable) checks out only those folders, see Big repositories. |
| `lane new <repo> --pr <n>` | The same, on an existing pull request's branch (tracking it), or on a local `pr-<n>` branch for a PR from a fork. When that branch is checked out already (the slot where the PR is written), the slot is detached at the PR's head instead, and lane says so. |
| `lane done [<lane>] [--lease ID] [--force]` | Gives the slot back once its work is safe: nothing uncommitted, and its commits on the remote or merged (see Merged). Detaches, deletes the local branch when safe, unlocks. The branch the task started on, when the slot moved off it (a tool in the slot switched to a branch of its own), is deleted too if none of its commits is only here. With `--lease`, only while the slot is still held under that lease: a late give-back from a task that already ended never frees the task that came after. `--force` keeps unpushed commits on the local branch. |
| `lane free <lane> [--yes] [--force]` | Frees a hold that looks abandoned (see Left-behind holds). Never when work in it would be lost. `--force` frees one that does not look abandoned. |
| `lane list [--local] [--json]` | Every lane: held (task, for how long, and whether it looks abandoned) or free, branch, local changes, PR and CI (`--local`: no GitHub calls). `--json` prints the same as one JSON array, see For scripts. |
| `lane clean [--yes] [--force]` | Gives back the lanes whose work merged (see Merged), removes lanes whose folder is gone and leftover folders, deletes the task branches given-back slots left with no commits of their own, then fast-forwards the main clones. A merged lane still held stays, since follow-up rounds (review fixes, bugs) reuse it, unless its hold looks abandoned or `--force`; one with a claim or a process in it always stays. |
| `lane rm <lane> [--force]` | Deletes a slot for good. Refuses a held slot or unpushed work without `--force`. |
| `lane move <lane> --to main\|spare [--lease ID]` | Moves a slot between the lane root and the spare root (see A spare root). |
| `lane port <usual port> [k]` | Port k (0 to stride - 1) of this slot's range: the usual port + slot x `LANE_PORT_STRIDE` + k. |
| `lane verify <repo> [--cmd C]... [--keep] [--no-bisect] [--bisect-max N]` | Merges every open lane of the repository on top of the base, in a slot of the pool, and runs the checks: finds lanes that merge cleanly as text but break each other, before the first one merges. A lane that does not merge is listed with the lane it conflicts with and the files. When the checks fail it looks for the lanes to blame, see Which lanes break each other (`--no-bisect` skips that). Kept and held when it fails, to look at. |
| `lane sync <repo> [--push] [--cmd C]...` | After a lane merged: rebases the other lanes onto the new base (a conflicting rebase is aborted and the lane left as it was), reinstalls when a lockfile changed, runs the checks. `--push` force-pushes (with lease) those that pass. Skips lanes with local changes, a claim or a process in them, and lanes with no history in common with the base (rewritten history: move that work by hand). |
| `lane brief [<lane>]` | The rules for an agent working in a lane, to paste at the top of its task: an agent started by another session does not read `CLAUDE.local.md`. |
| `lane claim <res>` / `lane release <res>` | Takes and gives back something only one lane may use (the Android emulator). `claim` waits; `--no-wait` fails instead. A claim ends with the lane hold it was made under. |
| `lane with <res> [--slots N] [--cost K] [--prio high] [--label L] -- <cmd>` | Runs a command holding K of the resource's N slots (K: `--cost`, else by the kind of command; N: `LANE_WITH_SLOTS`, else `build` suits the machine and others 1), waiting in line for them and for free memory, at below-normal CPU priority. See Heavy commands. |
| `lane locks [--json]` | Who holds what, and who waits in line (with each command's label); `--json` adds free memory, for other tools. |
| `lane bump <text>` | Moves the waiting commands whose label or lane holds the text to the front of their line. |
| `lane stats [--days N]` | How long `lane with` commands waited and ran over the last N days (default 7), per command: to size `LANE_WITH_SLOTS` for the machine. |
| `lane tune` | The build slots, test workers and free memory that suit this machine, and the commands to set them. |

**Checks** (`verify`, `sync`, `brief`): `--cmd` (repeatable), else an untracked `.lanecheck`
in the main clone (one command per line), else what the checkout has: the `typecheck`,
`lint` and `test` scripts of `package.json`, `flutter analyze` and `flutter test`,
`cargo test`, `go test ./...`. Each check holds a `build` slot.

**A round** with two tasks in one repository:

```sh
lane new myrepo feat/a && lane new myrepo feat/b   # slots myrepo-1 and myrepo-2
lane verify myrepo          # before merging: do the two still pass together?
# merge feat/a's pull request, then:
lane sync myrepo --push     # feat/b onto the new base, checked again, pushed
lane clean --yes --force    # merged slots given back (not one still in use), the main clone pulled
```

## Heavy commands: lane with

Several agents on one machine each start a test suite, a type check and a build, and the
machine stalls: tests time out for no fault of the code. `lane with` gives a resource a budget
of slots shared by every lane, and a command takes as many as it weighs:

```sh
lane tune                                                  # what suits this machine, and how to set it
setx LANE_WITH_SLOTS "build=6"                             # this machine: 6 slots of build
lane with build -- npx vitest run                          # a whole test suite: 2 slots (its kind)
lane with build -- npx eslint src/changed.ts               # a light command: 1 slot
lane with build --cost 2 --prio high -- npm run build      # waits ahead of the normal ones
```

- **Cost by kind.** Without `--cost`, a test run (vitest, jest), a type check (tsc, vue-tsc),
  a build (vite/next/ng build, webpack, gradle, cargo build, ...), a browser (Playwright,
  Cypress) and docker take 2 slots; a lint, pytest and anything else 1. Never more than the
  resource has, so a one-slot resource still runs them.
- **In line.** A command that finds too few free slots waits in line and says its place every
  30 seconds (`waiting for build: 6 of 6 slots in use, 2nd in line`); `lane locks` lists the
  line and `lane bump <text>` moves a waiting command to the front. A later command may pass
  the ones ahead only when it fits at once and none of them has waited 10 minutes
  (`LANE_WITH_PASS_MIN`; `0`: strict order), so a command that needs 2 is never passed over
  for long by commands that need 1. `--prio high` waits ahead of every normal waiter but never
  stops a command that is running. A waiter whose process ended leaves the line; `lane locks`
  warns about one waiting over 30 minutes.
- **Free memory.** Beside a command already running, another starts only when the machine
  has `LANE_WITH_MIN_FREE_GB` free (default an eighth of the RAM, at least 3 GB), and says
  `waiting for memory` until then. Alone, a command always starts.
- **One per node_modules.** Two test runs or builds never use the same `node_modules` at once
  (a lock named after its real path), so lanes that share one through links do not collide.
- **Kind rules.** vitest started directly (`npx vitest ...` as separate words) gets
  `--maxWorkers` (`LANE_VITEST_WORKERS`) unless it sets its own; a command line given as one
  string and package scripts are left as typed. `docker compose up` without `-d` is refused:
  it would hold its slots until stopped.
- **All or nothing.** A command takes all its slots at once or none; a cost above the slots
  fails at once.
- **Low CPU priority.** The command runs below normal priority (Windows priority class, Unix
  nice), so the editor, browser and calls stay smooth. `LANE_LOW_CPU=0` turns it off.
- **Nested.** The command gets `LANE_WITH` naming what it holds; a `lane with` of the same
  resource inside it (a test script that calls `lane with build` itself, a `pre-push` hook)
  runs at once instead of waiting for itself.
- **Stats.** Each run adds a line to `<lane root>/.locks/stats.log`: when, the resource, a
  short label (the tool and its subcommand, or `--label`; never the arguments), the cost, the
  wait, the run time and the exit code. `lane stats --days 3` sums them up per command: long
  waits mean too few slots, a busy machine with short waits means too many.
- `lane verify` and `lane sync` run each check through `lane with build`, at the cost of its kind.

A sample Claude Code hook, [`examples/heavy-commands-hook.mjs`](examples/heavy-commands-hook.mjs),
refuses a heavy command (vitest, jest, tsc, pytest, test and build tools) run inside a lane
without `lane with`, and answers with the command to use. The file says how to add it to
`.claude/settings.json`; adjust its list to what is heavy on your machine.

## Which lanes break each other

When the combined checks of `lane verify` fail, it goes on, in the same slot, to find the
smallest set of lanes to blame:

1. Each lane alone on the base. A lane that fails there **fails by itself**; the search ends
   (when every lane fails alone it checks the base with no lane, which may be what is broken).
2. When every lane passes alone, each **pair** of lanes. Every pair that fails is named.
3. When no pair fails, the checks fail **only with all lanes together** (three lanes), or with
   three or more of them (not searched further).

```text
lanes                checks
myrepo-1 (feat/a)    pass alone
myrepo-2 (feat/b)    pass alone
myrepo-3 (feat/c)    pass alone
myrepo-1 + myrepo-2  FAIL together: "npm test"
myrepo-1 + myrepo-3  pass together
myrepo-2 + myrepo-3  pass together

3 lane(s) together on origin/main: "npm test" FAILS.
myrepo-1 (feat/a) and myrepo-2 (feat/b) break each other: each passes alone, together they fail.
```

A run that passes costs nothing more: the search starts only on a failure. It takes N check
runs for N lanes alone and N x (N - 1) / 2 for the pairs (two lanes: 2, three: 6, four: 10),
and stops after `--bisect-max` extra runs (default 10), saying how many combinations it left
untested. `--no-bisect` (or `--bisect-max 0`) only reports that the combination fails. When
the search ends the slot holds the combined checkout again.

A lane that does not merge is tried against the base and against each other lane, two at a
time (merges only, no check runs): `CONFLICT with myrepo-1 (feat/a): src/app.ts`, or
`CONFLICT with origin/main itself` for a lane the base moved away from.

## The pool's rules

- **Held** = locked. `git worktree list --porcelain` is the shared state: no registry, and
  `git worktree prune` leaves a locked worktree alone.
- **Free** = not locked, nothing uncommitted, and given back with `lane done` or left
  unchanged for two hours (a session may work in an unlocked slot; its index shows it).
- **Claim** = a lock that reads back as this hold's: lane locks the slot, reads
  `git worktree list --porcelain` again, and goes on only when the lock carries its lease.
  When another session locked or made the slot first, lane leaves that slot alone and picks
  again; a failed switch gives the lock back only while it is still its own.
- A slot held for something else is never taken. A full pool lists the slots with their
  tasks and ages; give one back or raise `LANE_MAX_SLOTS`.
- Speed flags go on each command (`git -c checkout.workers=0 -c core.untrackedCache=true`);
  the repository's own config is not changed.
- Each slot remembers (in `lane.json`, inside its own git folder) the task it held last, the
  lease, the commit the task started from and a stamp of the lockfiles it installed from.

## Merged

A lane's work counts as merged when its PR was merged from the lane's last commit (GitHub),
or, without asking GitHub, when the base branch has it: the lane's commits are in the base, or
merging the lane into the base changes nothing (a squash merge), or the lane's whole change
has the patch id of one commit on the base (a squash merge whose lines were changed again
later). A lane still on the commit it started from has no work and is never merged.

## Left-behind holds

An agent killed or closed without `lane done` leaves its slot locked. A hold looks abandoned
when it is 4 hours old, the slot's index has not changed for 4 hours, and no process uses the
slot: started from it (Linux, where the working folder of a process can be read) or naming it
on its command line (a dev server, a test run). Windows does not tell another process's
working folder, so there a shell sitting in the slot is not seen. `lane list` marks such
holds and `lane free` releases them. Claims on shared things end on their own when the lane
hold they were made under ends (the slot given back or taken for another task).

## For scripts: lane list --json

`lane list --json` prints one JSON array on stdout and nothing else: one object per lane, slots
on the spare root included; `[]` when there are none. The field names are stable.

```sh
lane list --json --local | jq -r '.[] | select(.state == "free") | .path'   # free slots
```

| Field | Value |
| --- | --- |
| `name` | The lane's folder name, `myrepo-2`. |
| `repo` | The repository (a folder in `LANE_REPOS`). |
| `slot` | The slot number; `null` for a lane folder named otherwise. |
| `path` | The lane's folder. |
| `pool` | The named pool of the slot; `null` for the default pool. |
| `state` | `held` (locked for a task), `free` (given back with `lane done`), `unlocked` (not locked, but changed since it was given back: a session may work there), `missing` (the folder is gone). |
| `task` | The task the lane is held for; for a lane not held, the last one, or `null`. |
| `lease` | The lease of the hold; `null` when not held. |
| `heldSince`, `heldMs` | When the hold began (ISO 8601, UTC, to the minute) and how many milliseconds ago; `null` when not held. |
| `abandoned` | `true` when the hold looks left behind (see Left-behind holds). |
| `idleMs` | Milliseconds since anything changed in the slot's index; `null` when unknown. |
| `branch` | The branch; `null` when detached (a free slot, a verify slot). |
| `sparse` | The folders of a sparse lane; `[]` when it has every file. |
| `changed` | Uncommitted and untracked files; `null` when the folder is gone. |
| `unpushed` | Commits on no remote branch; `null` when detached. |
| `pr` | The branch's newest pull request: `{ "number": 12, "state": "OPEN", "checks": "pass" }` (`state`: `OPEN`, `MERGED`, `CLOSED`; `checks`: `none`, `pass`, `pending`, `fail`), or `null` when it has none. Left out with `--local` and for a detached lane. |

## How the lanes share

- All lanes of a repository share one `.git`: a commit or fetch in one is seen in the others.
  A branch can be checked out in one lane at a time, so `lane done` detaches the slot.
- Each slot has its own files, dependencies and build output; package caches (pnpm store,
  npm cache, Flutter pub cache) are shared by the tools themselves.
- Locks on shared things live in `<lane root>/.locks`. A `claim` holds until released, its
  lane hold ends, its lane is removed, or three hours pass; a `with` slot is freed when its command ends.
  Commands waiting for a `with` resource are in `.locks/queue/<resource>`, the run log in `.locks/stats.log`.
- `CLAUDE.local.md` (ignored through `.git/info/exclude`) tells Claude Code in the lane to
  claim the emulator, run heavy builds through `lane with build`, use `lane port`, keep one
  PR per lane, leave versions and the CHANGELOG alone, and give the slot back when done.
- A repository with a `pre-push` hook (lefthook and husky run the tests there) gets, in each
  lane, its own hooks folder (`core.hooksPath` in the worktree's config): `pre-push` waits for
  a build slot, the other hooks run as before.
- `verify` and `sync` merge and rebase with the repository's hooks off.

## Big repositories: sparse slots

A task that needs a few folders of a big repository does not have to check out all of it:

```sh
lane new bigrepo feat/web --sparse app/web --sparse docs
```

- The slot gets those folders and the files at the root (git's cone mode). A new slot starts
  empty and gets only those files, so a big repository is never written out whole first.
- The setting lives in the slot's own worktree config: the main clone and the other lanes keep
  every file.
- An untracked `.lanesparse` in the main clone (one folder per line, `#` for comments) gives
  every task of that repository its folders; `--sparse` replaces them for one task and
  `--no-sparse` takes everything.
- A reused slot gets what the new task asks for: other folders, or every file again.
  `lane verify` always works on a whole checkout.
- Submodules load only when they sit inside the folders. Untracked files (`.lanecopy` and the
  usual ones) are not copied into a folder of the repository the lane leaves out.
- A monorepo's install can fail when a workspace is outside the folders. A sparse lane then
  says so and is ready without dependencies: add the folder (`git sparse-checkout add`) and
  rerun the install, or take the lane with `--no-sparse`. With `--link-deps` it gets them from a
  whole lane instead (see Dependencies from another lane).
- Checks run in a sparse lane (hooks, `lane sync`, the brief's checks) see only its folders;
  `lane verify` is the check on the whole repository.
- Narrowing a reused slot leaves ignored files (an old `node_modules`) where they were.
- `lane list` shows a slot's folders. `CLAUDE.local.md` and `lane brief` name them and tell the
  agent to add one with `git sparse-checkout add <folder>`, not to turn sparse off.
- A folder missing from the commit (a typo) is named when the lane is made.

## A spare root: when the drive fills up

```sh
setx LANE_ROOT_SPARE E:/wt      # Windows; elsewhere: export LANE_ROOT_SPARE=/mnt/big/wt
setx LANE_MIN_FREE_GB 15        # optional, 10 with a spare root
```

- Only a **new** slot is placed: when the lane root's drive has less than `LANE_MIN_FREE_GB`
  free, it is made in `LANE_ROOT_SPARE`, and lane says so. A free slot is reused where it
  is, on either root, before any new one is made.
- No root with room: `lane new` refuses and prints the free space of each, before anything
  is made. `LANE_MIN_FREE_GB` alone gives that check on the lane root, with no spare.
- Slots of both roots are one pool: one series of numbers (so ports never clash), the same
  holds, `lane list`, `lane clean` and `lane rm`. `.locks` stays in the lane root.
- The spare root is lane's own folder, like the lane root: `lane clean` offers to remove any
  folder in it that is no lane. It may not be the lane root, inside it or around it.
- Keep the variable set while slots live there: without it lane no longer sees them.
- `--link-deps` links from a lane on the same drive (a hard link cannot cross drives); with
  none there, it installs.

### Moving a slot back

```sh
lane move myrepo-3 --to main                 # a free slot
lane move myrepo-3 --to main --lease 4f9a1c  # your own held slot
```

- Once the lane root's drive has `LANE_MIN_FREE_GB` free again, `lane list` names the slots
  on the spare root and the command that moves each back. `--to spare` moves the other way.
- The drive the slot goes to must have `LANE_MIN_FREE_GB` free.
- On one drive git moves the folder with everything in it. Across drives the slot is made
  again at the new root: same branch (or commit), same sparse folders, same hold and pool;
  the old folder is deleted. Dependencies and build caches stay behind, so a slot with
  uncommitted or unpushed work is refused there.
- A held slot moves only for its holder, with the hold's `--lease`; made again, it is set up
  again (dependencies installed). A free slot is locked for the move and left free; the next
  `lane new` that takes it installs its dependencies.
- A slot with a claim or a process in it is not moved.

## Pools: reviews apart from other work

```sh
lane new myrepo --pr 42 --pool review
```

- A slot belongs to the pool it was made in, for good. A task reuses free slots of its own
  pool only, so a review never takes the slot (and caches) of a feature and the other way round.
- Each pool has its own max: `LANE_POOLS="review=2"`; any other pool, and the default one, has
  `LANE_MAX_SLOTS`. A full pool lists its own slots.
- Slot numbers are shared by all pools, so ports never clash. `lane list` shows the pool after
  the slot's name. Slots made before pools existed are in the default pool.
- Holds still decide what is safe: a slot held in any pool is never taken or cleaned.

## Dependencies from another lane

`lane new <repo> <task> --link-deps` (or `LANE_LINK_DEPS=1` for every lane) skips `npm ci` when
another lane of the repository was installed from the same lockfile: the new lane's
`node_modules` folders (the root one and those of workspaces) are made of hard links to that
lane's files.

- Each lane owns its folders. `rm -rf node_modules/` or `npm ci` in one lane changes that lane
  only; the files on disk are shared until one side replaces them.
- Never a junction or symlink to one shared `node_modules`: deleting through one (Git Bash
  `rm -rf node_modules/` with the trailing slash) empties it for every lane.
- The source lane must have installed from this lockfile and still be on it (no `npm install`
  since). Workspace links point into the new lane. `.cache`, `.vite` and `.vitest` are not linked.
- npm only. pnpm already links from its own store. A repository with a `patches/` folder is not
  linked: patch-package rewrites files in place, and a hard link would carry that to the other
  lanes.
- A sparse lane gets the folders of the workspaces it has, so it has dependencies even when
  `npm ci` would fail on the workspaces it left out.
- Anything that fails (another drive, no link rights) falls back to `npm ci`.

## Repository hooks: .lane.json

A `.lane.json` at the root of the main clone names commands of the repository's own: copy a
file lane does not know about, run codegen, start or stop a container.

```json
{
  "postCreate": ["node scripts/copy-env.js", "npm run codegen"],
  "preDone": "docker compose down"
}
```

- `postCreate` runs at the end of `lane new`, in the lane, after the local files, the install and
  `CLAUDE.local.md`. It runs on every `lane new`, in a new or a reused slot: keep the commands
  safe to run twice. `--no-install` does not skip it.
- `preDone` runs in the lane before `lane done`, `lane free` or `lane clean` gives it back
  (after `lane done` checked the work is pushed).
- Each key takes one command line or a list. They run through the shell (cmd.exe on Windows,
  sh elsewhere), one after the other, output shown, and see `LANE_DIR`, `LANE_NAME`,
  `LANE_SLOT` and `LANE_MAIN` (the main clone). Commands that run on every OS: `node`, `npm run`.
- The first command that fails stops the step and names it. A failed `postCreate` leaves the
  lane held (fix it and rerun the command there); a failed `preDone` keeps the lane held and
  nothing is given back. `lane clean` keeps that lane and goes on with the others.
- lane reads the file from the main clone's folder, committed or not, never from the branch a
  lane checks out: `lane new --pr <n>` does not run commands from someone else's pull request.
  A broken file (bad JSON, an unknown key) stops `lane new` before it takes a slot.

## Other agents

`lane new` names Claude Code in the command it prints, and `--open` starts it. `--agent` picks
another agent CLI for both:

```sh
lane new myrepo feat/login --open --agent codex
lane new myrepo feat/login --open --agent "aider --yes"   # any command line, as typed
```

- Known names: `claude` (the default), `codex`, `gemini`, `opencode`, `copilot`, and `cursor`
  (runs `cursor-agent`). Anything else is run as the command line given.
- On Windows the tab runs it through `cmd.exe`, so npm's `.cmd` launchers work and the tab
  keeps a shell in the lane when the agent exits. In tmux, the window runs it through `sh`.
- `CLAUDE.local.md` is read by Claude Code only. Give any other agent `lane brief` at the top of
  its task (or put it in that agent's own instructions file).

## Known

- Removing a lane falls back to a `\\?\` path delete when git hits Windows' path limit, and
  stops the adb server when it holds the folder open.

## Development

```sh
npm run typecheck   # tsc --noEmit: strict, no unused code
npm test            # node --test, runs the .ts tests directly
npm run build       # dist/: the JavaScript the lane command and the npm package run
```

The source runs as is in development (Node strips the types); the package ships `dist`,
since Node does not strip types inside `node_modules`. A release (release-please) publishes
to npm from the `publish` job of `.github/workflows/release.yml`, through trusted publishing.

CI runs both on Ubuntu, Windows and macOS with Node 22.18 and 24.
`npm run diagrams` renders the overview diagram from `docs/diagrams/overview.mmd`.

| File | What is in it |
| --- | --- |
| `bin/lane.ts` | Command line |
| `src/index.ts` | What the command line calls |
| `src/commands.ts` | new, done, free, port, brief |
| `src/housekeeping.ts` | list, clean, rm |
| `src/move.ts` | move: a slot between the lane root and the spare root |
| `src/find.ts` | The lane a command is about |
| `src/integrate.ts` | verify and sync (class `Integration`) |
| `src/resources.ts` | claim, release, with, locks, stats |
| `src/checkout.ts` | `Checkout` (a git folder) and `MainClone extends Checkout` |
| `src/lane.ts` | `Lane extends Checkout`: state, merged, giving back, removal |
| `src/branches.ts` | A task's own branch left behind once the slot moved off it, deleted when it holds nothing |
| `src/meta.ts` | A slot's `lane.json` |
| `src/merged.ts` | Merged work found offline |
| `src/stale.ts` | Left-behind holds, processes using a folder |
| `src/pool.ts` | `SlotPool` and the pure `pickSlot` rule |
| `src/target.ts` | `Target` and its kinds: a new branch, a PR's branch, a fork's, detached |
| `src/setup.ts` | `LaneSetup`: submodules, local files, install, notes, hooks |
| `src/sparse.ts` | Sparse slots (`--sparse`): the folders a lane checks out |
| `src/linkdeps.ts` | `node_modules` hard-linked from a slot installed from the same lockfile (`--link-deps`) |
| `src/hooks.ts` | The repository's `.lane.json` commands (`postCreate`, `preDone`) |
| `src/checks.ts` | Which checks, and running them under the build cap |
| `src/locks.ts`, `src/lock-state.ts` | Locks on shared things, and `lane with` (cost, nesting, low CPU) |
| `src/queue.ts` | The line of commands waiting for a `lane with` resource |
| `src/stats.ts` | The run log of `lane with`, and `lane stats` |
| `src/github.ts` | A lane's pull request through `gh` |
| `src/detect.ts`, `src/worktrees.ts`, `src/text.ts` | Pure helpers |
| `src/fsutil.ts`, `src/proc.ts`, `src/config.ts` | Paths and removal, running programs, settings |
| `src/git-env.ts` | The environment for running git on another repository, without a git hook's variables |
