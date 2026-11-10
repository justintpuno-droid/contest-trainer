// api/answer.js — Vercel serverless function
// Records one anonymous row per submitted answer (device id, contest, topic,
// band, bank problem id, correct/incorrect). Never stores problem text or the
// student's answer. Fire-and-forget from the client; a slow or paused database
// never blocks the UI.

import { LEVELS, TOPICS, BANDS } from '../lib/problem-gen.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { clientId, src, level, topic, band, problemId, correct } = req.body || {};
  if (typeof correct !== 'boolean' || !LEVELS.has(level) || !TOPICS.has(topic) || (band !== 'mixed' && !BANDS.has(band))) {
    return res.status(400).end();
  }
  const row = {
    client_id: typeof clientId === 'string' ? clientId.slice(0, 64) : null,
    src: (typeof src === 'string' && /^[a-z0-9_-]{1,40}$/.test(src)) ? src : null,
    level, topic, band,
    problem_id: typeof problemId === 'string' ? problemId.slice(0, 80) : null,
    correct
  };
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(204).end();
  const headers = { 'Content-Type': 'application/json', apikey: key, Prefer: 'return=minimal' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const resp = await fetch(url + '/rest/v1/answer_events', {
      method: 'POST', headers, body: JSON.stringify(row), signal: ctrl.signal
    });
    if (!resp.ok) console.error('answer_events insert failed:', resp.status, await resp.text());
  } catch (e) {
    console.error('answer_events insert error:', e.message);
  } finally {
    clearTimeout(timer);
  }
  return res.status(204).end();
}
