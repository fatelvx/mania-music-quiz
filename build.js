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

// ---------- pp maps: what players actually farm ----------
// Sample players spread across the mania rankings (not just the top), and count how many of them
// have each map in their top-100 best scores.
const BEST_CACHE = path.join(__dirname, 'cache', 'best');
fs.mkdirSync(BEST_CACHE, { recursive: true });
const PP_PAGES = { '4k': range(1, 200, 10), '7k': range(1, 200, 20) }; // 50 players per page, ranks 1..10000

function range(from, to, step) { const a = []; for (let i = from; i <= to; i += step) a.push(i); return a; }

async function apiGet(token, p) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch('https://osu.ppy.sh/api/v2' + p, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'x-api-version': '20240529' },
      });
      if (r.ok) return r.json();
      if (r.status === 404) return null;
    } catch {}
    await sleep(2000 * (attempt + 1));
  }
  throw new Error('API failed: ' + p);
}

async function samplePpMaps(token) {
  const users = [];
  for (const [variant, pages] of Object.entries(PP_PAGES)) {
    for (const page of pages) {
      const r = await apiGet(token, `/rankings/mania/performance?variant=${variant}&cursor[page]=${page}`);
      for (const row of r?.ranking || []) users.push(row.user.id);
      process.stdout.write(`\rranking pages: ${users.length} players`);
      await sleep(300);
    }
  }
  console.log();
  const uniq = [...new Set(users)];
  const sets = new Map(); // setId -> { meta, users:Set, diffs: Map(diffId -> {.., users:Set}) }
  let i = 0, done = 0;
  async function worker() {
    while (i < uniq.length) {
      const uid = uniq[i++];
      const file = path.join(BEST_CACHE, `${uid}.json`);
      let best;
      if (fs.existsSync(file)) best = JSON.parse(fs.readFileSync(file, 'utf8'));
      else {
        const raw = (await apiGet(token, `/users/${uid}/scores/best?mode=mania&limit=100`)) || [];
        best = raw.filter(s => s.beatmap && !s.beatmap.convert && s.beatmap.mode === 'mania').map(s => ({
          set: { id: s.beatmapset.id, title: s.beatmapset.title, titleU: s.beatmapset.title_unicode, artist: s.beatmapset.artist,
            artistU: s.beatmapset.artist_unicode, source: s.beatmapset.source || '', creator: s.beatmapset.creator },
          diff: { id: s.beatmap.id, version: s.beatmap.version, keys: Math.round(s.beatmap.cs),
            sr: Math.round(s.beatmap.difficulty_rating * 100) / 100, length: s.beatmap.total_length, status: s.beatmap.status },
        }));
        fs.writeFileSync(file, JSON.stringify(best));
        await sleep(250);
      }
      for (const { set, diff } of best) {
        if (!['ranked', 'approved', 'loved'].includes(diff.status)) continue;
        if (!sets.has(set.id)) sets.set(set.id, { meta: set, users: new Set(), diffs: new Map() });
        const e = sets.get(set.id);
        e.users.add(uid);
        if (!e.diffs.has(diff.id)) e.diffs.set(diff.id, { ...diff, users: new Set() });
        e.diffs.get(diff.id).users.add(uid);
      }
      done++;
      if (done % 10 === 0 || done === uniq.length) process.stdout.write(`\rbest scores: ${done}/${uniq.length} players`);
    }
  }
  await Promise.all([worker(), worker()]);
  console.log();
  return sets;
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
  // "classic" familiarity = how much the mania diffs actually get played
  scanned.sort((a, b) => b.maniaPlays - a.maniaPlays);
  const classic = scanned.slice(0, POOL_SIZE);
  classic.forEach((s, i) => { s.playRank = i + 1; });

  // "pp" familiarity = how many sampled players have it in their top plays
  const ppSets = await samplePpMaps(token);
  const ppList = [...ppSets.values()].filter(e => e.users.size >= 3).sort((a, b) => b.users.size - a.users.size).slice(0, POOL_SIZE);
  const byId = new Map(classic.map(s => [s.id, s]));
  ppList.forEach((e, i) => {
    let s = byId.get(e.meta.id);
    if (!s) {
      const scannedSet = scanned.find(x => x.id === e.meta.id);
      s = scannedSet ? { ...scannedSet } : { ...e.meta, maniaPlays: 0, diffs: [...e.diffs.values()].map(({ users, status, ...d }) => ({ ...d, plays: 0 })) };
      byId.set(s.id, s);
    }
    s.ppRank = i + 1;
    s.ppUsers = e.users.size;
    for (const d of s.diffs) { const pd = e.diffs.get(d.id); if (pd) d.pp = pd.users.size; }
    // pp diffs the set scan didn't know about (e.g. sets outside the scanned range)
    for (const pd of e.diffs.values()) if (!s.diffs.some(d => d.id === pd.id)) { const { users, status, ...d } = pd; s.diffs.push({ ...d, plays: 0, pp: users.size }); }
  });
  const pool = [...byId.values()];
  console.log(`classic ${classic.length} + pp ${ppList.length} -> ${pool.length} unique sets`);

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
