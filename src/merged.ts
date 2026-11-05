// Whether a lane's work is in the base branch already, found offline (no GitHub needed).
import type { Checkout } from './checkout.ts';

/** Patch ids (`git patch-id --stable`) of the commits or the single diff in `patch`. */
function patchIds(c: Checkout, patch: string): string[] {
  if (!patch) return [];
  const out = c.tryGitInput(patch, 'patch-id', '--stable') ?? '';
  return out.split(/\r?\n/).filter(Boolean).map((l) => l.split(' ')[0] ?? '');
}

/**
 * True when the work from `start` to HEAD is in `base` already:
 * - HEAD is an ancestor of base (a fast-forward or a merge commit),
 * - merging HEAD into base changes nothing (a squash merge, base moved on elsewhere), or
 * - HEAD's whole change has the patch id of one commit on base (a squash merge whose lines
 *   were touched again later).
 * A lane still on its start commit has no work yet: never "merged".
 */
export function mergedInto(c: Checkout, base: string, start?: string): boolean {
  const head = c.tryGit('rev-parse', 'HEAD');
  if (!head || head === start) return false;
  const mb = c.tryGit('merge-base', 'HEAD', base);
  if (!mb) return false;
  if (mb === head) return true;
  const tree = c.tryGit('merge-tree', '--write-tree', base, 'HEAD')?.split(/\r?\n/)[0];
  if (tree && tree === c.tryGit('rev-parse', `${base}^{tree}`)) return true;
  const [own] = patchIds(c, c.tryGit('diff', mb, 'HEAD') ?? '');
  if (!own) return false;
  return patchIds(c, c.tryGit('log', '-p', '--no-merges', '--format=commit %H', `${mb}..${base}`) ?? '').includes(own);
}
