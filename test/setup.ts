// Preloaded into every test process (node --import): the suite may be run by a git hook, and the
// repository variables a hook exports would make every git call in the tests hit the hook's repository.
import { gitEnv } from '../src/git-env.ts';

const clean = gitEnv();
for (const key of Object.keys(process.env)) {
  if (!(key in clean)) delete process.env[key];
}
// The suite may itself run inside `lane with` (LANE_WITH would make every withSlot run at once,
// holding nothing) or on a machine short of memory (the free-memory gate would hold a test that
// keeps a slot busy). Tests of those rules pass their own values.
for (const key of Object.keys(process.env)) {
  if (/^LANE_(WITH|VITEST_WORKERS)/.test(key)) delete process.env[key];
}
process.env.LANE_WITH_MIN_FREE_GB = '0';
// calmrun installed on the machine (or the suite run inside a calmrun job) would take over every
// lane with; the calmrun tests put a fake one on PATH and turn this back on.
process.env.LANE_CALMRUN = '0';
delete process.env.CALMRUN_HELD;
