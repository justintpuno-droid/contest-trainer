// api/generate.js — Vercel serverless function
// Serves problems from the pre-generated bank (data/bank.json, built by
// scripts/generate-bank.js) when one is available for the requested bucket
// and the client hasn't already seen it this session; otherwise falls back
// to live generation. Holds the Anthropic API key server-side either way —
// the client sends structured params only, never a raw prompt.

import fs from 'fs';
import path from 'path';
import { LEVELS, TOPICS, BANDS, ROUNDS, generateProblem } from '../lib/problem-gen.js';

let bankCache = null;
function loadBank() {
  if (bankCache) return bankCache;
  try {
    const p = path.join(process.cwd(), 'data', 'bank.json');
    bankCache = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    bankCache = {};
  }
  return bankCache;
}

function bucketKey(level, round, topic, band) {
  return [level, round || '-', topic, band].join('|');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  const { level, topic, band, recent, round, seenIds } = req.body || {};
  if (!LEVELS.has(level) || !TOPICS.has(topic) || (band !== 'mixed' && !BANDS.has(band))) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }
  if (level === 'MATHCOUNTS' && !ROUNDS.has(round)) {
    return res.status(400).json({ error: 'Invalid round' });
  }
  const safeRecent = Array.isArray(recent)
    ? recent.slice(-6).filter(r => r === 'correct' || r === 'wrong')
    : [];
  const safeSeenIds = Array.isArray(seenIds) ? seenIds.slice(-500) : [];

  // 1) Try the pre-generated bank first — zero marginal cost, zero live spend.
  //    "Mixed" has no bank entries of its own; instead it draws from the
  //    union of every specific topic's bucket at this level/round/band, so
  //    it benefits from the full depth of the bank rather than being its
  //    own thin, separately-exhausted bucket.
  const bank = loadBank();
  //    "mixed" band works the same way, pooled across all real bands
  //    (early/mid/late) — and the two combine freely, so Mixed topic +
  //    mixed band pools across every topic/band bucket at this level/round.
  const topicsToUse = topic === 'Mixed' ? [...TOPICS].filter(t => t !== 'Mixed') : [topic];
  const bandsToUse = band === 'mixed' ? [...BANDS] : [band];
  let candidates = topicsToUse
    .flatMap(t => bandsToUse.flatMap(b => bank[bucketKey(level, round, t, b)] || []))
    .filter(p => !safeSeenIds.includes(p.id));
  if (candidates.length > 0) {
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    return res.status(200).json({ ...picked, source: 'bank' });
  }

  // 2) Bank has nothing left (or doesn't exist yet) for this bucket — fall
  //    back to live generation if a key is configured.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'No bank problems left for this selection, and no ANTHROPIC_API_KEY configured for live fallback.' });
  }
  // Live generation needs one real band to build a calibrated prompt — a
  // "mixed" request resolves to a randomly-chosen real band for this single
  // problem, rather than asking the model for an undefined "any difficulty."
  const liveBand = band === 'mixed' ? [...BANDS][Math.floor(Math.random() * BANDS.size)] : band;
  try {
    const { problem } = await generateProblem({ level, topic, band: liveBand, round, recent: safeRecent, apiKey });
    return res.status(200).json({ ...problem, source: 'live' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
