// A lane's pull request on GitHub, through the gh CLI.
import { checksState, type Check, type ChecksState } from './detect.ts';
import { tryRun } from './proc.ts';

export interface Pr {
  number: number;
  state: string;
  checks: ChecksState;
  /** The last commit of the PR's branch. */
  head: string;
}

/** The newest pull request from `branch` in `slug` (any state), or null. */
export function prFor(slug: string | null, branch: string): Pr | null {
  if (!slug || !branch) return null;
  const out = tryRun('gh', ['pr', 'list', '-R', slug, '--head', branch, '--state', 'all', '--limit', '1',
    '--json', 'number,state,statusCheckRollup,headRefOid']);
  const [pr] = out ? (JSON.parse(out) as { number: number; state: string; statusCheckRollup: Check[]; headRefOid: string }[]) : [];
  return pr ? { number: pr.number, state: pr.state, checks: checksState(pr.statusCheckRollup), head: pr.headRefOid } : null;
}
