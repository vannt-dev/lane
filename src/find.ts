// The lane a command is about: named, or the one it runs in.
import { isInside, samePath } from './fsutil.ts';
import { Lane } from './lane.ts';

export function findLane(name?: string): Lane {
  const cwd = process.cwd();
  const lane = Lane.all().find((l) =>
    name ? l.name.toLowerCase() === name.toLowerCase() : samePath(l.dir, cwd) || isInside(cwd, l.dir));
  if (!lane) throw new Error(name ? `no lane called ${name} (see: lane list --local)` : 'not inside a lane; name one');
  return lane;
}
