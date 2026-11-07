const $ = s => document.querySelector(s);
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const screens = ['loading', 'setup', 'lobby', 'game', 'results'];
const go = name => screens.forEach(s => show($('#' + s), s === name));
const audio = $('#audio');

// ---------- settings ----------
const DEFAULTS = { pool: 'pp', scoring: 'normal', keys: '4', topN: '250', rounds: '10', limit: '20', volume: 0.25 };
let settings = { ...DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem('mmq-settings') || '{}');
  for (const k of Object.keys(DEFAULTS)) if (k in saved) settings[k] = saved[k];
} catch {}
const save = () => { try { localStorage.setItem('mmq-settings', JSON.stringify(settings)); } catch {} };
// shared settings (synced in multiplayer) vs. local-only ones (volume)
const SHARED_KEYS = ['pool', 'scoring', 'keys', 'topN', 'rounds', 'limit'];
const onSettingsChanged = () => { if (window.MP && MP.active) MP.onSettingsChanged(); };

function bindSettings() {
  document.querySelectorAll('.seg').forEach(seg => {
    const name = seg.dataset.name;
    const paint = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === settings[name]));
    seg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      settings[name] = b.dataset.v; paint(); save(); refreshSetupInfo(); onSettingsChanged();
    });
    paint();
  });
  for (const id of ['topN', 'rounds', 'limit', 'volume']) {
    const el = $('#' + id);
    el.value = settings[id];
    el.addEventListener('input', () => {
      settings[id] = el.type === 'range' ? Number(el.value) : el.value;
      save(); refreshSetupInfo(); onSettingsChanged();
      if (id === 'volume') setVolume(settings.volume);
    });
  }
  $('#volumeGame').addEventListener('input', e => { settings.volume = Number(e.target.value); save(); setVolume(settings.volume); });
  setVolume(settings.volume);
}

function setVolume(v) {
  audio.volume = v;
  $('#volume').value = v; $('#volumeGame').value = v;
}

// ---------- audio (phones) ----------
// osu! previews are Ogg Vorbis; some iPhones can't decode that at all.
const OGG_OK = !!audio.canPlayType('audio/ogg; codecs="vorbis"');
// Phones only let sound start from a tap. Playing a silent clip on the first tap "unlocks" this
// <audio> element so later questions can start from a timer (multiplayer countdown).
const SILENT = (() => {
  const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked || !audio.paused) return;
  if (!audio.getAttribute('src')) audio.src = SILENT;
  const wasMuted = audio.muted;
  audio.muted = true;
  audio.play().then(() => {
    audioUnlocked = true;
    if (audio.src === SILENT) audio.pause();
  }).catch(() => {}).finally(() => { audio.muted = wasMuted; });
}
['pointerdown', 'keydown', 'touchend'].forEach(ev => document.addEventListener(ev, unlockAudio, { capture: true }));

// play, and if the browser still refuses, offer a big "tap for sound" button
function playAudio(fromSec = 0) {
  try { audio.currentTime = fromSec; } catch {}
  return audio.play().then(() => show($('#tapForSound'), false)).catch(e => {
    if (e && e.name === 'NotAllowedError') show($('#tapForSound'));
  });
}
function stopAudio() { audio.pause(); show($('#tapForSound'), false); }
$('#tapForSound').onclick = () => { audio.play().then(() => show($('#tapForSound'), false)).catch(() => {}); };

// ---------- pool & answers ----------
let POOL = [];
let SONGS = []; // autocomplete entries

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[\(\[（【][^\)\]）】]*(size|ver|version|cut|edit|short|long|full)[^\)\]）】]*[\)\]）】]/gi, '')
    .replace(/[\s\-_~～!！?？.,，、:：;'"’“”·・*★☆♪♥/\\()（）\[\]【】「」『』]/g, '');
}

function buildSongs() {
  const map = new Map();
  for (const s of POOL) {
    const key = norm(s.title) + '|' + norm(s.artist);
    if (!map.has(key)) map.set(key, { title: s.title, titleU: s.titleU, artist: s.artist, artistU: s.artistU, sources: new Set(), mappers: new Set(), rank: INF });
    const e = map.get(key);
    if (s.source) e.sources.add(s.source);
    if (s.creator) e.mappers.add(s.creator);
    e.rank = Math.min(e.rank, POOL_ORDER.mixed(s));
  }
  SONGS = [...map.values()].map(e => {
    const sources = [...e.sources], mappers = [...e.mappers];
    const all = [e.title, e.titleU, e.artist, e.artistU, ...sources, ...mappers];
    return { ...e, source: sources.join(' / '), mappers,
      ntitles: [norm(e.title), norm(e.titleU), baseTitle(e.title), baseTitle(e.titleU)],
      search: all.join(' ').toLowerCase(), nsearch: norm(all.join(' ')) };
  }).sort((a, b) => a.rank - b.rank);
}

// scoring: "normal" = 1 point, "speed" = 10 -> 2 the later you answer
function pointsFor(correct, elapsedMs, limitMs, scoring) {
  if (!correct) return 0;
  if (scoring === 'speed') return Math.max(2, Math.round(10 - 8 * Math.min(1, Math.max(0, elapsedMs) / limitMs)));
  return 1;
}
const maxPoints = (rounds, scoring) => rounds * (scoring === 'speed' ? 10 : 1);

const INF = Infinity;
const POOL_ORDER = {
  pp: s => s.ppRank ?? INF,          // how many sampled players farm it
  classic: s => s.playRank ?? INF,   // total plays of its mania diffs (ranked)
  loved: s => s.lovedRank ?? INF,    // same, among loved sets
  mixed: s => Math.min(s.ppRank ?? INF, s.playRank ?? INF, s.lovedRank ?? INF),
};
const sortedCache = {};
function sortedPool(kind) {
  if (!sortedCache[kind]) {
    const f = POOL_ORDER[kind] || POOL_ORDER.pp;
    const ranked = POOL.filter(s => f(s) < INF).sort((a, b) => f(a) - f(b));
    sortedCache[kind] = ranked.length ? ranked : POOL;
  }
  return sortedCache[kind];
}

// "top N" means the N most popular sets *for the chosen key count* (7K is a minority otherwise)
function eligibleSets(st = settings) {
  const keyOk = d => st.keys === 'any' || d.keys === Number(st.keys);
  const ppOnly = st.pool === 'pp';
  const top = sortedPool(st.pool).filter(s => s.diffs.some(d => keyOk(d) && (!ppOnly || d.pp))).slice(0, Number(st.topN));
  return top.map(s => {
    let diffs = s.diffs.filter(keyOk);
    if (ppOnly && diffs.some(d => d.pp)) diffs = diffs.filter(d => d.pp); // the difficulty people actually farm
    return { set: s, diffs };
  });
}

// The same song often exists in several versions: "C18H27NO3" vs "C18H27NO3(extend)",
// "Bad Apple!! (REDALiCE Remix)", "Reaction feat. Slyleaf", "eternal reality - TV size -".
// Compare the base title with all of that stripped, so any version of the song counts.
function baseTitle(s) {
  const b = (s || '')
    .replace(/[\(\[（【「『<＜〈][^\)\]）】」』>＞〉]*[\)\]）】」』>＞〉]/g, ' ')  // (extend) [Extended Mix] （TV Size）
    .replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, ' ')                          // feat. someone
    .replace(/\s[-~～]\s?[^-~～]*[-~～]\s*$/, ' ');                                // - TV size -
  const n = norm(b);
  return n || norm(s); // a title that is *only* a bracketed part keeps its full form
}

// one key per song (any version / cover), so a game never asks the same song twice
const songKey = set => baseTitle(set.title);
function uniqueSongs(entries) {
  const seen = new Set();
  return entries.filter(e => { const k = songKey(e.set); if (seen.has(k)) return false; seen.add(k); return true; });
}

function checkAnswer(text, set) {
  if (text == null) return false;
  const g = norm(text), gb = baseTitle(text);
  if (!g) return false;
  return [set.title, set.titleU].some(t => t && (g === norm(t) || gb === baseTitle(t)));
}

function fillRevealCard(set, diff) {
  $('#cover').src = `https://assets.ppy.sh/beatmaps/${set.id}/covers/cover.jpg`;
  $('#rTitle').textContent = set.titleU && set.titleU !== set.title ? `${set.titleU}（${set.title}）` : set.title;
  $('#rArtist').textContent = set.artistU && set.artistU !== set.artist ? `${set.artistU}（${set.artist}）` : set.artist;
  $('#rMeta').textContent = (set.source ? `出自 ${set.source} · ` : '') + `mapped by ${set.creator} · [${diff.version}] ${diff.keys}K ${diff.sr.toFixed(2)}★`;
  $('#rLink').href = `https://osu.ppy.sh/beatmapsets/${set.id}#mania/${diff.id}`;
}

// answer box -> single player or multiplayer
const submitAnswer = v => (window.MP && MP.active ? MP.submit(v) : answer(v));

const POOL_HINT = {
  pp: '從排行 1～10000 名抽樣玩家，看大家 top plays 裡最常出現哪些圖。最多人在刷的就是這些。',
  classic: '依 mania 難度的總遊玩次數排序（ranked），老牌經典圖比較多。',
  loved: 'Loved 圖，依 mania 難度的總遊玩次數排序。',
  mixed: 'pp、經典、Loved 三種都算，排名取最前面的那一個。'
};

function refreshSetupInfo() {
  $('#poolHint').textContent = POOL_HINT[settings.pool] || '';
  const n = eligibleSets().length;
  $('#poolInfo').textContent = `符合條件的圖組：${n} 組` + (n < Number(settings.rounds) ? '（不夠出題，放寬條件看看）' : '');
  $('#startBtn').disabled = n === 0;
}

// ---------- single player ----------
let game = null;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

function startGame() {
  const picks = uniqueSongs(shuffle(eligibleSets())).slice(0, Number(settings.rounds)).map(({ set, diffs }) => ({
    set, diff: diffs[Math.random() * diffs.length | 0],
  }));
  game = { picks, idx: -1, score: 0, history: [] };
  show($('#scoreboard')); show($('#quitBtn'));
  $('#scoreLabel').textContent = '0';
  go('game');
  nextRound();
}

let round = null; // per-question state
let tickTimer = 0;

async function nextRound() {
  stopRound();
  game.idx++;
  if (game.idx >= game.picks.length) return finish();
  const { set, diff } = game.picks[game.idx];
  $('#roundLabel').textContent = `第 ${game.idx + 1} / ${game.picks.length} 題`;
  show($('#questionArea')); show($('#revealArea'), false);
  $('#answer').value = ''; $('#answer').disabled = true; hideSuggest();
  $('#prompt').textContent = '載入中…';
  $('#timerBar').style.width = '100%';

  round = { set, diff, done: false };
  const myRound = round;
  try {
    audio.src = `https://b.ppy.sh/preview/${set.id}.mp3`;
    audio.loop = true;
    await new Promise((res, rej) => { audio.oncanplaythrough = () => res(); audio.onerror = () => rej(new Error('音檔載入失敗')); });
  } catch (e) {
    if (myRound !== round) return;
    $('#prompt').textContent = `${e.message}，跳過這題`;
    setTimeout(() => { if (myRound === round) { game.picks.splice(game.idx, 1); game.idx--; nextRound(); } }, 1200);
    return;
  }
  if (myRound !== round) return;

  $('#prompt').textContent = '這是什麼歌？';
  $('#answer').disabled = false; $('#answer').focus();
  playAudio(0);
  round.t0 = performance.now();
  round.limitMs = Number(settings.limit) * 1000;
  tickTimer = setInterval(() => {
    if (!round || round.done) return clearInterval(tickTimer);
    const el = performance.now() - round.t0;
    $('#timerBar').style.width = Math.max(0, 100 - el / round.limitMs * 100) + '%';
    if (el >= round.limitMs) answer(null);
  }, 50);
}

function stopRound() {
  clearInterval(tickTimer);
  stopAudio(); audio.oncanplaythrough = null; audio.onerror = null;
}

function answer(text) {
  if (!round || round.done) return;
  round.done = true;
  clearInterval(tickTimer);
  hideSuggest();
  const { set, diff } = round;
  const correct = checkAnswer(text, set);
  const elapsed = performance.now() - round.t0;
  const pts = pointsFor(correct, elapsed, round.limitMs, settings.scoring);
  game.score += pts;
  game.history.push({ set, diff, correct, pts, guess: text });
  $('#scoreLabel').textContent = game.score;

  show($('#questionArea'), false); show($('#revealArea'));
  const v = $('#verdict');
  v.className = 'verdict ' + (correct ? 'good' : 'bad');
  v.textContent = correct ? `答對！ +${pts}（${(elapsed / 1000).toFixed(1)} 秒）` : text == null ? (elapsed >= round.limitMs ? '時間到' : '放棄') : `答錯（你答：${text}）`;
  fillRevealCard(set, diff);
  $('#nextBtn').focus();
}

function finish() {
  stopRound();
  round = null;
  show($('#quitBtn'), false);
  go('results');
  const max = maxPoints(game.picks.length, settings.scoring);
  const correctN = game.history.filter(h => h.correct).length;
  $('#finalScore').textContent = `${game.score} / ${max} 分 · 答對 ${correctN} / ${game.picks.length} 題`;
  const ol = $('#history'); ol.innerHTML = '';
  for (const h of game.history) {
    const li = document.createElement('li');
    const mark = document.createElement('span');
    mark.className = h.correct ? 'ok' : 'no'; mark.textContent = h.correct ? `✔ +${h.pts} ` : '✘ ';
    const a = document.createElement('a');
    a.href = `https://osu.ppy.sh/beatmapsets/${h.set.id}`; a.target = '_blank'; a.rel = 'noopener';
    a.style.color = 'inherit'; a.textContent = `${h.set.artist} - ${h.set.title}`;
    const sm = document.createElement('small');
    sm.textContent = ` [${h.diff.version}]` + (!h.correct && h.guess ? ` · 你答：${h.guess}` : '');
    li.append(mark, a, sm); ol.append(li);
  }
}

// ---------- autocomplete (title, artist or source) ----------
let sugg = [], sel = -1, lastQuery = '';
function hideSuggest() { show($('#suggest'), false); sugg = []; sel = -1; }
function renderSuggest() {
  const ul = $('#suggest'); ul.innerHTML = '';
  sugg.forEach((s, i) => {
    const li = document.createElement('li');
    if (i === sel) li.className = 'sel';
    li.textContent = s.title;
    const sm = document.createElement('small');
    const mapperHit = lastQuery && s.mappers.find(m => m.toLowerCase().includes(lastQuery));
    sm.textContent = [s.titleU !== s.title ? s.titleU : '', s.artist, s.source ? `出自 ${s.source}` : '', mapperHit ? `map by ${mapperHit}` : ''].filter(Boolean).join(' · ');
    li.append(sm);
    // pointerdown fires immediately on touch too (mousedown comes late on phones, after the input blurs)
    li.addEventListener('pointerdown', e => { e.preventDefault(); $('#answer').value = s.title; hideSuggest(); submitAnswer(s.title); });
    ul.append(li);
  });
  show(ul, sugg.length > 0);
}
$('#answer').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  if (q.length < 1) return hideSuggest();
  const nq = norm(q);
  lastQuery = q;
  // exact title > title starts with > title contains > artist / source / mapper; then popularity
  const score = s => s.ntitles.includes(nq) ? 0 : s.ntitles.some(t => t.startsWith(nq)) ? 1 : s.ntitles.some(t => t.includes(nq)) ? 2 : 3;
  sugg = SONGS.filter(s => s.search.includes(q) || (nq && s.nsearch.includes(nq)))
    .map(s => [score(s), s]).sort((a, b) => a[0] - b[0] || a[1].rank - b[1].rank).slice(0, 12).map(x => x[1]);
  sel = sugg.length ? 0 : -1;
  renderSuggest();
});
$('#answer').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' && sugg.length) { e.preventDefault(); sel = (sel + 1) % sugg.length; renderSuggest(); }
  else if (e.key === 'ArrowUp' && sugg.length) { e.preventDefault(); sel = (sel - 1 + sugg.length) % sugg.length; renderSuggest(); }
  else if (e.key === 'Escape') hideSuggest();
  else if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation(); // don't let the same keypress also trigger "next question"
    const v = sel >= 0 && sugg[sel] ? sugg[sel].title : $('#answer').value.trim();
    if (v) { $('#answer').value = v; hideSuggest(); submitAnswer(v); }
  }
});
$('#answer').addEventListener('blur', () => setTimeout(hideSuggest, 100));

// ---------- buttons ----------
$('#startBtn').onclick = startGame;
$('#submitBtn').onclick = () => { const v = $('#answer').value.trim(); if (v) submitAnswer(v); };
$('#skipBtn').onclick = () => answer(null);
$('#replayBtn').onclick = () => { if (round && !round.done) playAudio(0); };
$('#quitBtn').onclick = () => {
  if (!round && !game) return;
  stopRound(); round = null; game = null;
  show($('#quitBtn'), false); show($('#scoreboard'), false);
  go('setup'); refreshSetupInfo();
};
$('#nextBtn').onclick = () => (window.MP && MP.active ? MP.next() : nextRound());
$('#againBtn').onclick = () => {
  if (window.MP && MP.active) return MP.again();
  show($('#scoreboard'), false); go('setup'); refreshSetupInfo();
};
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.repeat && !(window.MP && MP.active) && round && round.done && !e.target.closest('button, input')) { e.preventDefault(); nextRound(); }
});

// ---------- boot ----------
async function boot() {
  bindSettings();
  show($('#formatWarn'), !OGG_OK);
  go('loading');
  try {
    const r = await fetch('data/pool.json');
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    POOL = data.sets;
    $('#builtAt').textContent = `題庫共 ${POOL.length} 組 · 更新於 ${data.builtAt.slice(0, 10)}`;
  } catch (e) {
    $('#loadingText').textContent = '題庫載入失敗（' + e.message + '）';
    return;
  }
  buildSongs();
  go('setup');
  refreshSetupInfo();
  if (window.MP) MP.init();
}
boot();
