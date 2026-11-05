#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  cmdBrief, cmdClaim, cmdClean, cmdDone, cmdList, cmdLocks, cmdNew, cmdPort, cmdRelease, cmdRemove, cmdSync,
  cmdVerify, cmdWith, config,
} from '../src/index.ts';

const HELP = `lane: one git worktree per task, so tasks in one repo run side by side

  Lanes are slots: reusable worktrees ${config.root}/<repo>-<n> (up to ${config.maxSlots} per repo),
  held with git worktree lock while a task uses them and given back afterwards, folder,
  dependencies and build caches kept for the next task.

  lane new <repo> <task> [--base B] [--branch NAME] [--no-install] [--open]
      Take a slot for a task: the one it had before, else a free one, else a new one.
      New branch (default: the task name) from origin/develop if it exists, else the default
      branch. Loads submodules, copies untracked .env-type files, installs dependencies only
      when the lockfiles changed, --open starts Claude Code. Its pre-push hook waits for a
      build slot.
  lane new <repo> --pr <n>   A slot on an existing pull request's branch (to test or finish it)
  lane done [<lane>] [--force]
                             Give the slot back once its work is pushed (or the PR merged)
  lane list [--local]        Every lane: held/free, branch, local changes, PR and CI
  lane clean [--yes]         Give back the slots whose PR merged; --yes does it and pulls the main clone
  lane rm <lane> [--force]   Delete a slot for good (--force: held or with unpushed work)
  lane port <usual port>     The port for a dev server in this slot: the usual port + the slot number

  lane verify <repo> [--cmd C]... [--keep]
      Merge all open lanes of a repo together in a throwaway checkout and run the checks:
      finds lanes that merge cleanly but break each other, before the first one merges.
  lane sync <repo> [--push] [--cmd C]...
      After a lane merged: rebase the other lanes onto the new base and run their checks again.
  lane brief [<lane>]        The rules for an agent working in a lane, to paste into its task

  lane claim <res> [--no-wait]  Hold a shared thing (e.g. emulator) for this lane; waits if busy
  lane release <res>            Give it back
  lane with <res> [--slots N] -- <command>
                                Run a command holding one of N slots (default: build has 2)
  lane locks                    Who holds what

  Checks: --cmd, else a .lanecheck file in the main clone (one command per line), else the
  package.json scripts typecheck/lint/test, flutter analyze/test, cargo test or go test.
  <repo> is a folder in ${config.repos}. Env: LANE_ROOT, LANE_REPOS, LANE_MAX_SLOTS.`;

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
    'no-install': { type: 'boolean', default: false },
    open: { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    push: { type: 'boolean', default: false },
    cmd: { type: 'string', multiple: true },
    'no-wait': { type: 'boolean', default: false },
    slots: { type: 'string' },
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

function prNumber(): number | undefined {
  if (values.pr === undefined) return undefined;
  const n = Number(values.pr);
  if (!Number.isInteger(n) || n < 1) throw new Error('--pr must be a pull request number');
  return n;
}

function main(): number {
  const [cmd, a, b, ...extra] = positionals;
  const one = a !== undefined && b === undefined;
  if (values.help || !cmd) {
    console.log(HELP);
    return 0;
  }
  const pr = prNumber();
  if (cmd === 'new' && a !== undefined && extra.length === 0 && (b !== undefined || pr !== undefined)) {
    cmdNew(a, b, { base: values.base, branch: values.branch, pr, install: !values['no-install'], open: values.open });
  } else if (cmd === 'list') cmdList({ local: values.local });
  else if (cmd === 'clean') cmdClean({ yes: values.yes });
  else if (cmd === 'rm' && one) cmdRemove(a, { force: values.force });
  else if (cmd === 'verify' && one) return cmdVerify(a, { cmds: values.cmd, keep: values.keep });
  else if (cmd === 'sync' && one) return cmdSync(a, { cmds: values.cmd, push: values.push });
  else if (cmd === 'brief' && b === undefined) cmdBrief(a);
  else if (cmd === 'done' && b === undefined) cmdDone(a, { force: values.force });
  else if (cmd === 'port' && one) {
    const base = Number(a);
    if (!Number.isInteger(base) || base < 1 || base > 65535) throw new Error('lane port needs a port number');
    cmdPort(base);
  }
  else if (cmd === 'claim' && one) cmdClaim(a, { noWait: values['no-wait'] });
  else if (cmd === 'release' && one) cmdRelease(a);
  else if (cmd === 'locks') cmdLocks();
  else if (cmd === 'with' && one && tail.length > 0) {
    const slots = Number(values.slots ?? (a === 'build' ? 2 : 1));
    if (!Number.isInteger(slots) || slots < 1) throw new Error('--slots must be a whole number >= 1');
    return cmdWith(a, slots, tail);
  } else {
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
