// Puts the recorded run (docs/replay/lane.jsonl, from record.sh) into docs/index.html, between
// <!-- replay:log --> and <!-- /replay:log -->, and the final numbers into the meters.
//   node docs/replay/render.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, '..', 'index.html');
const steps = fs.readFileSync(path.join(here, 'lane.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (o) => Object.entries(o).map(([k, v]) => ` data-${k}="${v}"`).join('');

// Which part of the round each recorded line belongs to (the list beside the log).
const stage = (cmd) =>
  cmd.startsWith('lane new') ? 0 : cmd.startsWith('#') || (cmd === 'lane list --local' && !done.clean) ? 1
    : cmd.startsWith('lane verify') ? 2 : cmd.startsWith('gate:') ? 3 : cmd.startsWith('lane sync') ? 4 : 5;
const done = { clean: false };

// The numbers the meters show after each command, read from what the commands printed.
let held = 0;
let tests = 0;
const meters = {};
const lines = [];
for (const s of steps) {
  const st = stage(s.cmd);
  if (s.cmd.startsWith('lane clean')) done.clean = true;
  const out = s.out.split(/\r?\n/);
  if (s.cmd.startsWith('lane new')) held++;
  held -= out.filter((l) => /^gave back /.test(l) && !/\(was: verify\)/.test(l)).length;
  for (const l of out) tests += Number(l.match(/^\s*Tests\s+(\d+) passed/)?.[1] ?? 0);
  const m = { held, tests };
  if (s.cmd.startsWith('lane new') && out.some((l) => l.includes('> npm ci'))) m.ci = s.sec;
  const linked = out.join('\n').match(/linked from \S+ \((\d+) files/);
  if (s.cmd.startsWith('lane new') && linked) Object.assign(m, { link: s.sec, files: Number(linked[1]).toLocaleString('en') });
  Object.assign(meters, m);
  const gate = s.cmd.startsWith('gate:');
  const shown = gate ? `# ${s.cmd.slice(5).trim()}` : s.cmd.startsWith('#') ? s.cmd : `$ ${s.cmd}`;
  const kind = gate ? 'ln note gate' : s.cmd.startsWith('#') ? 'ln note' : 'ln cmd';
  lines.push(`<span class="${kind}"${attr({ step: st, sec: s.sec, ...m })}>${esc(shown)}</span>`);
  for (const l of s.out ? out : []) lines.push(`<span class="ln${/^npm warn/.test(l) ? ' dim' : ''}">${esc(l)}</span>`);
}

const html = fs.readFileSync(page, 'utf8');
const log = `<!-- replay:log --><pre class="rp-log" id="rp-log" tabindex="0">${lines.join('')}</pre><!-- /replay:log -->`;
let out = html.replace(/<!-- replay:log -->[\s\S]*?<!-- \/replay:log -->/, log);
for (const [k, v] of Object.entries(meters)) out = out.replace(new RegExp(`(<span id="rp-${k}">)[^<]*(</span>)`), `$1${v}$2`);
const total = steps.reduce((n, s) => n + s.sec, 0);
// In the English markup and in the Vietnamese string of the language switch.
out = out.replace(/(<span id="rp-total">)[^<]*(<\/span>)/g, `$1${total}$2`);
fs.writeFileSync(page, out);
console.log(`${lines.length} lines, ${total} s of real time; meters ${JSON.stringify(meters)}`);
