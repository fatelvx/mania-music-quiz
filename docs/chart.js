// .osu (mania) parser + canvas playfield renderer
window.Chart = (() => {
  function parseOsu(text) {
    let section = '';
    const out = { keys: 4, previewTime: -1, notes: [] };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;
      const sec = line.match(/^\[(.+)\]$/);
      if (sec) { section = sec[1]; continue; }
      if (section === 'General' && line.startsWith('PreviewTime:')) out.previewTime = Number(line.split(':')[1]);
      else if (section === 'Difficulty' && line.startsWith('CircleSize:')) out.keys = Math.round(Number(line.split(':')[1]));
      else if (section === 'HitObjects') {
        const f = line.split(',');
        const x = Number(f[0]), time = Number(f[2]), type = Number(f[3]);
        const col = Math.min(out.keys - 1, Math.max(0, Math.floor(x * out.keys / 512)));
        const end = (type & 128) ? Number((f[5] || '').split(':')[0]) : time;
        out.notes.push({ col, time, end: end > time ? end : time });
      }
    }
    out.notes.sort((a, b) => a.time - b.time);
    out.lastTime = out.notes.length ? out.notes[out.notes.length - 1].end : 0;
    return out;
  }

  function laneColors(k) {
    const W = '#e8e8f0', B = '#66ccff', G = '#ffcc55';
    const presets = {
      1: [G], 2: [W, W], 3: [W, G, W], 4: [W, B, B, W], 5: [W, B, G, B, W], 6: [W, B, W, W, B, W],
      7: [W, B, W, G, W, B, W], 8: [G, W, B, W, W, B, W, G], 9: [W, B, W, B, G, B, W, B, W], 10: [W, B, W, B, W, W, B, W, B, W],
    };
    return presets[k] || Array.from({ length: k }, (_, i) => (i % 2 ? B : W));
  }

  class Renderer {
    constructor(canvas) {
      this.c = canvas; this.ctx = canvas.getContext('2d');
      this.chart = null; this.clock = null; this.visibleMs = 700; this.raf = 0;
    }
    load(chart) { this.chart = chart; this.colors = laneColors(chart.keys); }
    start(clock) { this.clock = clock; cancelAnimationFrame(this.raf); const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); }; loop(); }
    stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
    clear() { this.stop(); const { ctx, c } = this; ctx.fillStyle = '#0c0b10'; ctx.fillRect(0, 0, c.width, c.height); }

    draw() {
      const { ctx, c, chart } = this;
      const W = c.width, H = c.height;
      ctx.fillStyle = '#0c0b10'; ctx.fillRect(0, 0, W, H);
      if (!chart) return;
      const k = chart.keys;
      const laneW = Math.min(64, (W - 40) / k);
      const fieldW = laneW * k, x0 = (W - fieldW) / 2;
      const hitY = H - 70;
      const now = this.clock();
      const vis = this.visibleMs;

      // lanes
      ctx.fillStyle = '#16141d'; ctx.fillRect(x0, 0, fieldW, H);
      ctx.strokeStyle = '#2b2836'; ctx.lineWidth = 1;
      for (let i = 0; i <= k; i++) { ctx.beginPath(); ctx.moveTo(x0 + i * laneW + .5, 0); ctx.lineTo(x0 + i * laneW + .5, H); ctx.stroke(); }

      const yOf = t => hitY - (t - now) / vis * hitY;
      const active = new Array(k).fill(false);
      const noteH = Math.max(10, laneW * 0.28);
      for (const n of chart.notes) {
        if (n.time > now + vis) break;
        if (n.end < now - 120) continue;
        const x = x0 + n.col * laneW + 2, w = laneW - 4;
        const color = this.colors[n.col];
        if (Math.abs(n.time - now) < 50 || (n.end > n.time && now >= n.time && now <= n.end)) active[n.col] = true;
        if (n.end > n.time) {
          const yTop = yOf(n.end), yBot = Math.min(yOf(n.time), n.time < now ? hitY : yOf(n.time));
          ctx.globalAlpha = 0.45; ctx.fillStyle = color;
          ctx.fillRect(x + w * 0.15, yTop, w * 0.7, Math.max(0, yBot - yTop));
          ctx.globalAlpha = 1;
          if (n.time >= now - 20) { ctx.fillStyle = color; ctx.fillRect(x, yOf(n.time) - noteH, w, noteH); }
        } else if (n.time >= now - 20) {
          ctx.fillStyle = color; ctx.fillRect(x, yOf(n.time) - noteH, w, noteH);
        }
      }

      // receptors
      for (let i = 0; i < k; i++) {
        const x = x0 + i * laneW + 2, w = laneW - 4;
        if (active[i]) {
          const g = ctx.createLinearGradient(0, hitY - 160, 0, hitY);
          g.addColorStop(0, 'rgba(255,95,162,0)'); g.addColorStop(1, 'rgba(255,95,162,.35)');
          ctx.fillStyle = g; ctx.fillRect(x, hitY - 160, w, 160);
        }
        ctx.fillStyle = active[i] ? '#ff5fa2' : '#3a3548';
        ctx.fillRect(x, hitY, w, 8);
      }
      ctx.fillStyle = '#0c0b10'; ctx.fillRect(x0, hitY + 8, fieldW, H - hitY - 8);
    }
  }

  return { parseOsu, Renderer };
})();
