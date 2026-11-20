// Renders every built-in preset to renders/<name>.wav and prints its tone balance.
//   npm run render                 synthesised guitar: chords, leads or chugs by category
//   npm run render -- my-di.wav    your own dry guitar recording through every preset
//   npm run render -- Metal        only presets whose name or category matches
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PRESETS } from '../src/presets.ts';
import { compile } from '../src/rig.ts';

const tool = 'native/build/RigRender_artefacts/Release/RigRender';
const di = process.argv.slice(2).find((a) => a.endsWith('.wav'));
const only = process.argv.slice(2).find((a) => !a.endsWith('.wav'));
const part: Record<string, string> = { Lead: 'lead', Metal: 'chug' };
mkdirSync('renders/rigs', { recursive: true });
console.log(`${'preset'.padEnd(28)}   63   125   250   500    1k    2k    4k    8k`);
for (const [name, preset] of Object.entries(PRESETS)) {
  if (only && !new RegExp(only, 'i').test(`${name} ${preset.category}`)) continue;
  const file = name.replace(/[^\w-]+/g, '-');
  writeFileSync(`renders/rigs/${file}.json`, JSON.stringify(compile(preset.build())));
  const out = execFileSync(tool, [`renders/rigs/${file}.json`, `renders/${file}.wav`, di ?? part[preset.category] ?? 'chords']).toString();
  process.stdout.write(out);
}
