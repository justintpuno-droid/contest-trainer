// One-time repair: spreads correct-answer letters evenly across the existing bank.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { shuffleChoices } from '../lib/problem-gen.js';

const BANK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bank.json');
const bank = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));
let shuffled = 0, skipped = 0;
const skippedIds = [];
const dist = { A: 0, B: 0, C: 0, D: 0, E: 0 };
for (const key of Object.keys(bank)) {
  for (const p of bank[key]) {
    if (!p.choices || typeof p.choices !== 'object') continue;
    const before = p.choices[p.answer];
    if (shuffleChoices(p)) {
      if (p.choices[p.answer] !== before) {
        console.error('REMAP ERROR on ' + p.id + ' - nothing was written.');
        process.exit(1);
      }
      shuffled++;
    } else {
      skipped++;
      skippedIds.push(p.id);
    }
    if (dist[p.answer] !== undefined) dist[p.answer]++;
  }
}
fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 2));
const n = Object.values(dist).reduce((a, b) => a + b, 0);
console.log('Shuffled ' + shuffled + ', skipped ' + skipped + ' (left in original order).');
console.log('New answer letters: ' + Object.entries(dist).map(([k, v]) => k + ':' + (100 * v / n).toFixed(0) + '%').join('  '));
if (skippedIds.length) console.log('Skipped ids (first 10): ' + skippedIds.slice(0, 10).join(', '));
