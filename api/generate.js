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

// Records one row per problem request (anonymous device id only: no IP, no user agent).
// Awaited with a short timeout so a paused or slow database can never block serving problems.
async function logRequest(row) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const headers = { 'Content-Type': 'application/json', apikey: key, Prefer: 'return=minimal' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const resp = await fetch(url + '/rest/v1/problem_requests', {
      method: 'POST',
      headers,
      body: JSON.stringify(row),
      signal: ctrl.signal
    });
    if (!resp.ok) console.error('problem_requests insert failed:', resp.status, await resp.text());
  } catch (e) {
    console.error('problem_requests insert error:', e.message);
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  const { level, topic, band, recent, round, seenIds, clientId, src, recentProblems, recentTopics } = req.body || {};
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
  const safeClientId = typeof clientId === 'string' ? clientId.slice(0, 64) : null;
  const safeSrc = (typeof src === 'string' && /^[a-z0-9_-]{1,40}$/.test(src)) ? src : null;

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
  // Group unseen candidates by topic. For Mixed, pick the TOPIC first (uniformly,
  // so a topic with a deeper bank doesn't dominate), and skip any topic the
  // student got in each of their last two problems so it can't run three in a row.
  const byTopic = topicsToUse
    .map(t => ({ t, list: bandsToUse.flatMap(b => bank[bucketKey(level, round, t, b)] || []).filter(p => !safeSeenIds.includes(p.id)) }))
    .filter(g => g.list.length > 0);
  if (byTopic.length > 0) {
    let pool = byTopic;
    if (topic === 'Mixed') {
      const rt = Array.isArray(recentTopics) ? recentTopics.slice(-2) : [];
      const streak = rt.length === 2 && rt[0] === rt[1] ? rt[1] : null;
      const varied = byTopic.filter(g => g.t !== streak);
      if (varied.length > 0) pool = varied;
    }
    const group = pool[Math.floor(Math.random() * pool.length)];
    const picked = group.list[Math.floor(Math.random() * group.list.length)];
    await logRequest({ client_id: safeClientId, src: safeSrc, level, topic, band, source: 'bank' });
    return res.status(200).json({ ...picked, topic: group.t, source: 'bank' });
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
    // Tell the model what this student (and the bank) already has so live
    // generation stops returning the same scenario over and over.
    const shown = Array.isArray(recentProblems) ? recentProblems.slice(-5).filter(t => typeof t === 'string').map(t => t.slice(0, 200)) : [];
    const banked = topicsToUse.flatMap(t => bank[bucketKey(level, round, t, liveBand)] || []).map(p => p.problem).slice(-4);
    const { problem } = await generateProblem({ level, topic, band: liveBand, round, recent: safeRecent, apiKey, avoid: [...banked, ...shown] });
    await logRequest({ client_id: safeClientId, src: safeSrc, level, topic, band, source: 'live' });
    return res.status(200).json({ ...problem, source: 'live' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
