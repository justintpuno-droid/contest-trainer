#!/usr/bin/env node
// scripts/clean-bank.js
//
// Cleans data/bank.json without any API calls:
//   1. drops problems stored under the legacy "Mixed" topic (the server never serves them),
//   2. drops near-duplicates (word-overlap Jaccard > THRESHOLD) within the same contest,
//      keeping the first one seen, even if the twins sit in different topic/band buckets.
//
// Dry run by default. Usage:
//   node scripts/clean-bank.js                 # report only
//   node scripts/clean-bank.js --apply         # write data/bank.json (backup saved alongside)
//   BANK_LEVELS=MOEMS node scripts/clean-bank.js   # restrict to listed levels (default: all except MOEMS)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BANK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bank.json');
const THRESHOLD = parseFloat(process.env.BANK_DEDUPE_THRESHOLD || '0.6');
const APPLY = process.argv.includes('--apply');
const ONLY = (process.env.BANK_LEVELS || '').split(',').map(s => s.trim()).filter(Boolean);

const raw = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));
const wrapped = raw.buckets && typeof raw.buckets === 'object';
const bank = wrapped ? raw.buckets : raw;

const inScope = level => (ONLY.length ? ONLY.includes(level) : level !== 'MOEMS');
const words = t => new Set((String(t).toLowerCase().match(/[a-z0-9]+/g) || []));
const jac = (a, b) => { let o = 0; for (const w of a) if (b.has(w)) o++; return o / (a.size + b.size - o || 1); };

const before = Object.values(bank).reduce((n, v) => n + v.length, 0);
let droppedMixed = 0, droppedDupes = 0;
const kept = {};   // level -> [{key, words}]

// Pass 1: legacy Mixed buckets out; pass 2: dedupe in key order.
for (const key of Object.keys(bank)) {
  const [level, , topic] = key.split('|');
  if (!inScope(level)) continue;
  if (topic === 'Mixed') { droppedMixed += bank[key].length; bank[key] = []; }
}
for (const key of Object.keys(bank)) {
  const [level] = key.split('|');
  if (!inScope(level)) continue;
  kept[level] = kept[level] || [];
  bank[key] = bank[key].filter(p => {
    const w = words(p.problem);
    if (kept[level].some(k => jac(k, w) > THRESHOLD)) { droppedDupes++; return false; }
    kept[level].push(w);
    return true;
  });
}
for (const key of Object.keys(bank)) if (bank[key].length === 0) delete bank[key];

const after = Object.values(bank).reduce((n, v) => n + v.length, 0);
console.log(`${before} problems -> ${after}. Dropped ${droppedMixed} legacy Mixed-topic and ${droppedDupes} near-duplicates (threshold ${THRESHOLD}).`);
const perLevel = {};
for (const [k, v] of Object.entries(bank)) perLevel[k.split('|')[0]] = (perLevel[k.split('|')[0]] || 0) + v.length;
console.log('Per contest after cleaning:', perLevel);

if (APPLY) {
  fs.copyFileSync(BANK_PATH, BANK_PATH + '.bak');
  fs.writeFileSync(BANK_PATH, JSON.stringify(wrapped ? { ...raw, buckets: bank } : bank, null, 2));
  console.log('Wrote data/bank.json (backup: data/bank.json.bak). Now top up with generate-bank.js.');
} else {
  console.log('Dry run. Re-run with --apply to write.');
}
