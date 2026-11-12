#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  cmdBrief, cmdClaim, cmdClean, cmdDone, cmdFree, cmdList, cmdLocks, cmdNew, cmdPort, cmdRelease, cmdRemove,
  cmdSync, cmdVerify, cmdWith, config,
} from '../src/index.ts';

const HELP = `lane: one git worktree per task, so tasks in one repo run side by side

  Lanes are slots: reusable worktrees ${process.env.LANE_ROOT || '$LANE_ROOT'}/<repo>-<n> (up to ${config.maxSlots} per repo),
  held with git worktree lock while a task uses them and given back afterwards, folder,
  dependencies and build caches kept for the next task.

  lane new <repo> <task> [--base B] [--branch NAME] [--no-install] [--open]
      Take a slot for a task: the one it had before, else a free one, else a new one. New
      branch (default: the task name) from origin/develop if it exists, else the default
      branch. Submodules, untracked .env-type files, dependencies (only when the lockfiles
      changed), CLAUDE.local.md; --open starts Claude Code in a new Windows Terminal tab,
      or a tmux window inside tmux (elsewhere it prints the command). Prints the hold's lease.
      --sparse <folder> (repeatable): check out only those folders and the root files, for
      a big repository; a .lanesparse file in the main clone sets them for every task,
      --no-sparse takes everything. A reused slot gets what the new task asks for.
      --link-deps (or LANE_LINK_DEPS=1): npm's node_modules as hard links from a lane
      installed from the same lockfile, instead of npm ci; each lane owns its folders.
      --pool <name> (e.g. review): a slot of that pool only, so reviews and other work never
      take each other's slots; LANE_POOLS="review=2" sets a pool's own max.
  lane new <repo> --pr <n>   A slot on an existing pull request's branch (to test or finish it)
  lane done [<lane>] [--lease ID] [--force]
                             Give the slot back once its work is pushed or merged; with --lease,
                             only while the slot is still held under that lease
  lane free <lane> [--yes] [--force]
                             Free a hold that looks abandoned (hours unchanged, no process in it)
  lane list [--local]        Every lane: held/free (or abandoned), branch, local changes, PR and CI
  lane clean [--yes] [--force]
                             Give back the slots whose work merged (GitHub, or found offline),
                             then pull the main clones. A slot still held stays (follow-up
                             rounds reuse it) unless --force; one with a claim or a process
                             in it always stays
  lane rm <lane> [--force]   Delete a slot for good (--force: held or with unpushed work)
  lane port <usual port> [k] Port k of this slot's range: usual + slot x ${config.portStride} + k

  lane verify <repo> [--cmd C]... [--keep]
      Merge all open lanes of a repo together in a slot and run the checks: finds lanes that
      merge cleanly but break each other, before the first one merges.
  lane sync <repo> [--push] [--cmd C]...
      After a lane merged: rebase the other lanes onto the new base and run their checks again.
      Skips lanes with local changes, a claim or a process in them, or no history in common.
  lane brief [<lane>]        The rules for an agent working in a lane, to paste into its task

  lane claim <res> [--no-wait]  Hold a shared thing (e.g. emulator); ends with this lane's hold
  lane release <res>            Give it back
  lane with <res> [--slots N] -- <command>
                                Run a command holding one of N slots (default: build has 2)
  lane locks                    Who holds what

  Checks: --cmd, else a .lanecheck file in the main clone (one command per line), else the
  package.json scripts typecheck/lint/test, flutter analyze/test, cargo test or go test.
  <repo> is a folder in ${process.env.LANE_REPOS || '$LANE_REPOS'}.
  Env: LANE_ROOT and LANE_REPOS (required, no default), LANE_MAX_SLOTS, LANE_PORT_STRIDE.`;

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
    });
  } else if (cmd === 'list') cmdList({ local: values.local });
  else if (cmd === 'clean') cmdClean({ yes: values.yes, force: values.force });
  else if (cmd === 'rm' && one) cmdRemove(a, { force: values.force });
  else if (cmd === 'verify' && one) return cmdVerify(a, { cmds: values.cmd, keep: values.keep });
  else if (cmd === 'sync' && one) return cmdSync(a, { cmds: values.cmd, push: values.push });
  else if (cmd === 'brief' && b === undefined) cmdBrief(a);
  else if (cmd === 'done' && b === undefined) cmdDone(a, { force: values.force, lease: values.lease });
  else if (cmd === 'free' && one) cmdFree(a, { yes: values.yes, force: values.force });
  else if (cmd === 'port' && a !== undefined && extra.length === 0) {
    cmdPort(whole(a, 'the port', 1, 65535), b === undefined ? 0 : whole(b, 'the port offset', 0, config.portStride - 1));
  } else if (cmd === 'claim' && one) cmdClaim(a, { noWait: values['no-wait'] });
  else if (cmd === 'release' && one) cmdRelease(a);
  else if (cmd === 'locks') cmdLocks();
  else if (cmd === 'with' && one && tail.length > 0) {
    return cmdWith(a, tail, whole(values.slots ?? (a === 'build' ? '2' : '1'), '--slots', 1, 64));
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
