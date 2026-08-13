# Contest Math Trainer

Free, unlimited AI-generated AMC 8/10/12 and AIME practice problems with full solutions.

## Structure

- `index.html` — landing page + trainer (static frontend)
- `api/generate.js` — Vercel serverless function; holds the Anthropic API key server-side and builds all prompts, so the key is never exposed to the browser and the endpoint can't be repurposed as a general LLM proxy.

## Deploy to Vercel

1. Push this folder to a GitHub repo (or run `vercel` from this directory with the Vercel CLI).
2. In the Vercel project settings, add an environment variable:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key from console.anthropic.com
3. Deploy. No build step, no framework — Vercel serves `index.html` and auto-detects `api/generate.js`.

## Cost control

Each problem is one API call capped at 1,000 output tokens (roughly a fraction of a cent on Sonnet). If the URL circulates widely, consider adding rate limiting (Vercel KV or Upstash) and setting a spend limit in the Anthropic console before sharing broadly.

## Local test

`npx vercel dev` runs both the static page and the API function locally (set the env var in `.env.local` as `ANTHROPIC_API_KEY=...`)
