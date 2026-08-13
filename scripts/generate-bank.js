#!/usr/bin/env node
// scripts/generate-bank.js
//
// One-time (or periodically re-run) offline batch generator that builds the
// static problem bank served by api/generate.js, using the exact same
// prompt/parse/validate pipeline as the live endpoint (lib/problem-gen.js) —
// so bank quality matches what the live "New Problem" button already
// produces. Nothing here is a separate, drift-prone copy of that logic.
//
// This spends real money against your Anthropic API key. Run it yourself,
// after setting a hard spend cap in the Anthropic console (Plan & Billing),
// so a bug here can't produce a surprise bill.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/generate-bank.js
//   ANTHROPIC_API_KEY=sk-ant-... BANK_PER_BUCKET=3 node scripts/generate-bank.js
//
// Safe to interrupt (Ctrl+C) and re-run: it saves data/bank.json after every
// bucket and skips buckets that already have enough problems, so you can
// start small (BANK_PER_BUCKET=3, a few dollars) and top up later by
// re-running with a higher number.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TOPICS, BANDS, ROUNDS, generateProblem } from '../lib/problem-gen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANK_PATH = path.join(__dirname, '..', 'data', 'bank.json');
const PER_BUCKET = parseInt(process.env.BANK_PER_BUCKET || '6', 10);

// Verify current pricing at https://anthropic.com/pricing before trusting
// this — these are the figures used to produce the running cost estimate
// below, not a guarantee of what you'll actually be billed.
const PRICE_PER_M_INPUT = 2;
const PRICE_PER_M_OUTPUT = 10;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY in the environment before running this script.');
  process.exit(1);
}

const topics = [...TOPICS];
const bands = [...BANDS];

function buildBuckets() {
  const buckets = [];
  for (const level of ['AMC 8', 'AMC 10', 'AMC 12', 'AIME']) {
    for (const topic of topics) {
      for (const band of bands) {
        buckets.push({ level, topic, band, round: null });
      }
    }
  }
  for (const round of [...ROUNDS]) {
    for (const topic of topics) {
      for (const band of bands) {
        buckets.push({ level: 'MATHCOUNTS', topic, band, round });
      }
    }
  }
  return buckets;
}

function bucketKey(b) {
  return [b.level, b.round || '-', b.topic, b.band].join('|');
}

// Cheap near-duplicate guard: two problems are "too similar" if they share
// most of their significant words. Catches the model reusing the same setup
// with different numbers, without needing a second model call to judge it.
function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
}
function tooSimilar(a, b) {
  const wa = new Set(normalize(a));
  const wb = new Set(normalize(b));
  if (wa.size === 0 || wb.size === 0) return false;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  const jaccard = overlap / (wa.size + wb.size - overlap);
  return jaccard > 0.55;
}

function loadBank() {
  if (fs.existsSync(BANK_PATH)) {
    return JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));
  }
  return {};
}
function saveBank(bank) {
  fs.mkdirSync(path.dirname(BANK_PATH), { recursive: true });
  fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 2));
}

function costSoFar(input, output) {
  return (input / 1e6) * PRICE_PER_M_INPUT + (output / 1e6) * PRICE_PER_M_OUTPUT;
}

async function main() {
  const bank = loadBank();
  const buckets = buildBuckets();
  let totalInput = 0, totalOutput = 0, totalGenerated = 0, totalRejectedDupes = 0, totalErrors = 0;

  console.log(`Target: ${PER_BUCKET} problems/bucket across ${buckets.length} buckets (up to ${buckets.length * PER_BUCKET} problems).`);
  console.log(`Bank file: ${BANK_PATH}\n`);

  for (const b of buckets) {
    const key = bucketKey(b);
    bank[key] = bank[key] || [];
    const have = bank[key].length;
    if (have >= PER_BUCKET) continue;

    const need = PER_BUCKET - have;
    process.stdout.write(`${key}: have ${have}, generating ${need}... `);

    let gotThisBucket = 0;
    let attempts = 0;
    const maxAttemptsThisBucket = need * 3; // headroom for dupe rejections without looping forever

    while (gotThisBucket < need && attempts < maxAttemptsThisBucket) {
      attempts++;
      try {
        const { problem, usage } = await generateProblem({
          level: b.level, topic: b.topic, band: b.band, round: b.round, recent: [], apiKey
        });
        totalInput += usage.input_tokens;
        totalOutput += usage.output_tokens;

        const isDupe = bank[key].some(existing => tooSimilar(existing.problem, problem.problem));
        if (isDupe) {
          totalRejectedDupes++;
          continue;
        }
        bank[key].push({ ...problem, id: key + '#' + Date.now() + '#' + Math.random().toString(36).slice(2, 8) });
        gotThisBucket++;
        totalGenerated++;
      } catch (e) {
        totalErrors++;
        if (e.usage) { totalInput += e.usage.input_tokens; totalOutput += e.usage.output_tokens; }
        console.error(`\n  generation error: ${e.message}`);
      }
    }
    saveBank(bank); // persist after every bucket — a crash mid-run loses at most one bucket's progress
    console.log(`got ${gotThisBucket}/${need}. running total: ${totalGenerated} problems, ~$${costSoFar(totalInput, totalOutput).toFixed(2)} spent so far.`);
  }

  console.log(`\nDone. ${totalGenerated} problems generated, ${totalRejectedDupes} near-duplicates rejected, ${totalErrors} generation errors.`);
  console.log(`Actual token usage: ${totalInput} input, ${totalOutput} output.`);
  console.log(`Estimated cost: ~$${costSoFar(totalInput, totalOutput).toFixed(2)} (at $${PRICE_PER_M_INPUT}/M input, $${PRICE_PER_M_OUTPUT}/M output — confirm current pricing before trusting this).`);
  console.log(`Bank saved to ${BANK_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
