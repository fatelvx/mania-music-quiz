const $ = s => document.querySelector(s);
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const screens = ['loading', 'setup', 'game', 'results'];
const go = name => screens.forEach(s => show($('#' + s), s === name));
const audio = $('#audio');
const renderer = new Chart.Renderer($('#playfield'));

const MODE_HINT = {
  audio: '播一段官方 preview 音樂，猜曲名。',
  chart: '完全靜音，只看譜面捲動，從 pattern 認出是哪首歌。',
  hybrid: '前半段只有譜面（答對 2 分），之後才放音樂（答對 1 分）。',
};

// ---------- settings ----------
const DEFAULTS = { mode: 'audio', keys: '4', topN: '250', srMin: 0, srMax: 15, rounds: '10', limit: '20', volume: 0.25, speed: 700 };
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('mmq-settings') || '{}')); } catch {}
const save = () => { try { localStorage.setItem('mmq-settings', JSON.stringify(settings)); } catch {} };

function bindSettings() {
  document.querySelectorAll('.seg').forEach(seg => {
    const name = seg.dataset.name;
    const paint = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === settings[name]));
    seg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      settings[name] = b.dataset.v; paint(); save(); refreshSetupInfo();
    });
    paint();
  });
  for (const id of ['topN', 'srMin', 'srMax', 'rounds', 'limit', 'volume', 'speed']) {
    const el = $('#' + id);
    el.value = settings[id];
    el.addEventListener('input', () => {
      settings[id] = el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value;
      save(); refreshSetupInfo();
      if (id === 'volume') audio.volume = settings.volume;
      if (id === 'speed') renderer.visibleMs = settings.speed;
    });
  }
  audio.volume = settings.volume;
  renderer.visibleMs = settings.speed;
}

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
    if (!map.has(key)) map.set(key, { title: s.title, titleU: s.titleU, artist: s.artist, artistU: s.artistU, plays: 0,
      search: [s.title, s.titleU, s.artist, s.artistU].join(' ').toLowerCase() });
    map.get(key).plays += s.plays || 0;
  }
  SONGS = [...map.values()].sort((a, b) => b.plays - a.plays);
}

function eligibleSets() {
  const top = POOL.slice(0, Number(settings.topN));
  const out = [];
  for (const s of top) {
    const diffs = s.diffs.filter(d =>
      (settings.keys === 'any' || d.keys === Number(settings.keys)) &&
      (settings.mode === 'audio' || (d.sr >= settings.srMin && d.sr <= settings.srMax)));
    if (diffs.length) out.push({ set: s, diffs });
  }
  return out;
}

function refreshSetupInfo() {
  $('#modeHint').textContent = MODE_HINT[settings.mode];
  const n = eligibleSets().length;
  $('#poolInfo').textContent = `符合條件的圖組：${n} 組` + (n < Number(settings.rounds) ? '（不夠出題，放寬條件看看）' : '');
  $('#startBtn').disabled = n === 0;
}

// ---------- game ----------
let game = null;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

function startGame() {
  const picks = shuffle(eligibleSets()).slice(0, Number(settings.rounds)).map(({ set, diffs }) => ({
    set, diff: diffs[Math.random() * diffs.length | 0],
  }));
  game = { picks, idx: -1, score: 0, history: [] };
  show($('#scoreboard'));
  $('#scoreLabel').textContent = '0';
  go('game');
  nextRound();
}

let round = null; // per-question state
let tickRaf = 0;

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

  const mode = settings.mode;
  round = { mode, set, diff, phase: mode === 'hybrid' ? 1 : 0, chart: null, done: false };
  const myRound = round;

  try {
    const jobs = [];
    // always load the preview so the reveal can play it, but only wait for it when the question needs it
    audio.src = `https://b.ppy.sh/preview/${set.id}.mp3`;
    audio.loop = true;
    if (mode !== 'chart') {
      jobs.push(new Promise((res, rej) => {
        audio.oncanplaythrough = () => res(); audio.onerror = () => rej(new Error('音檔載入失敗'));
      }));
    }
    if (mode !== 'audio') {
      jobs.push(loadChart(set.id, diff.id).then(c => { myRound.chart = c; }));
    }
    await Promise.all(jobs);
  } catch (e) {
    if (myRound !== round) return;
    $('#prompt').textContent = `${e.message}，跳過這題`;
    setTimeout(() => { if (myRound === round) { game.picks.splice(game.idx, 1); game.idx--; nextRound(); } }, 1200);
    return;
  }
  if (myRound !== round) return;

  if (round.chart) {
    round.synced = round.chart.synced;
    round.chartStart = 0; // excerpts are pre-cut to start at the preview point
    renderer.load(round.chart);
  }
  $('#prompt').textContent = mode === 'audio' ? '這是什麼歌？' : mode === 'chart' ? '這張譜是哪首歌？' : '這張譜是哪首歌？（還沒放音樂）';
  $('#answer').disabled = false; $('#answer').focus();
  show($('#revealAudioBtn'), mode === 'hybrid');
  beginPlayback();

  round.t0 = performance.now();
  round.limitMs = Number(settings.limit) * 1000;
  const tick = () => {
    if (!round || round.done) return;
    const el = performance.now() - round.t0;
    $('#timerBar').style.width = Math.max(0, 100 - el / round.limitMs * 100) + '%';
    if (round.phase === 1 && el >= round.limitMs / 2) enterPhase2();
    if (el >= round.limitMs) return answer(null);
    tickRaf = requestAnimationFrame(tick);
  };
  tick();
}

const chartCache = new Map();
async function loadChart(setId, diffId) {
  if (!chartCache.has(setId)) {
    chartCache.set(setId, fetch(`data/charts/${setId}.json`).then(r => { if (!r.ok) throw new Error('譜面載入失敗'); return r.json(); }));
  }
  let all;
  try { all = await chartCache.get(setId); } catch (e) { chartCache.delete(setId); throw e; }
  const ex = all[diffId];
  if (!ex) throw new Error('譜面載入失敗');
  return { keys: ex.k, synced: !!ex.s, notes: ex.n.map(([col, time, len]) => ({ col, time, end: time + len })) };
}

function silentClock() {
  const start = round.chartStart, t0 = performance.now(), win = 10000;
  return () => start + ((performance.now() - t0) % win);
}

function beginPlayback() {
  const { mode } = round;
  show($('#audioOnly'), mode === 'audio');
  show($('.speed'), mode !== 'audio');
  show($('#phaseTag'), mode === 'hybrid');
  if (mode === 'audio') { renderer.clear(); audio.currentTime = 0; audio.play(); }
  else if (mode === 'chart') renderer.start(silentClock());
  else if (round.phase === 1) { $('#phaseTag').textContent = '🔇 只有譜面 · 2 分'; renderer.start(silentClock()); }
  else startSyncedChart();
}

function startSyncedChart() {
  $('#phaseTag').textContent = '🔊 有音樂了 · 1 分';
  audio.currentTime = 0; audio.play();
  if (round.synced) renderer.start(() => round.chartStart + audio.currentTime * 1000);
  else renderer.start(silentClock());
}

function enterPhase2() {
  if (!round || round.phase !== 1) return;
  round.phase = 2;
  show($('#revealAudioBtn'), false);
  $('#prompt').textContent = '這張譜是哪首歌？';
  startSyncedChart();
}

function stopRound() {
  cancelAnimationFrame(tickRaf);
  audio.pause(); audio.oncanplaythrough = null; audio.onerror = null;
  renderer.stop();
}

function answer(text) {
  if (!round || round.done) return;
  round.done = true;
  cancelAnimationFrame(tickRaf);
  hideSuggest();
  const { set, diff } = round;
  const guess = text == null ? '' : norm(text);
  const correct = !!guess && (guess === norm(set.title) || guess === norm(set.titleU));
  const pts = !correct ? 0 : round.phase === 1 ? 2 : 1;
  game.score += pts;
  game.history.push({ set, diff, correct, pts, guess: text });
  $('#scoreLabel').textContent = game.score;

  // reveal: let the music play (and the chart sync to it if possible)
  if (round.mode !== 'audio' && audio.paused) { round.phase = 2; show($('#phaseTag'), false); startSyncedChart(); }
  show($('#phaseTag'), false);
  show($('#questionArea'), false); show($('#revealArea'));
  const v = $('#verdict');
  v.className = 'verdict ' + (correct ? 'good' : 'bad');
  v.textContent = correct ? `答對！ +${pts}` : text == null ? (performance.now() - round.t0 >= round.limitMs ? '時間到' : '放棄') : `答錯（你答：${text}）`;
  $('#cover').src = `https://assets.ppy.sh/beatmaps/${set.id}/covers/cover.jpg`;
  $('#rTitle').textContent = set.titleU && set.titleU !== set.title ? `${set.titleU}（${set.title}）` : set.title;
  $('#rArtist').textContent = set.artistU && set.artistU !== set.artist ? `${set.artistU}（${set.artist}）` : set.artist;
  $('#rMeta').textContent = (set.source ? `出自 ${set.source} · ` : '') + `mapped by ${set.creator} · [${diff.version}] ${diff.keys}K ${diff.sr.toFixed(2)}★`;
  $('#rLink').href = `https://osu.ppy.sh/beatmapsets/${set.id}#mania/${diff.id}`;
  $('#nextBtn').focus();
}

function finish() {
  stopRound();
  round = null;
  go('results');
  const max = game.picks.length * (settings.mode === 'hybrid' ? 2 : 1);
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

// ---------- autocomplete ----------
let sugg = [], sel = -1;
function hideSuggest() { show($('#suggest'), false); sugg = []; sel = -1; }
function renderSuggest() {
  const ul = $('#suggest'); ul.innerHTML = '';
  sugg.forEach((s, i) => {
    const li = document.createElement('li');
    if (i === sel) li.className = 'sel';
    li.textContent = s.title;
    const sm = document.createElement('small');
    sm.textContent = [s.titleU !== s.title ? s.titleU : '', s.artist].filter(Boolean).join(' · ');
    li.append(sm);
    li.addEventListener('mousedown', e => { e.preventDefault(); $('#answer').value = s.title; hideSuggest(); answer(s.title); });
    ul.append(li);
  });
  show(ul, sugg.length > 0);
}
$('#answer').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  if (q.length < 1) return hideSuggest();
  const nq = norm(q);
  sugg = SONGS.filter(s => s.search.includes(q) || norm(s.title).includes(nq) || norm(s.titleU).includes(nq)).slice(0, 10);
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
    if (v) { $('#answer').value = v; answer(v); }
  }
});
$('#answer').addEventListener('blur', () => setTimeout(hideSuggest, 100));

// ---------- buttons ----------
$('#startBtn').onclick = startGame;
$('#submitBtn').onclick = () => { const v = $('#answer').value.trim(); if (v) answer(v); };
$('#skipBtn').onclick = () => answer(null);
$('#revealAudioBtn').onclick = enterPhase2;
$('#replayBtn').onclick = () => { if (round && !round.done) { renderer.stop(); audio.pause(); beginPlayback(); } };
$('#nextBtn').onclick = nextRound;
$('#againBtn').onclick = () => { show($('#scoreboard'), false); go('setup'); refreshSetupInfo(); };
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.repeat && round && round.done && !e.target.closest('button, input')) { e.preventDefault(); nextRound(); }
});

// ---------- boot ----------
async function boot() {
  bindSettings();
  go('loading');
  try {
    const r = await fetch('data/pool.json');
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    POOL = data.sets;
    $('#builtAt').textContent = `題庫 ${POOL.length} 組 · 更新於 ${data.builtAt.slice(0, 10)} · 依 mania 遊玩次數排序`;
  } catch (e) {
    $('#loadingText').textContent = '題庫載入失敗（' + e.message + '）';
    return;
  }
  buildSongs();
  go('setup');
  refreshSetupInfo();
}
boot();
