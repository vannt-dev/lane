// The checks a lane must pass, and running them under the build cap.
import fs from 'node:fs';
import path from 'node:path';
import type { Checkout } from './checkout.ts';
import { config } from './config.ts';
import { checkCommands } from './detect.ts';
import type { Holder } from './lock-state.ts';
import { Locks } from './locks.ts';
import { listLines, log } from './text.ts';

export const locks = () => new Locks(config.root);

/** Check commands for a checkout: --cmd, else the main clone's `.lanecheck`, else detected. */
export function checksFor(mainClone: Checkout, checkout: Checkout, custom?: readonly string[]): string[] {
  let scripts: Record<string, string> | undefined;
  try {
    scripts = (JSON.parse(checkout.readFile('package.json') ?? '{}') as { scripts?: Record<string, string> }).scripts;
  } catch {
    scripts = undefined;
  }
  const listed = custom?.length ? custom : listLines(mainClone.readFile('.lanecheck') ?? '');
  return checkCommands({ files: fs.readdirSync(checkout.dir), scripts, custom: listed });
}

/** Runs each check in a checkout, each holding a build slot; stops at the first failure. */
export function runChecks(checkout: Checkout, cmds: readonly string[]): { ok: boolean; failed?: string } {
  const holder: Holder = { lane: path.basename(checkout.dir), lanePath: checkout.dir };
  for (const c of cmds) {
    log(`> ${c}   (in ${holder.lane})`);
    if (locks().withSlot('build', 2, holder, [c], { cwd: checkout.dir }) !== 0) return { ok: false, failed: c };
  }
  return { ok: true };
}
