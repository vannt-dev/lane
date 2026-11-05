// What lane keeps about a slot: `lane.json` inside the worktree's own git folder, so it goes
// away with the worktree and is never part of the checkout.
import fs from 'node:fs';
import path from 'node:path';
import { tryRun } from './proc.ts';

export interface SlotMeta {
  /** The task the slot holds, or held last. */
  task?: string;
  /** Id of the current hold: a give-back or a claim made under another hold is refused or stale. */
  lease?: string;
  /** The commit the task started from: a lane still there has no work of its own yet. */
  start?: string;
  released?: boolean;
  releasedAt?: number;
  /** Stamp of the lockfiles the slot last installed from. */
  installStamp?: string;
}

function metaFile(dir: string): string | null {
  const gitDir = tryRun('git', ['rev-parse', '--git-dir'], dir);
  return gitDir ? path.join(path.resolve(dir, gitDir), 'lane.json') : null;
}

export function readMeta(dir: string): SlotMeta {
  const file = metaFile(dir);
  try {
    return file ? (JSON.parse(fs.readFileSync(file, 'utf8')) as SlotMeta) : {};
  } catch {
    return {};
  }
}

export function writeMeta(dir: string, change: SlotMeta): void {
  const file = metaFile(dir);
  if (!file) throw new Error(`${dir} is not a git checkout`);
  fs.writeFileSync(file, `${JSON.stringify({ ...readMeta(dir), ...change }, null, 2)}\n`);
}

/** The lease of the hold a checkout is under now; none once the slot was given back. */
export function currentLease(dir: string): string | undefined {
  const m = readMeta(dir);
  return m.released ? undefined : m.lease;
}
