// lib/problem-gen.js
// Shared prompt-building, parsing, validation, and API-call logic for
// problem generation. Both the live serverless endpoint (api/generate.js)
// and the offline batch generator (scripts/generate-bank.js) import this —
// on purpose, so bank quality can never silently drift from what the live
// "New Problem" button produces.

export const LEVELS = new Set(['AMC 8', 'AMC 10', 'AMC 12', 'AIME', 'MATHCOUNTS']);
export const TOPICS = new Set(['Mixed', 'Algebra', 'Geometry', 'Number Theory', 'Combinatorics', 'Probability']);
export const BANDS = new Set(['early', 'mid', 'late']);
export const ROUNDS = new Set(['Sprint', 'Target']);

// Verify against https://docs.anthropic.com/en/docs/about-claude/models before
// relying on this — model IDs get retired periodically and the previous
// value here ('claude-sonnet-4-6') was not a real one.
export const MODEL = 'claude-sonnet-5';

export function difficultyText(level, band) {
  if (level === 'AIME') {
    return { early: 'AIME problems #1-5', mid: 'AIME problems #6-10', late: 'AIME problems #11-15' }[band];
  }
  const map = { early: '#1-10 (accessible)', mid: '#11-20 (moderately hard)', late: '#21-25 (very hard)' };
  return level + ' problems ' + map[band];
}

// The client's "band" selector is reused for MATHCOUNTS as a competition
// tier (Chapter/State/National) rather than a within-round problem number —
// same early/mid/late value on the wire, different meaning server-side.
export function mathcountsTier(band) {
  return { early: 'Chapter', mid: 'State', late: 'National' }[band];
}

export function buildPrompt(level, topic, band, recent, beConcise, round) {
  const perf = Array.isArray(recent) && recent.length
    ? "The student's last " + recent.length + ' results (newest last): ' + recent.join(', ') + '. Calibrate slightly within the band accordingly.'
    : '';

  if (level === 'MATHCOUNTS') {
    const tier = mathcountsTier(band);
    const roundRules = round === 'Target'
      ? 'This is a MATHCOUNTS Target Round problem: multi-step, calculator allowed, meaningfully harder than an equivalent Sprint Round problem at the same tier.'
      : 'This is a MATHCOUNTS Sprint Round problem: no calculator allowed, should be solvable efficiently by hand in roughly a minute at this tier.';
    return [
      'You are an experienced MATHCOUNTS problem writer.',
      'Write ONE original problem calibrated to MATHCOUNTS ' + tier + ' Competition difficulty.',
      roundRules,
      topic !== 'Mixed' ? 'Topic: ' + topic + '.' : 'Any standard MATHCOUNTS topic (pre-algebra, algebra, geometry, number theory, or counting and probability).',
      perf,
      'The problem must be fully self-contained, unambiguous, and have a single verifiably correct numeric answer. Double-check your arithmetic before finalizing.',
      'Per official MATHCOUNTS answer rules, the final answer value itself must be an integer, a decimal, or a common fraction reduced to simplest form (e.g. 3/7) — never a mixed number, and never with units, a dollar sign, or a percent sign attached, even if the problem is phrased in those terms.',
      'Write all math using LaTeX inside $...$ delimiters.',
      'Respond with ONLY a compact single-line JSON object: no markdown fences, no preamble, no trailing text. Inside JSON strings, every LaTeX backslash must be escaped for JSON (write \\\\frac for \\frac).',
      'Schema: {"problem": string, "answer": string, "solution": string} where "answer" is the bare MATHCOUNTS-format value as a string, e.g. "42", "12.5", or "3/7" (no other text in that field).',
      beConcise
        ? 'Keep the solution to at most 3 short sentences. Total response under 600 tokens.'
        : 'The solution should be a clear step-by-step walkthrough a student could learn from, at most 5 sentences, also using $...$ for math. Keep the total response under 800 tokens.'
    ].filter(Boolean).join(' ');
  }

  return [
    'You are an experienced competition math problem writer (MAA style).',
    'Write ONE original problem in the style and difficulty of ' + difficultyText(level, band) + '.',
    topic !== 'Mixed' ? 'Topic: ' + topic + '.' : 'Any standard contest topic.',
    perf,
    level === 'AIME'
      ? 'The answer must be an integer from 0 to 999. Do NOT include answer choices.'
      : 'Include exactly five answer choices labeled A-E, with exactly one correct.',
    'The problem must be fully self-contained, unambiguous, and have a verifiably correct answer. Double-check your arithmetic before finalizing.',
    'Write all math using LaTeX inside $...$ delimiters.',
    'Respond with ONLY a compact single-line JSON object: no markdown fences, no preamble, no trailing text. Inside JSON strings, every LaTeX backslash must be escaped for JSON (write \\\\frac for \\frac).',
    level === 'AIME'
      ? 'Schema: {"problem": string, "answer": integer, "solution": string}'
      : 'Schema: {"problem": string, "choices": {"A": string, "B": string, "C": string, "D": string, "E": string}, "answer": "A"|"B"|"C"|"D"|"E", "solution": string}',
    beConcise
      ? 'Keep the solution to at most 3 short sentences. Total response under 600 tokens.'
      : 'The solution should be a clear step-by-step walkthrough a student could learn from, at most 5 sentences, also using $...$ for math. Keep the total response under 800 tokens.'
  ].filter(Boolean).join(' ');
}

export function parseProblem(raw) {
  let t = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try {
    return JSON.parse(t);
  } catch (e) {
    const fixed = t.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
    return JSON.parse(fixed);
  }
}

export function validate(p, level) {
  if (!p || typeof p.problem !== 'string' || !p.problem.trim()) throw new Error('bad problem field');
  if (typeof p.solution !== 'string') p.solution = String(p.solution || '');
  if (level === 'AIME') {
    const n = Number(p.answer);
    if (!Number.isInteger(n) || n < 0 || n > 999) throw new Error('bad AIME answer');
    p.answer = n;
    delete p.choices;
  } else if (level === 'MATHCOUNTS') {
    if (typeof p.answer !== 'string') throw new Error('bad MATHCOUNTS answer');
    const ans = p.answer.trim();
    const isFraction = /^-?\d+\/\d+$/.test(ans);
    const isDecimalOrInt = /^-?\d+(\.\d+)?$/.test(ans);
    if (!isFraction && !isDecimalOrInt) throw new Error('bad MATHCOUNTS answer format: ' + ans);
    if (isFraction && Number(ans.split('/')[1]) === 0) throw new Error('zero denominator in MATHCOUNTS answer');
    p.answer = ans;
    delete p.choices;
  } else {
    if (!p.choices || !['A', 'B', 'C', 'D', 'E'].every(k => k in p.choices)) throw new Error('missing choices');
    if (!['A', 'B', 'C', 'D', 'E'].includes(p.answer)) throw new Error('bad answer letter');
  }
  return p;
}

export async function callAnthropicOnce(prompt, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await resp.json();
  const usage = data.usage || { input_tokens: 0, output_tokens: 0 };
  if (data.error) throw Object.assign(new Error(data.error.message || 'API error'), { usage });
  if (data.stop_reason === 'max_tokens') throw Object.assign(new Error('response truncated'), { usage });
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { text, usage };
}

// Ties prompt-building + API call + parsing + validation together with the
// existing retry-on-malformed-response behavior. Returns real token usage
// (summed across every attempt, including failed ones — a discarded retry
// still costs money) so callers can track actual spend, not an estimate.
export async function generateProblem({ level, topic, band, round, recent, apiKey, maxAttempts = 3 }) {
  let lastErr = null;
  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const prompt = buildPrompt(level, topic, band, recent || [], attempt > 0, round);
      const { text, usage } = await callAnthropicOnce(prompt, apiKey);
      totalUsage.input_tokens += usage.input_tokens || 0;
      totalUsage.output_tokens += usage.output_tokens || 0;
      const problem = validate(parseProblem(text), level);
      return { problem, usage: totalUsage };
    } catch (e) {
      if (e.usage) {
        totalUsage.input_tokens += e.usage.input_tokens || 0;
        totalUsage.output_tokens += e.usage.output_tokens || 0;
      }
      lastErr = e;
    }
  }
  const err = new Error('Generation failed: ' + (lastErr ? lastErr.message : 'unknown'));
  err.usage = totalUsage;
  throw err;
}
