#!/usr/bin/env node
// video-to-blog: turn one YouTube video into an SEO brief for a blog post, using YOUR DataForSEO account.
// Usage: DATAFORSEO_LOGIN=... DATAFORSEO_PASSWORD=... node seo-brief.mjs <youtube-url> [location=United States]
// Output: briefs/<video-id>.md  (keywords, who ranks, AI Overview, what to write) + the cost of every call.
import fs from 'node:fs';

const [url, location = 'United States'] = process.argv.slice(2);
// DATAFORSEO_USERNAME is accepted too: it is the name the official DataForSEO MCP server uses
const L = process.env.DATAFORSEO_LOGIN || process.env.DATAFORSEO_USERNAME, P = process.env.DATAFORSEO_PASSWORD;
if (!url || !L || !P) { console.error('usage: DATAFORSEO_LOGIN=.. DATAFORSEO_PASSWORD=.. node seo-brief.mjs <youtube-url>'); process.exit(1); }

const auth = 'Basic ' + Buffer.from(`${L}:${P}`).toString('base64');
let spent = 0; const costs = [];
async function dfs(path, body, label) {
  const r = await fetch(`https://api.dataforseo.com/v3/${path}`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.status_code !== 20000) throw new Error(`${path}: ${j.status_message}`);
  spent += j.cost || 0; costs.push([label, j.cost || 0]);
  const t = j.tasks?.[0];
  if (t?.status_code !== 20000) throw new Error(`${path}: ${t?.status_message}`);
  return t.result?.[0];
}

// 1. What is the video about? (public oEmbed, no key needed)
const oe = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
if (!oe.ok) { console.error(`YouTube could not read that video (HTTP ${oe.status}). It must be public or unlisted.`); process.exit(1); }
const meta = await oe.json();
const id = (url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1] || 'video';
const title = meta.title;
console.log(`Video: ${title}`);

// 2. Seed phrases from the title. Titles are clickbait, searches are short: try the full phrase, then shorter ones.
const STOP = new Set(['i','my','a','an','the','is','are','was','it','this','that','of','to','for','and','or','in','on','with','now','how','why','what','you','your','lie','really','actually']);
const words = title.replace(/\(.*?\)|\[.*?\]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const core = words.filter(w => !STOP.has(w));
const seeds = [...new Set([words.slice(0, 6).join(' '), core.slice(0, 3).join(' '), core.slice(0, 2).join(' ')].filter(s => s.split(' ').length >= 2))];
let kws = [], seed = '';
for (const s of seeds) {
  const ideas = await dfs('dataforseo_labs/google/keyword_suggestions/live',
    [{ keyword: s, location_name: location, language_code: 'en', limit: 50, include_seed_keyword: true, order_by: ['keyword_info.search_volume,desc'] }], `keyword suggestions: "${s}"`);
  kws = (ideas?.items || []).map(i => ({ keyword: i.keyword, volume: i.keyword_info?.search_volume ?? 0,
    kd: i.keyword_properties?.keyword_difficulty ?? null, intent: i.search_intent_info?.main_intent ?? '' })).filter(k => k.volume > 0);
  if (kws.length >= 5) { seed = s; break; }
}
// Score: volume you can actually win (low difficulty, informational beats commercial for a blog)
const score = k => k.volume * (k.kd == null ? 0.5 : (100 - k.kd) / 100) * (k.intent === 'informational' ? 1.2 : 1);
// Google groups close variants ("ai trading" / "ai in trading") with identical numbers: keep one of each
const seen = new Set();
kws = kws.sort((a, b) => score(b) - score(a)).filter(k => { const key = `${k.volume}|${k.kd}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 10);
if (!kws.length) { console.error('No keyword data for:', seed); process.exit(2); }
const target = kws[0].keyword;

// 3. Who ranks now, and does Google answer with an AI Overview?
const serp = await dfs('serp/google/organic/live/advanced', [{ keyword: target, location_name: location, language_code: 'en', depth: 10, load_async_ai_overview: true }], 'Google results + AI Overview');
const items = serp?.items || [];
const top = items.filter(i => i.type === 'organic').slice(0, 5).map(i => `${i.rank_group}. ${i.domain}: ${i.title}`);
const aio = items.find(i => i.type === 'ai_overview');
const features = [...new Set(items.map(i => i.type))];

// 4. Write the brief
const md = `# SEO brief: ${title}

Video: ${url}
Target keyword: **${target}** (${kws[0].volume}/mo, difficulty ${kws[0].kd ?? 'n/a'}, ${kws[0].intent || 'intent n/a'})

## Keywords to use
| Keyword | Volume/mo | Difficulty | Intent |
|---|---|---|---|
${kws.map(k => `| ${k.keyword} | ${k.volume} | ${k.kd ?? ''} | ${k.intent} |`).join('\n')}

## Who ranks now (Google, ${location})
${top.join('\n') || 'no organic results returned'}

AI Overview: ${aio ? '**yes**, it sits above the results. Write a clear one-paragraph answer near the top so it can be quoted.' : 'no'}
Page features: ${features.join(', ')}

## Write the post (paste this into Claude Code or any AI)
Write a blog post from my video "${title}" (${url}). Target keyword: "${target}". Use these naturally: ${kws.slice(1, 6).map(k => k.keyword).join(', ')}.
Start with a direct 2-3 sentence answer to the keyword. Embed the video near the top. Use my real numbers and experience from the video, not generic claims.
Beat what ranks now: ${top.slice(0, 3).map(t => t.split(': ')[0]).join('; ')}. Add an FAQ answering 3 "People also ask" style questions.

## Cost (from DataForSEO's own response)
${costs.map(([l, c]) => `- ${l}: $${c.toFixed(4)}`).join('\n')}
- **Total: $${spent.toFixed(4)}**
`;
fs.mkdirSync('briefs', { recursive: true });
fs.writeFileSync(`briefs/${id}.md`, md);
console.log(md);
