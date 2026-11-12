// A repository's own steps around a lane: `.lane.json` in the main clone names commands to run
// after a lane is set up (`postCreate`) and before it is given back (`preDone`).
import type { Checkout } from './checkout.ts';
import type { Lane } from './lane.ts';
import { runLive } from './proc.ts';
import { log } from './text.ts';

export const HOOKS_FILE = '.lane.json';

export interface LaneHooks {
  /** After `lane new` set a lane up (local files copied, dependencies installed). */
  postCreate: string[];
  /** Before `lane done`, `lane free` or `lane clean` gives a lane back. */
  preDone: string[];
}

const KEYS = ['postCreate', 'preDone'] as const;

/** The hooks in a `.lane.json` text: each key a command line or a list of them; none when absent. */
export function parseHooks(text: string | null): LaneHooks {
  const hooks: LaneHooks = { postCreate: [], preDone: [] };
  if (text === null) return hooks;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${HOOKS_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new Error(`${HOOKS_FILE} must be an object like {"postCreate": ["npm run codegen"]}`);
  for (const [key, value] of Object.entries(data)) {
    if (key === '$schema') continue;
    if (!(KEYS as readonly string[]).includes(key)) throw new Error(`${HOOKS_FILE}: unknown key "${key}" (known: ${KEYS.join(', ')})`);
    const list = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list) || !list.every((c) => typeof c === 'string' && c.trim() !== ''))
      throw new Error(`${HOOKS_FILE}: "${key}" must be a command line or a list of them`);
    hooks[key as keyof LaneHooks] = list.map((c: string) => c.trim());
  }
  return hooks;
}

/** The hooks a main clone names, in its working copy (committed or not). */
export function hooksFor(clone: Checkout): LaneHooks {
  return parseHooks(clone.readFile(HOOKS_FILE));
}

/**
 * Runs one hook's commands in the lane, output shown live, through the shell. Each sees
 * LANE_DIR, LANE_NAME, LANE_SLOT and LANE_MAIN (the main clone). Stops at the first failure.
 */
export function runHook(lane: Lane, key: keyof LaneHooks, cmds: readonly string[], then: string): void {
  const env = { LANE_DIR: lane.dir, LANE_NAME: lane.name, LANE_SLOT: String(lane.slot ?? ''), LANE_MAIN: lane.clone.dir };
  for (const c of cmds) {
    log(`> ${c}   (${HOOKS_FILE} ${key})`);
    if (!runLive(c, lane.dir, env)) throw new Error(`${HOOKS_FILE} ${key} "${c}" failed in ${lane.dir}; ${then}`);
  }
}

/** The repository's `preDone` commands, before a lane is given back; a failure keeps it held. */
export function beforeGiveBack(lane: Lane): void {
  runHook(lane, 'preDone', hooksFor(lane.clone).preDone, `${lane.name} is still held; fix it and give it back again`);
}
