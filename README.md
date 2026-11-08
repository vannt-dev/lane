# lane

Run several tasks of one git repository at the same time, each in its own worktree (a
"lane"), usually with one coding agent per lane, without the tasks stepping on each other.

Lanes are **slots**: numbered worktrees `<lane root>/<repo>-<n>` that are reused. A task
holds a slot with `git worktree lock` and gives it back when its work is pushed; the folder,
its dependencies and build caches stay, so the next task starts in seconds instead of
checking out and installing again.

## Install

```sh
git clone https://github.com/vannt-dev/lane && cd lane
npm install && npm link    # puts `lane` on PATH
setx LANE_REPOS D:/code    # Windows; elsewhere export both in your shell profile
setx LANE_ROOT D:/wt
```

`LANE_REPOS` and `LANE_ROOT` have no default: lane stops with a message until both are set.

Node 22.18+, git, and `gh` (logged in) for pull request and CI state. Written in TypeScript
and run as is (Node strips the types, no build step); `npm install` only brings the type
checker. Install from a clone as above: Node does not run `.ts` files inside `node_modules`.

| Variable | Meaning |
| --- | --- |
| `LANE_REPOS` | Required. `<repos folder>`: the folder holding the main clones; `<repo>` names one of them |
| `LANE_ROOT` | Required. `<lane root>`: the folder for the slots (and `.locks`) |
| `LANE_MAX_SLOTS` | Slots per repository (default 4) |
| `LANE_PORT_STRIDE` | Ports per slot (default 10): slot n owns the usual port + n x stride onwards |

## Commands

| Command | What it does |
| --- | --- |
| `lane new <repo> <task>` | Takes a slot for the task: the slot it had before, else a free one, else a new one (up to `LANE_MAX_SLOTS`). Locks it (`<task> @ <time> #<lease>`; the lease names this hold), puts it on a new branch (the task name, or `--branch`) from `origin/develop` if the repository has one, else the default branch (`--base` to choose). Loads submodules, copies untracked `.env`, `.env.local`, `android/key.properties`, `.claude/settings.local.json` (more in an untracked `.lanecopy`), installs dependencies only when the lockfiles changed since the slot last installed (`--no-install` to skip), writes `CLAUDE.local.md`. `--open` starts Claude Code in a new terminal tab. |
| `lane new <repo> --pr <n>` | The same, on an existing pull request's branch (tracking it), or on a local `pr-<n>` branch for a PR from a fork. |
| `lane done [<lane>] [--lease ID] [--force]` | Gives the slot back once its work is safe: nothing uncommitted, and its commits on the remote or merged (see Merged). Detaches, deletes the local branch when safe, unlocks. With `--lease`, only while the slot is still held under that lease: a late give-back from a task that already ended never frees the task that came after. `--force` keeps unpushed commits on the local branch. |
| `lane free <lane> [--yes] [--force]` | Frees a hold that looks abandoned (see Left-behind holds). Never when work in it would be lost. `--force` frees one that does not look abandoned. |
| `lane list [--local]` | Every lane: held (task, for how long, and whether it looks abandoned) or free, branch, local changes, PR and CI (`--local`: no GitHub calls). |
| `lane clean [--yes] [--force]` | Gives back the lanes whose work merged (see Merged), removes lanes whose folder is gone and leftover folders, then fast-forwards the main clones. A merged lane still held stays, since follow-up rounds (review fixes, bugs) reuse it, unless its hold looks abandoned or `--force`; one with a claim or a process in it always stays. |
| `lane rm <lane> [--force]` | Deletes a slot for good. Refuses a held slot or unpushed work without `--force`. |
| `lane port <usual port> [k]` | Port k (0 to stride - 1) of this slot's range: the usual port + slot x `LANE_PORT_STRIDE` + k. |
| `lane verify <repo> [--cmd C]... [--keep]` | Merges every open lane of the repository on top of the base, in a slot of the pool, and runs the checks: finds lanes that merge cleanly as text but break each other, before the first one merges. Kept and held when it fails, to look at. |
| `lane sync <repo> [--push] [--cmd C]...` | After a lane merged: rebases the other lanes onto the new base (a conflicting rebase is aborted and the lane left as it was), reinstalls when a lockfile changed, runs the checks. `--push` force-pushes (with lease) those that pass. Skips lanes with local changes, a claim or a process in them, and lanes with no history in common with the base (rewritten history: move that work by hand). |
| `lane brief [<lane>]` | The rules for an agent working in a lane, to paste at the top of its task: an agent started by another session does not read `CLAUDE.local.md`. |
| `lane claim <res>` / `lane release <res>` | Takes and gives back something only one lane may use (the Android emulator). `claim` waits; `--no-wait` fails instead. A claim ends with the lane hold it was made under. |
| `lane with <res> [--slots N] -- <cmd>` | Runs a command holding one of N slots; `build` has 2 (RAM). |
| `lane locks` | Who holds what. |

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

## How the lanes share

- All lanes of a repository share one `.git`: a commit or fetch in one is seen in the others.
  A branch can be checked out in one lane at a time, so `lane done` detaches the slot.
- Each slot has its own files, dependencies and build output; package caches (pnpm store,
  npm cache, Flutter pub cache) are shared by the tools themselves.
- Locks on shared things live in `<lane root>/.locks`. A `claim` holds until released, its
  lane hold ends, its lane is removed, or three hours pass; a `with` slot is freed when its command ends.
- `CLAUDE.local.md` (ignored through `.git/info/exclude`) tells Claude Code in the lane to
  claim the emulator, run heavy builds through `lane with build`, use `lane port`, keep one
  PR per lane, leave versions and the CHANGELOG alone, and give the slot back when done.
- A repository with a `pre-push` hook (lefthook and husky run the tests there) gets, in each
  lane, its own hooks folder (`core.hooksPath` in the worktree's config): `pre-push` waits for
  a build slot, the other hooks run as before.
- `verify` and `sync` merge and rebase with the repository's hooks off.

## Known

- Removing a lane falls back to a `\\?\` path delete when git hits Windows' path limit, and
  stops the adb server when it holds the folder open.

## Development

```sh
npm run typecheck   # tsc --noEmit: strict, no unused code
npm test            # node --test, runs the .ts tests directly
```

CI runs both on Windows and Ubuntu with Node 22.18. Every file stays under 150 lines.

| File | What is in it |
| --- | --- |
| `bin/lane.ts` | Command line |
| `src/index.ts` | What the command line calls |
| `src/commands.ts` | new, done, free, port, brief |
| `src/housekeeping.ts` | list, clean, rm |
| `src/find.ts` | The lane a command is about |
| `src/integrate.ts` | verify and sync (class `Integration`) |
| `src/resources.ts` | claim, release, with, locks |
| `src/checkout.ts` | `Checkout` (a git folder) and `MainClone extends Checkout` |
| `src/lane.ts` | `Lane extends Checkout`: state, merged, giving back, removal |
| `src/meta.ts` | A slot's `lane.json` |
| `src/merged.ts` | Merged work found offline |
| `src/stale.ts` | Left-behind holds, processes using a folder |
| `src/pool.ts` | `SlotPool` and the pure `pickSlot` rule |
| `src/target.ts` | `Target` and its kinds: a new branch, a PR's branch, a fork's, detached |
| `src/setup.ts` | `LaneSetup`: submodules, local files, install, notes, hooks |
| `src/checks.ts` | Which checks, and running them under the build cap |
| `src/locks.ts`, `src/lock-state.ts` | Locks on shared things |
| `src/github.ts` | A lane's pull request through `gh` |
| `src/detect.ts`, `src/worktrees.ts`, `src/text.ts` | Pure helpers |
| `src/fsutil.ts`, `src/proc.ts`, `src/config.ts` | Paths and removal, running programs, settings |
