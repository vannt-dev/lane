#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  cmdBrief, cmdBump, cmdClaim, cmdClean, cmdDone, cmdFree, cmdList, cmdLocks, cmdMove, cmdNew, cmdPort, cmdRelease, cmdRemove,
  BISECT_MAX, cmdStats, cmdSync, cmdTune, cmdVerify, cmdWith, config, withSlotsFor,
} from '../src/index.ts';

const HELP = `lane: one git worktree per task, so tasks in one repo run side by side

  Lanes are slots: reusable worktrees ${process.env.LANE_ROOT || '$LANE_ROOT'}/<repo>-<n> (up to ${config.maxSlots} per repo),
  held with git worktree lock while a task uses them and given back afterwards, folder,
  dependencies and build caches kept for the next task.

  lane new <repo> <task> [--base B] [--branch NAME] [--no-install] [--open [--agent A]]
      Take a slot for a task: the one it had before, else a free one, else a new one. New
      branch (default: the task name) from origin/develop if it exists, else the default
      branch. Submodules, untracked .env-type files, dependencies (only when the lockfiles
      changed), CLAUDE.local.md; --open starts Claude Code in a new Windows Terminal tab,
      or a tmux window inside tmux (elsewhere it prints the command). Prints the hold's lease.
      --agent <name or command>: start (or print) another agent instead of Claude Code:
      codex, gemini, opencode, copilot, cursor, or any command line ("aider --yes").
      --sparse <folder> (repeatable): check out only those folders and the root files, for
      a big repository; a .lanesparse file in the main clone sets them for every task,
      --no-sparse takes everything. A reused slot gets what the new task asks for.
      --link-deps (or LANE_LINK_DEPS=1): npm's node_modules as hard links from a lane
      installed from the same lockfile, instead of npm ci; each lane owns its folders.
      --pool <name> (e.g. review): a slot of that pool only, so reviews and other work never
      take each other's slots; LANE_POOLS="review=2" sets a pool's own max.
      A .lane.json in the main clone runs the repository's own commands: "postCreate" at
      the end of lane new, "preDone" before a lane is given back.
  lane new <repo> --pr <n>   A slot on an existing pull request's branch (to test or finish it)
                             (detached at its head when the branch is checked out elsewhere)
  lane done [<lane>] [--lease ID] [--force]
                             Give the slot back once its work is pushed or merged; with --lease,
                             only while the slot is still held under that lease
  lane free <lane> [--yes] [--force]
                             Free a hold that looks abandoned (hours unchanged, no process in it)
  lane list [--local] [--json]
                             Every lane: held/free (or abandoned), branch, local changes, PR and CI;
                             --json: one JSON array on stdout, for scripts and agents
  lane clean [--yes] [--force]
                             Give back the slots whose work merged (GitHub, or found offline),
                             then pull the main clones. A slot still held stays (follow-up
                             rounds reuse it) unless --force; one with a claim or a process
                             in it always stays
  lane rm <lane> [--force]   Delete a slot for good (--force: held or with unpushed work)
  lane move <lane> --to main|spare [--lease ID]
                             Move a slot to the lane root or the spare one (lane list says when
                             the lane root has room again). Across drives the slot is made
                             again: only with its work pushed; a held slot with its --lease
  lane port <usual port> [k] Port k of this slot's range: usual + slot x ${config.portStride} + k

  lane verify <repo> [--cmd C]... [--keep] [--no-bisect] [--bisect-max N]
      Merge all open lanes of a repo together in a slot and run the checks: finds lanes that
      merge cleanly but break each other, before the first one merges. A conflict names the
      lanes and files. When the checks fail it looks for the lanes to blame: each lane alone
      on the base, then each pair, in at most N more check runs (default ${BISECT_MAX});
      --no-bisect skips that search.
  lane sync <repo> [--push] [--cmd C]...
      After a lane merged: rebase the other lanes onto the new base and run their checks again.
      Skips lanes with local changes, a claim or a process in them, or no history in common.
  lane brief [<lane>]        The rules for an agent working in a lane, to paste into its task

  lane claim <res> [--no-wait]  Hold a shared thing (e.g. emulator); ends with this lane's hold
  lane release <res>            Give it back
  lane with <res> [--slots N] [--cost K] [--prio high] [--label L] -- <command>
                                Run a command holding K of the resource's N slots, waiting in
                                line (--prio high: ahead of normal waiters), at below-normal CPU
                                priority (LANE_LOW_CPU=0: normal). K: --cost, else 2 for test
                                runs, tsc, builds, browsers and docker, 1 for the rest. N: build
                                suits the machine (see lane tune), others 1; LANE_WITH_SLOTS=
                                "build=6" sets them. Beside a running command it also waits for
                                LANE_WITH_MIN_FREE_GB of free memory; a later, lighter command
                                may pass for LANE_WITH_PASS_MIN (10) minutes; one test run or
                                build per node_modules; vitest gets --maxWorkers; docker compose
                                up needs -d. A nested lane with of the same resource runs at once.
  lane locks [--json]           Who holds what, and who waits in line
  lane bump <text>              Move waiting commands whose label or lane holds text to the front
  lane stats [--days N]         Waiting and running times of lane with commands (default 7 days)
  lane tune                     Slots, test workers and free memory that suit this machine

  Checks: --cmd, else a .lanecheck file in the main clone (one command per line), else the
  package.json scripts typecheck/lint/test, flutter analyze/test, cargo test or go test.
  <repo> is a folder in ${process.env.LANE_REPOS || '$LANE_REPOS'}.
  Env: LANE_ROOT and LANE_REPOS (required, no default), LANE_MAX_SLOTS, LANE_PORT_STRIDE,
  LANE_ROOT_SPARE (a second folder for new slots once the lane root's drive has less than
  LANE_MIN_FREE_GB free; 10 GB when not set).`;

// Everything after "--" is the command for `lane with`, passed through untouched.
const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const tail = dash >= 0 ? argv.slice(dash + 1) : [];
const options = {
  args: dash >= 0 ? argv.slice(0, dash) : argv,
  allowPositionals: true,
  options: {
    base: { type: 'string' },
    branch: { type: 'string' },
    pr: { type: 'string' },
    lease: { type: 'string' },
    'no-install': { type: 'boolean', default: false },
    sparse: { type: 'string', multiple: true },
    'no-sparse': { type: 'boolean', default: false },
    'link-deps': { type: 'boolean' },
    pool: { type: 'string' },
    to: { type: 'string' },
    open: { type: 'boolean', default: false },
    agent: { type: 'string' },
    local: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    'no-bisect': { type: 'boolean', default: false },
    'bisect-max': { type: 'string' },
    push: { type: 'boolean', default: false },
    cmd: { type: 'string', multiple: true },
    'no-wait': { type: 'boolean', default: false },
    slots: { type: 'string' },
    cost: { type: 'string' },
    prio: { type: 'string' },
    label: { type: 'string' },
    days: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
} as const;

let parsed: ReturnType<typeof parseArgs<typeof options>>;
try {
  parsed = parseArgs(options);
} catch (e) {
  console.error(`lane: ${e instanceof Error ? e.message.split('\n')[0] : String(e)} (see: lane --help)`);
  process.exit(2);
}
const { values, positionals } = parsed;

/** A whole number in [min, max], or an error naming what it is. */
function whole(text: string, what: string, min: number, max: number): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be a whole number from ${min} to ${max}`);
  return n;
}

function main(): number {
  const [cmd, a, b, ...extra] = positionals;
  const one = a !== undefined && b === undefined;
  if (values.help || !cmd) {
    console.log(HELP);
    return 0;
  }
  const pr = values.pr === undefined ? undefined : whole(values.pr, '--pr', 1, Number.MAX_SAFE_INTEGER);
  if (cmd === 'new' && a !== undefined && extra.length === 0 && (b !== undefined || pr !== undefined)) {
    cmdNew(a, b, {
      base: values.base, branch: values.branch, pr, install: !values['no-install'], open: values.open,
      sparse: values.sparse, full: values['no-sparse'], linkDeps: values['link-deps'], pool: values.pool,
      agent: values.agent,
    });
  } else if (cmd === 'list') cmdList({ local: values.local, json: values.json });
  else if (cmd === 'clean') cmdClean({ yes: values.yes, force: values.force });
  else if (cmd === 'rm' && one) cmdRemove(a, { force: values.force });
  else if (cmd === 'move' && one && values.to !== undefined) cmdMove(a, { to: values.to, lease: values.lease });
  else if (cmd === 'verify' && one) {
    const bisectMax = values['bisect-max'] === undefined ? undefined : whole(values['bisect-max'], '--bisect-max', 0, 1000);
    return cmdVerify(a, { cmds: values.cmd, keep: values.keep, bisect: !values['no-bisect'], bisectMax });
  }
  else if (cmd === 'sync' && one) return cmdSync(a, { cmds: values.cmd, push: values.push });
  else if (cmd === 'brief' && b === undefined) cmdBrief(a);
  else if (cmd === 'done' && b === undefined) cmdDone(a, { force: values.force, lease: values.lease });
  else if (cmd === 'free' && one) cmdFree(a, { yes: values.yes, force: values.force });
  else if (cmd === 'port' && a !== undefined && extra.length === 0) {
    cmdPort(whole(a, 'the port', 1, 65535), b === undefined ? 0 : whole(b, 'the port offset', 0, config.portStride - 1));
  } else if (cmd === 'claim' && one) cmdClaim(a, { noWait: values['no-wait'] });
  else if (cmd === 'release' && one) cmdRelease(a);
  else if (cmd === 'locks' && a === undefined) cmdLocks({ json: values.json });
  else if (cmd === 'bump' && one) return cmdBump(a) > 0 ? 0 : 1;
  else if (cmd === 'tune' && a === undefined) cmdTune();
  else if (cmd === 'with' && one && tail.length > 0) {
    if (values.prio !== undefined && values.prio !== 'high' && values.prio !== 'normal') throw new Error('--prio takes high or normal');
    return cmdWith(a, tail, values.slots === undefined ? withSlotsFor(a) : whole(values.slots, '--slots', 1, 64), {
      cost: values.cost === undefined ? undefined : whole(values.cost, '--cost', 1, 64),
      prio: values.prio, label: values.label,
    });
  } else if (cmd === 'stats' && a === undefined) cmdStats(values.days === undefined ? 7 : whole(values.days, '--days', 1, 365));
  else {
    console.error(HELP);
    return 2;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`lane: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
