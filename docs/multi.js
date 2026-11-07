// Multiplayer over WebRTC (PeerJS public signalling server).
//
// Topology: full mesh. Every player keeps a copy of the game state that the host broadcasts.
// Joining: the host also holds a well-known "door" peer id per room; newcomers knock there,
//          get the state, then open direct connections to the other players.
// Host migration: heartbeats detect a dead host; the connected player who joined earliest takes
//          over (deterministic, no voting), bumps `epoch`, rebuilds this round's answers from
//          resends, and claims the door id.
window.MP = (() => {
  const NS = 'mmq7f3';                 // namespace on the shared PeerJS server
  const HB_MS = 1000, DEAD_MS = 4500;  // heartbeat / declare-dead
  const LEAD_MS = 3500;                // countdown before each question
  const REVEAL_MS = 8000;              // auto-advance after reveal
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const mp = { active: false };
  let room = null, myId = null, myName = '';
  let peer = null, door = null;
  const conns = new Map(), lastSeen = new Map();
  const suspects = new Set();          // players we gave up waiting on during an election
  const seesHost = new Map();          // peerId -> did their last heartbeat say they still reach the host
  let state = null;                    // replicated game state (host-authoritative)
  let secret = { answers: {} };        // host-only: answers to the current question
  let offset = 0, offsetHost = null;   // hostClock - localClock
  let myAnswers = {};                  // round n -> { text, elapsed }
  let hostTimer = 0, hbTimer = 0, doorTimer = 0, allTimer = 0;
  let playback = null;
  let SET_BY_ID = null;
  const evlog = [];
  const log = (...a) => { const nm = id => (player(id) || { name: String(id).slice(-4) }).name; evlog.push(new Date().toISOString().slice(17, 23) + ' ' + a.map(x => (typeof x === 'string' && x.startsWith(NS) ? nm(x) : x)).join(' ')); if (evlog.length > 100) evlog.shift(); };

  const rand = (n, chars = 'abcdefghijkmnpqrstuvwxyz23456789') => Array.from({ length: n }, () => chars[Math.random() * chars.length | 0]).join('');
  const doorId = r => `${NS}-${r}-door`;
  const amHost = () => !!state && state.hostId === myId;
  const player = id => state && state.players.find(p => p.id === id);
  const me = () => player(myId);
  const setById = id => (SET_BY_ID ||= new Map(POOL.map(s => [s.id, s]))).get(id);
  const status = t => { $('#mpStatus').textContent = t; };
  const netStatus = t => { $('#lobbyNet').textContent = t; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- peers ----------
  function makePeer(id) {
    return new Promise((res, rej) => {
      const p = new Peer(id, { debug: 1 });
      const onErr = e => { p.off('open', onOpen); try { p.destroy(); } catch {} rej(e); };
      const onOpen = () => { p.off('error', onErr); res(p); };
      p.once('open', onOpen);
      p.once('error', onErr);
    });
  }

  // reconnect to the signalling server after a drop, but never resurrect a peer we released
  function keepAlive(p, current) {
    p.on('disconnected', () => setTimeout(() => { if (current() === p && !p.destroyed) try { p.reconnect(); } catch {} }, 1000));
  }

  let knockReject = null;
  function setupPeer() {
    peer.on('connection', c => { if (c.metadata && c.metadata.room === room) wire(c); else c.close(); });
    peer.on('error', e => {
      if (e.type === 'peer-unavailable' && knockReject && String(e.message).includes(doorId(room))) knockReject(new Error('找不到房間'));
      else if (e.type !== 'peer-unavailable') console.warn('peer error', e.type, e);
    });
    keepAlive(peer, () => (mp.active ? peer : null));
  }

  function wire(c) {
    c.on('open', () => {
      const old = conns.get(c.peer);
      conns.set(c.peer, c);
      if (old && old !== c) try { old.close(); } catch {}
      lastSeen.set(c.peer, Date.now());
      suspects.delete(c.peer);
      if (amHost()) {
        const p = player(c.peer);
        if (p && !p.on) { p.on = true; broadcastState(); } else c.send({ type: 'state', st: state });
      }
      render();
    });
    c.on('data', m => { lastSeen.set(c.peer, Date.now()); onMsg(c.peer, m); });
    c.on('close', () => drop(c.peer, c));
    c.on('error', () => drop(c.peer, c));
  }

  function connectTo(id) {
    if (id === myId || conns.has(id) || !peer || peer.destroyed) return;
    wire(peer.connect(id, { reliable: true, metadata: { room } }));
  }
  // later joiners dial earlier ones -> exactly one connection per pair
  function heal() {
    if (!state || !me()) return;
    for (const p of state.players) if (p.on && p.id !== myId && p.order < me().order && !conns.has(p.id)) connectTo(p.id);
  }

  const send = (id, m) => { const c = conns.get(id); if (c && c.open) c.send(m); };
  const broadcast = m => { for (const c of conns.values()) if (c.open) c.send(m); };
  function toHost(m) { if (amHost()) onMsg(myId, m); else send(state.hostId, m); }
  function broadcastState() { broadcast({ type: 'state', st: state }); render(); }

  // ---------- the room "door" (well-known id, held by the current host) ----------
  async function claimDoor() {
    clearTimeout(doorTimer);
    if (!amHost() || door) return;
    try {
      door = await makePeer(doorId(room));
      if (!amHost()) { door.destroy(); door = null; return; }
      door.on('connection', onKnock);
      keepAlive(door, () => door);
      netStatus('');
    } catch (e) {
      // the old host's id may take a while to be released by the signalling server
      netStatus('房間入口重建中…（新玩家暫時進不來，遊戲照常）');
      doorTimer = setTimeout(claimDoor, 3000);
    }
  }
  function releaseDoor() { clearTimeout(doorTimer); const d = door; door = null; if (d) try { d.destroy(); } catch {} }

  function onKnock(c) {
    c.on('data', m => {
      if (m.type !== 'join' || !amHost()) return;
      hostAddPlayer(m.peerId, m.name);
      c.send({ type: 'welcome', st: state });
      setTimeout(() => { try { c.close(); } catch {} }, 3000);
    });
  }

  function knock() {
    return new Promise((res, rej) => {
      const c = peer.connect(doorId(room), { reliable: true });
      const done = () => { clearTimeout(to); knockReject = null; };
      const to = setTimeout(() => { done(); try { c.close(); } catch {} rej(new Error('連線逾時')); }, 10000);
      knockReject = e => { done(); rej(e); };
      c.on('open', () => c.send({ type: 'join', peerId: myId, name: myName }));
      c.on('data', m => { if (m.type === 'welcome') { done(); res(m.st); setTimeout(() => { try { c.close(); } catch {} }, 500); } });
    });
  }

  // ---------- messages ----------
  function onMsg(from, m) {
    switch (m.type) {
      case 'hb': seesHost.set(from, { v: !!m.sh, t: Date.now() }); break;
      case 'ping': send(from, { type: 'pong', t0: m.t0, th: Date.now() }); break;
      case 'pong': onPong(from, m); break;
      case 'state': onState(from, m.st); break;
      case 'answer': if (amHost()) hostAnswer(from, m); break;
      case 'bye': drop(from); break;
    }
  }

  function onState(from, st) {
    if (state && st.room !== state.room) return;
    if (state && st.epoch < state.epoch) return;
    if (state && st.epoch === state.epoch && st.hostId !== state.hostId) {
      // two hosts in the same epoch (split brain): the one who joined earlier wins
      const ord = (s, id) => (s.players.find(p => p.id === id) || { order: 1e9 }).order;
      if (ord(st, st.hostId) > ord(state, state.hostId)) return;
    }
    const prev = state;
    if (!prev || prev.epoch !== st.epoch || prev.hostId !== st.hostId) log('accept state epoch', st.epoch, 'host', st.hostId, 'from', from);
    if (amHost() && st.hostId !== myId) stepDown();
    state = st;
    if (prev && prev.hostId !== st.hostId) {
      // keep the same real-time start moment while we re-measure the clock against the new host
      if (prev.round && st.round && prev.round.n === st.round.n) offset = offset + (st.round.startAt - prev.round.startAt);
      offsetHost = null;
    }
    if (offsetHost !== state.hostId) syncClock();
    // a new host lost the answers sent to the old one: resend ours
    if (prev && (prev.epoch !== st.epoch || prev.hostId !== st.hostId) && st.phase === 'question' && myAnswers[st.round.n]) {
      toHost({ type: 'answer', n: st.round.n, ...myAnswers[st.round.n] });
    }
    heal();
    render();
  }

  // ---------- clock sync ----------
  let pings = [];
  function syncClock() {
    if (!state) return;
    if (amHost()) { offset = 0; offsetHost = myId; return; }
    pings = [];
    const host = state.hostId;
    for (let i = 0; i < 5; i++) setTimeout(() => send(host, { type: 'ping', t0: Date.now() }), i * 150);
  }
  function onPong(from, m) {
    if (!state || from !== state.hostId) return;
    const now = Date.now(), rtt = now - m.t0;
    pings.push({ rtt, off: m.th - (m.t0 + rtt / 2) });
    const best = pings.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    offset = best.off; offsetHost = from;
  }

  // ---------- liveness & host migration ----------
  function drop(id, c) {
    if (c && conns.get(id) && conns.get(id) !== c) return; // a stale duplicate closed
    const conn = conns.get(id);
    conns.delete(id); lastSeen.delete(id); seesHost.delete(id);
    if (conn) try { conn.close(); } catch {}
    if (!state || !mp.active) return;
    log('drop', id, 'reason', c ? 'close' : 'timeout/bye');
    if (id === state.hostId) return onHostLost(id);
    if (amHost()) {
      const p = player(id);
      if (p && p.on) { p.on = false; broadcastState(); scheduleAllAnswered(); }
    }
    render();
  }

  function onHostLost(oldId, lostAt = Date.now()) {
    if (!state || state.hostId !== oldId || conns.has(oldId)) return; // already resolved
    // wait one heartbeat so the others can tell us whether *they* still reach the host
    const waited = Date.now() - lostAt;
    if (waited < HB_MS * 1.6) {
      netStatus('房主沒有回應…');
      return setTimeout(() => onHostLost(oldId, lostAt), HB_MS * 1.6 - waited);
    }
    // only *my* link to the host broke while others still reach it -> reconnect instead of taking over
    const witnesses = [...conns.keys()].filter(id => { const h = seesHost.get(id); return id !== oldId && h && h.v && h.t > lostAt + 200; });
    log('hostLost eval', oldId, 'witnesses', witnesses.length, 'conns', [...conns.keys()].length);
    if (witnesses.length) {
      netStatus('跟房主的連線斷了，重新連線中…');
      connectTo(oldId);
      setTimeout(() => onHostLost(oldId), 5000);
      return;
    }
    const old = player(oldId);
    if (old) old.on = false;
    const alive = state.players
      .filter(p => p.on && !suspects.has(p.id) && (p.id === myId || conns.has(p.id)))
      .sort((a, b) => a.order - b.order);
    const next = alive[0];
    if (!next) return;
    log('elect', next.id, 'alive', alive.map(p => p.name).join(','));
    if (next.id === myId) return becomeHost(oldId);
    netStatus(`房主斷線，等待 ${next.name} 接手…`);
    const epoch = state.epoch;
    setTimeout(() => {
      // successor never announced itself -> skip it and elect again
      if (state && state.epoch === epoch && state.hostId === oldId) { suspects.add(next.id); onHostLost(oldId, Date.now() - HB_MS * 2); }
    }, 6000);
  }

  function becomeHost(oldId) {
    // rebase host-clock timestamps onto my clock
    if (state.round) state.round.startAt -= offset;
    if (state.revealUntil) state.revealUntil -= offset;
    offset = 0; offsetHost = myId;
    state.epoch++;
    state.hostId = myId;
    const old = player(oldId);
    if (old) old.on = false;
    secret = { answers: {} };
    if (state.phase === 'question' && myAnswers[state.round.n]) secret.answers[myId] = myAnswers[state.round.n];
    if (state.round) state.round.answered = Object.keys(secret.answers);
    netStatus('原房主斷線，你接手當房主了');
    broadcastState();
    scheduleHost();
    claimDoor();
  }

  function stepDown() { releaseDoor(); clearTimeout(hostTimer); clearTimeout(allTimer); }

  function heartbeat() {
    broadcast({ type: 'hb', sh: !!state && (amHost() || conns.has(state.hostId)) });
    const now = Date.now();
    for (const [id, t] of lastSeen) if (now - t > DEAD_MS) drop(id);
    heal();
  }

  // ---------- host logic ----------
  function hostAddPlayer(id, name) {
    const back = state.players.find(p => !p.on && p.name === name);
    if (back) { back.id = id; back.on = true; }
    else {
      let n = name, i = 2;
      while (state.players.some(p => p.name === n)) n = `${name} (${i++})`;
      state.players.push({ id, name: n, order: state.nextOrder++, score: 0, on: true });
    }
    broadcastState();
  }

  function hostStart() {
    if (!amHost()) return;
    const n = eligibleSets(state.settings).length;
    if (!n) return alert('符合條件的圖組是 0，放寬設定看看');
    state.total = Math.min(Number(state.settings.rounds), n);
    state.players.forEach(p => { p.score = 0; });
    state.history = []; state.used = []; state.round = null; state.reveal = null;
    hostNext();
  }

  function hostNext() {
    if (!amHost()) return;
    clearTimeout(hostTimer);
    const st = state.settings;
    const cands = eligibleSets(st).filter(e => !state.used.includes(e.set.id));
    if ((state.round && state.round.n >= state.total) || !cands.length) {
      state.phase = 'results'; state.round = null;
      return broadcastState();
    }
    const e = cands[Math.random() * cands.length | 0];
    const d = e.diffs[Math.random() * e.diffs.length | 0];
    state.used.push(e.set.id);
    state.round = {
      n: (state.round ? state.round.n : 0) + 1, setId: e.set.id, diffId: d.id,
      startAt: Date.now() + LEAD_MS, limitMs: Number(st.limit) * 1000, mode: st.mode, answered: [],
    };
    state.reveal = null; state.phase = 'question';
    secret = { answers: {} };
    broadcastState();
    scheduleHost();
  }

  function hostAnswer(from, m) {
    const r = state.round;
    if (state.phase !== 'question' || !r || m.n !== r.n) return;
    if (Date.now() > r.startAt + r.limitMs + 1500) return;
    secret.answers[from] = { text: String(m.text).slice(0, 200), elapsed: Number(m.elapsed) || 0 };
    r.answered = Object.keys(secret.answers);
    broadcastState();
    scheduleAllAnswered();
  }

  // everyone online has answered -> reveal a moment later (gives time to change an answer)
  function scheduleAllAnswered() {
    clearTimeout(allTimer);
    if (!amHost() || state.phase !== 'question') return;
    const online = state.players.filter(p => p.on);
    if (online.length && online.every(p => secret.answers[p.id])) allTimer = setTimeout(() => {
      if (state.phase === 'question' && state.players.filter(p => p.on).every(p => secret.answers[p.id])) hostReveal();
    }, 1200);
  }

  function hostReveal() {
    if (!amHost() || state.phase !== 'question') return;
    clearTimeout(hostTimer); clearTimeout(allTimer);
    const r = state.round, set = setById(r.setId);
    const answers = {};
    for (const p of state.players) {
      const a = secret.answers[p.id];
      const correct = !!a && checkAnswer(a.text, set);
      const pts = !correct ? 0 : r.mode === 'hybrid' && a.elapsed < r.limitMs / 2 ? 2 : 1;
      p.score += pts;
      answers[p.id] = { text: a ? a.text : null, correct, pts };
    }
    state.reveal = { n: r.n, answers };
    state.history.push({ setId: r.setId, diffId: r.diffId, right: Object.keys(answers).filter(id => answers[id].correct) });
    state.phase = 'reveal';
    state.revealUntil = Date.now() + REVEAL_MS;
    broadcastState();
    scheduleHost();
  }

  function scheduleHost() {
    clearTimeout(hostTimer);
    if (!amHost()) return;
    if (state.phase === 'question') hostTimer = setTimeout(hostReveal, Math.max(0, state.round.startAt + state.round.limitMs + 400 - Date.now()));
    else if (state.phase === 'reveal') hostTimer = setTimeout(hostNext, Math.max(0, state.revealUntil - Date.now()));
  }

  // ---------- client: playback synced to the host clock ----------
  function stopPlayback() {
    if (playback) clearInterval(playback.iv);
    playback = null;
    audio.pause(); renderer.stop();
    show($('#countdown'), false);
  }

  function startPlayback(r) {
    stopPlayback();
    const pb = playback = { r, n: r.n, phase: r.mode === 'hybrid' ? 1 : 0, started: false, chart: null, iv: 0 };
    renderer.chart = null; renderer.clear();
    audio.src = `https://b.ppy.sh/preview/${r.setId}.mp3`;
    audio.loop = true;
    if (r.mode !== 'audio') {
      loadChart(r.setId, r.diffId).then(c => { if (playback === pb) { pb.chart = c; renderer.load(c); } })
        .catch(() => { if (playback === pb) $('#prompt').textContent = '譜面載入失敗，只能用聽的了'; });
    }
    show($('#audioOnly'), r.mode === 'audio');
    show($('.speed'), r.mode !== 'audio');
    show($('#phaseTag'), r.mode === 'hybrid');
    show($('#questionArea')); show($('#revealArea'), false);
    $('#answer').value = ''; $('#answer').disabled = false; hideSuggest();
    $('#mpMyAnswer').textContent = '';
    $('#prompt').textContent = r.mode === 'audio' ? '這是什麼歌？' : '這張譜是哪首歌？' + (r.mode === 'hybrid' ? '（還沒放音樂）' : '');
    // timers keep running in background tabs (requestAnimationFrame doesn't); the chart itself still draws via rAF
    const tick = () => {
      if (playback !== pb) return clearInterval(pb.iv);
      const el = Date.now() - (r.startAt - offset);
      if (el < 0) {
        show($('#countdown')); $('#countdown').textContent = Math.min(3, Math.ceil(-el / 1000));
        $('#timerBar').style.width = '100%';
      } else {
        show($('#countdown'), false);
        if (!pb.started) { pb.started = true; begin(pb, el); $('#answer').focus(); }
        if (pb.phase === 1 && el >= r.limitMs / 2) phase2(pb, el);
        $('#timerBar').style.width = Math.max(0, 100 - el / r.limitMs * 100) + '%';
      }
    };
    pb.iv = setInterval(tick, 50);
    tick();
  }

  const localStart = pb => pb.r.startAt - offset;
  function playAudioAt(sec) {
    const d = audio.duration || 10;
    try { audio.currentTime = sec % d; } catch {}
    audio.play().catch(() => {});
  }
  function chartClockSilent(pb, from) { return () => ((Date.now() - from) % 10000 + 10000) % 10000; }
  function chartClockSynced(pb) {
    return pb.chart && pb.chart.synced ? () => audio.currentTime * 1000 : chartClockSilent(pb, localStart(pb));
  }

  function begin(pb, el) {
    const r = pb.r;
    if (r.mode === 'audio') { renderer.clear(); playAudioAt(el / 1000); }
    else if (r.mode === 'chart' || pb.phase === 1) {
      $('#phaseTag').textContent = '🔇 只有譜面 · 2 分';
      renderer.start(chartClockSilent(pb, localStart(pb)));
    }
  }
  function phase2(pb, el) {
    pb.phase = 2;
    $('#phaseTag').textContent = '🔊 有音樂了 · 1 分';
    $('#prompt').textContent = '這張譜是哪首歌？';
    playAudioAt((el - pb.r.limitMs / 2) / 1000);
    renderer.start(chartClockSynced(pb));
  }

  // ---------- rendering ----------
  function render() {
    if (!mp.active || !state) return;
    show($('#scoreboard')); show($('#mpLeaveHeader'), state.phase !== 'lobby');
    const mine = me();
    $('#scoreLabel').textContent = mine ? mine.score : 0;
    $('#roundLabel').textContent = `房間 ${room}` + (state.round ? ` · 第 ${state.round.n} / ${state.total} 題` : '');
    if (state.phase === 'lobby') renderLobby();
    else if (state.phase === 'question') renderQuestion();
    else if (state.phase === 'reveal') renderReveal();
    else if (state.phase === 'results') renderResults();
  }

  function playerRows(ul, mode) {
    const sorted = [...state.players].sort((a, b) => (mode === 'lobby' ? a.order - b.order : b.score - a.score || a.order - b.order));
    ul.innerHTML = sorted.map(p => {
      let extra = '';
      if (mode === 'question') extra = state.round.answered.includes(p.id) ? '<span class="ans ok">✓ 已作答</span>' : '<span class="ans">思考中…</span>';
      if (mode === 'reveal') {
        const a = state.reveal.answers[p.id] || { text: null };
        extra = `<span class="ans ${a.correct ? 'ok' : 'no'}">${a.correct ? '✔ +' + a.pts : '✘'}</span>`;
      }
      const guess = mode === 'reveal' ? `<span class="guess">${esc((state.reveal.answers[p.id] || {}).text ?? '（沒作答）')}</span>` : '';
      const crown = p.id === state.hostId ? '👑 ' : '';
      const cls = [p.id === myId ? 'me' : '', p.on ? '' : 'off'].join(' ');
      return `<li class="${cls}"><span class="name">${crown}${esc(p.name)}${p.on ? '' : '（離線）'}${guess}</span>${extra}${mode !== 'lobby' ? `<span class="pts">${p.score}</span>` : ''}</li>`;
    }).join('');
  }

  const POOL_NAME = { pp: 'pp 圖', classic: '經典', mixed: '混合' };
  const MODE_NAME = { audio: '聽歌猜曲', chart: '看譜猜歌', hybrid: '先譜後歌' };
  function renderLobby() {
    stopPlayback();
    go('lobby');
    $('#lobbyRoom').textContent = room;
    const link = `${location.origin}${location.pathname}?room=${room}`;
    $('#lobbyLink').textContent = link; $('#lobbyLink').href = link;
    playerRows($('#lobbyPlayers'), 'lobby');
    const card = $('#settingsCard');
    if (amHost()) {
      if (card.parentElement !== $('#lobbySettingsSlot')) $('#lobbySettingsSlot').append(card);
      show(card); show($('#lobbySummary'), false);
      $('#settingsTitle').textContent = '房間設定（你是房主）';
      $('#startBtn').textContent = '開始遊戲';
      refreshSetupInfo();
    } else {
      show($('#lobbySummary'));
      if (card.parentElement === $('#lobbySettingsSlot')) restoreSettingsCard();
      const s = state.settings;
      $('#lobbySummary').innerHTML = `<h2>房間設定</h2>
        <p>題庫：${POOL_NAME[s.pool]} · 前 ${s.topN} 組</p>
        <p>模式：${MODE_NAME[s.mode]} · ${s.keys === 'any' ? '全部鍵數' : s.keys + 'K'}${s.mode !== 'audio' ? ` · ${s.srMin}–${s.srMax}★` : ''}</p>
        <p>${s.rounds} 題 · 每題 ${s.limit} 秒</p>
        <p class="hint">等房主開始…（音量、譜面速度在遊戲畫面可以自己調）</p>`;
    }
  }

  function renderQuestion() {
    go('game');
    show($('#mpPlayers')); show($('#skipBtn'), false); show($('#replayBtn'), false); show($('#revealAudioBtn'), false);
    if (!playback || playback.n !== state.round.n) startPlayback(state.round);
    playerRows($('#mpPlayers'), 'question');
  }

  function renderReveal() {
    go('game');
    show($('#mpPlayers'));
    const r = state.round;
    if (!playback || playback.n !== r.n) startPlayback(r); // joined during the reveal
    const pb = playback;
    clearInterval(pb.iv); show($('#countdown'), false); show($('#phaseTag'), false);
    $('#timerBar').style.width = '0%';
    if (r.mode !== 'audio' && audio.paused) { pb.phase = 2; playAudioAt(0); renderer.start(chartClockSynced(pb)); }
    hideSuggest();
    show($('#questionArea'), false); show($('#revealArea'));
    const mine = state.reveal.answers[myId] || { text: null };
    const v = $('#verdict');
    v.className = 'verdict ' + (mine.correct ? 'good' : 'bad');
    v.textContent = mine.correct ? `答對！ +${mine.pts}` : mine.text == null ? '沒作答' : `答錯（你答：${mine.text}）`;
    fillRevealCard(setById(r.setId), setById(r.setId).diffs.find(d => d.id === r.diffId) || setById(r.setId).diffs[0]);
    show($('#nextBtn'), amHost());
    $('#mpNextHint').textContent = amHost() ? '幾秒後會自動下一題' : '等待下一題…';
    playerRows($('#mpPlayers'), 'reveal');
  }

  function renderResults() {
    stopPlayback();
    go('results');
    const ranked = [...state.players].sort((a, b) => b.score - a.score);
    const max = state.total * (state.settings.mode === 'hybrid' ? 2 : 1);
    $('#finalScore').textContent = `🏆 ${ranked[0] ? ranked[0].name : ''}（滿分 ${max}）`;
    const ol = $('#history');
    ol.innerHTML = ranked.map(p => `<li${p.id === myId ? ' class="ok"' : ''}>${esc(p.name)} — <b>${p.score}</b> 分</li>`).join('') +
      '<li style="list-style:none;margin-top:12px"><small>題目：</small></li>' +
      state.history.map(h => {
        const s = setById(h.setId);
        const names = h.right.map(id => (player(id) || {}).name).filter(Boolean);
        return `<li style="list-style:none"><small><a style="color:inherit" target="_blank" rel="noopener" href="https://osu.ppy.sh/beatmapsets/${h.setId}">${esc(s.artist)} - ${esc(s.title)}</a> · 答對：${names.length ? esc(names.join('、')) : '沒人'}</small></li>`;
      }).join('');
    $('#againBtn').textContent = amHost() ? '回大廳' : '等房主回大廳…';
    $('#againBtn').disabled = !amHost();
  }

  function restoreSettingsCard() {
    const card = $('#settingsCard');
    $('#setup').append(card);
    show(card);
    $('#settingsTitle').textContent = '單人設定';
    $('#startBtn').textContent = '開始';
  }

  // ---------- entry points ----------
  function getName() {
    const n = $('#mpName').value.trim().slice(0, 20);
    if (!n) { status('先輸入暱稱'); $('#mpName').focus(); return null; }
    try { localStorage.setItem('mmq-name', n); } catch {}
    return n;
  }

  async function begin_(asHost) {
    if (typeof Peer === 'undefined') { status('多人模組載入失敗（PeerJS），重新整理看看'); return; }
    myName = getName(); if (!myName) return;
    $('#mpCreateBtn').disabled = $('#mpJoinBtn').disabled = true;
    try {
      if (asHost) {
        status('開房中…');
        for (let i = 0; i < 5 && !door; i++) {
          room = rand(5, CODE_CHARS);
          try { door = await makePeer(doorId(room)); } catch (e) { if (e.type !== 'unavailable-id') throw e; }
        }
        door.on('connection', onKnock);
        keepAlive(door, () => door);
        peer = await makePeer(`${NS}-${room}-${rand(8)}`); myId = peer.id; setupPeer();
        state = {
          room, epoch: 1, hostId: myId, nextOrder: 1, total: 0,
          settings: Object.fromEntries(SHARED_KEYS.map(k => [k, settings[k]])),
          players: [{ id: myId, name: myName, order: 0, score: 0, on: true }],
          phase: 'lobby', round: null, reveal: null, history: [], used: [],
        };
        offset = 0; offsetHost = myId;
      } else {
        room = $('#mpRoom').value.trim().toUpperCase();
        if (!/^[A-Z0-9]{5}$/.test(room)) { status('房號是 5 個字'); return; }
        status('連線中…');
        peer = await makePeer(`${NS}-${room}-${rand(8)}`); myId = peer.id; setupPeer();
        let st = null, lastErr = null;
        for (let i = 0; i < 4 && !st; i++) {
          try { st = await knock(); } catch (e) { lastErr = e; status(`${e.message}，重試中…（${i + 1}/4）`); await new Promise(r => setTimeout(r, 2500)); }
        }
        if (!st) throw lastErr || new Error('加入失敗');
        state = st;
        heal();
        syncClock();
      }
      mp.active = true;
      stopRound(); round = null;
      history.replaceState(null, '', `?room=${room}`);
      clearInterval(hbTimer); hbTimer = setInterval(heartbeat, HB_MS);
      status('');
      render();
    } catch (e) {
      console.error(e);
      status('失敗：' + (e.message || e.type || e));
      cleanup();
    } finally {
      $('#mpCreateBtn').disabled = $('#mpJoinBtn').disabled = false;
    }
  }

  function cleanup() {
    clearInterval(hbTimer); clearTimeout(hostTimer); clearTimeout(allTimer);
    releaseDoor();
    for (const c of conns.values()) try { c.close(); } catch {}
    conns.clear(); lastSeen.clear(); suspects.clear(); seesHost.clear();
    const p = peer; peer = null;
    if (p) try { p.destroy(); } catch {} state = null; myAnswers = {}; secret = { answers: {} };
    mp.active = false;
  }

  function leave() {
    broadcast({ type: 'bye' });
    stopPlayback();
    setTimeout(cleanup, 200);
    mp.active = false;
    restoreSettingsCard();
    show($('#mpPlayers'), false); show($('#skipBtn')); show($('#replayBtn')); show($('#nextBtn'));
    $('#againBtn').disabled = false; $('#againBtn').textContent = '再來一局';
    show($('#scoreboard'), false); show($('#mpLeaveHeader'), false);
    history.replaceState(null, '', location.pathname);
    go('setup'); refreshSetupInfo();
  }

  // ---------- public API used by app.js ----------
  mp.submit = text => {
    if (!state || state.phase !== 'question' || !playback) return;
    const r = state.round;
    const a = { text, elapsed: Date.now() - (r.startAt - offset) };
    if (a.elapsed < 0) return; // still counting down
    myAnswers[r.n] = a;
    toHost({ type: 'answer', n: r.n, ...a });
    $('#mpMyAnswer').textContent = `已送出：${text}（時間內可以改）`;
    $('#answer').value = '';
  };
  mp.next = () => { if (amHost() && state.phase === 'reveal') hostNext(); };
  mp.again = () => { if (amHost()) { state.phase = 'lobby'; state.round = null; state.reveal = null; broadcastState(); } };
  mp.onSettingsChanged = () => {
    if (!amHost() || state.phase !== 'lobby') return;
    state.settings = Object.fromEntries(SHARED_KEYS.map(k => [k, settings[k]]));
    broadcastState();
  };
  mp.init = () => {
    try { $('#mpName').value = localStorage.getItem('mmq-name') || ''; } catch {}
    const q = new URLSearchParams(location.search).get('room');
    if (q) { $('#mpRoom').value = q.toUpperCase(); status('輸入暱稱後按「加入」'); ($('#mpName').value ? $('#mpJoinBtn') : $('#mpName')).focus(); }
    $('#mpCreateBtn').onclick = () => begin_(true);
    $('#mpJoinBtn').onclick = () => begin_(false);
    $('#mpRoom').addEventListener('keydown', e => { if (e.key === 'Enter') begin_(false); });
    $('#leaveBtn').onclick = leave;
    $('#mpLeaveHeader').onclick = () => { if (confirm('確定離開房間？')) leave(); };
    $('#copyLinkBtn').onclick = () => { navigator.clipboard?.writeText($('#lobbyLink').href).then(() => { $('#copyLinkBtn').textContent = '已複製'; setTimeout(() => { $('#copyLinkBtn').textContent = '複製連結'; }, 1500); }).catch(() => {}); };
    const single = $('#startBtn').onclick;
    $('#startBtn').onclick = () => (mp.active ? hostStart() : single());
    window.addEventListener('beforeunload', () => { if (mp.active) broadcast({ type: 'bye' }); });
  };
  // for debugging / tests
  mp._debug = () => ({ log: evlog, myId, room, state, conns: [...conns.keys()], offset, amHost: amHost(), door: !!door });
  mp._killNetwork = () => { clearInterval(hbTimer); releaseDoor(); for (const c of conns.values()) try { c.close(); } catch {} const p = peer; peer = null; if (p) p.destroy(); };

  return mp;
})();
