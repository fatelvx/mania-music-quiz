// Builds the static quiz data for GitHub Pages.
//   node build.js            -> docs/data/pool.json + docs/data/charts/<setId>.json
// Needs OSU_CLIENT_ID / OSU_CLIENT_SECRET in .env (never shipped to the site).
const fs = require('node:fs');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
const { OSU_CLIENT_ID, OSU_CLIENT_SECRET } = process.env;
const POOL_SIZE = Number(process.env.POOL_SIZE || 1000); // kept after ranking by mania plays
const SCAN = Number(process.env.SCAN || POOL_SIZE * 2);  // how many sets (by total plays) to scan first
const WINDOW_MS = 12000; // chart excerpt length (official previews are ~10s)

const OUT = path.join(__dirname, 'docs', 'data');
const CHART_DIR = path.join(OUT, 'charts');
const OSU_CACHE = path.join(__dirname, 'cache', 'osu');
for (const d of [CHART_DIR, OSU_CACHE]) fs.mkdirSync(d, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = { 'User-Agent': 'mania-music-quiz-build/0.2' };

async function getToken() {
  if (!OSU_CLIENT_ID || !OSU_CLIENT_SECRET) throw new Error('Fill OSU_CLIENT_ID / OSU_CLIENT_SECRET in .env');
  const r = await fetch('https://osu.ppy.sh/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: Number(OSU_CLIENT_ID), client_secret: OSU_CLIENT_SECRET, grant_type: 'client_credentials', scope: 'public' }),
  });
  if (!r.ok) throw new Error(`OAuth ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

async function scanSets(token) {
  const sets = new Map();
  let cursor = null;
  while (sets.size < SCAN) {
    const q = new URLSearchParams({ m: '3', s: 'ranked', sort: 'plays_desc' });
    if (cursor) q.set('cursor_string', cursor);
    const r = await fetch('https://osu.ppy.sh/api/v2/beatmapsets/search?' + q, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'x-api-version': '20240529' },
    });
    if (!r.ok) throw new Error(`search ${r.status}: ${await r.text()}`);
    const page = await r.json();
    for (const s of page.beatmapsets || []) {
      const diffs = s.beatmaps.filter(b => b.mode === 'mania' && !b.convert).map(b => ({
        id: b.id, version: b.version, keys: Math.round(b.cs), sr: Math.round(b.difficulty_rating * 100) / 100,
        length: b.total_length, plays: b.playcount,
      }));
      if (!diffs.length) continue;
      sets.set(s.id, {
        id: s.id, title: s.title, titleU: s.title_unicode, artist: s.artist, artistU: s.artist_unicode,
        source: s.source || '', creator: s.creator,
        maniaPlays: diffs.reduce((a, d) => a + d.plays, 0), favs: s.favourite_count, diffs,
      });
    }
    process.stdout.write(`\rscanned ${sets.size} sets`);
    cursor = page.cursor_string;
    if (!cursor || !(page.beatmapsets || []).length) break;
    await sleep(600);
  }
  console.log();
  return [...sets.values()];
}

async function getOsu(id) {
  const file = path.join(OSU_CACHE, `${id}.osu`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`https://osu.ppy.sh/osu/${id}`, { headers: UA });
      if (r.ok) { const t = await r.text(); fs.writeFileSync(file, t); return t; }
      if (r.status === 404) return null;
    } catch { /* ECONNRESET etc. -> retry */ }
    await sleep(2000 * (attempt + 1)); // 429 / 5xx backoff
  }
  return null;
}

function excerpt(text, lengthSec) {
  let section = '', keys = 4, preview = -1;
  const objs = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { section = m[1]; continue; }
    if (section === 'General' && line.startsWith('PreviewTime:')) preview = Number(line.split(':')[1]);
    else if (section === 'Difficulty' && line.startsWith('CircleSize:')) keys = Math.round(Number(line.split(':')[1]));
    else if (section === 'HitObjects') {
      const f = line.split(',');
      const x = +f[0], t = +f[2], type = +f[3];
      const end = (type & 128) ? +(f[5] || '').split(':')[0] : t;
      objs.push([Math.min(keys - 1, Math.max(0, Math.floor(x * keys / 512))), t, end > t ? end - t : 0]);
    }
  }
  const synced = preview >= 0;
  const start = synced ? preview : Math.round(lengthSec * 1000 * 0.4);
  const notes = objs.filter(([, t, len]) => t + len >= start && t < start + WINDOW_MS)
    .map(([c, t, len]) => [c, t - start, len]).sort((a, b) => a[1] - b[1]);
  return { k: keys, s: synced ? 1 : 0, n: notes };
}

async function main() {
  const token = await getToken();
  const scanned = await scanSets(token);
  // familiarity for mania players = how much the mania diffs actually get played
  scanned.sort((a, b) => b.maniaPlays - a.maniaPlays);
  const pool = scanned.slice(0, POOL_SIZE);

  const jobs = pool.flatMap(s => s.diffs.map(d => ({ s, d })));
  console.log(`pool ${pool.length} sets, ${jobs.length} mania diffs to excerpt`);
  const charts = new Map(pool.map(s => [s.id, {}]));
  let done = 0, failed = 0, i = 0;
  async function worker() {
    while (i < jobs.length) {
      const { s, d } = jobs[i++];
      const cached = fs.existsSync(path.join(OSU_CACHE, `${d.id}.osu`));
      const text = await getOsu(d.id);
      if (text) charts.get(s.id)[d.id] = excerpt(text, d.length); else failed++;
      done++;
      if (done % 20 === 0 || done === jobs.length) process.stdout.write(`\rcharts ${done}/${jobs.length} (failed ${failed})`);
      if (!cached) await sleep(250);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log();

  for (const f of fs.readdirSync(CHART_DIR)) fs.unlinkSync(path.join(CHART_DIR, f));
  for (const s of pool) {
    const c = charts.get(s.id);
    s.diffs = s.diffs.filter(d => c[d.id] && c[d.id].n.length > 0);
    for (const d of s.diffs) delete d.plays;
    if (s.diffs.length) fs.writeFileSync(path.join(CHART_DIR, `${s.id}.json`), JSON.stringify(c));
  }
  // drop sets whose official preview audio is missing
  const noPreview = new Set();
  let pi = 0;
  const withDiffs = pool.filter(s => s.diffs.length);
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (pi < withDiffs.length) {
      const s = withDiffs[pi++];
      try { const r = await fetch(`https://b.ppy.sh/preview/${s.id}.mp3`, { method: 'HEAD', headers: UA }); if (r.status === 404) noPreview.add(s.id); } catch {}
    }
  }));
  if (noPreview.size) console.log(`no preview audio: ${[...noPreview].join(', ')}`);
  for (const id of noPreview) fs.rmSync(path.join(CHART_DIR, `${id}.json`), { force: true });
  const final = withDiffs.filter(s => !noPreview.has(s.id));
  fs.writeFileSync(path.join(OUT, 'pool.json'), JSON.stringify({ builtAt: new Date().toISOString(), sets: final }));
  console.log(`wrote ${final.length} sets -> docs/data/`);
}

main().catch(e => { console.error(e); process.exit(1); });
