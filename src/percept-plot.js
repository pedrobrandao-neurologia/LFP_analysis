/* ==========================================================================
   PERCEPT LFP STUDIO — camada gráfica (Canvas 2D, sem dependências)
   ========================================================================== */
(function (root) {
'use strict';

/* ------------------------------------------------------------ colormaps  */
function ramp(stops) {
  return t => {
    t = Math.max(0, Math.min(1, t));
    const n = stops.length - 1, i = Math.min(n - 1, Math.floor(t * n)), f = t * n - i;
    const a = stops[i], b = stops[i + 1];
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  };
}
const CMAPS = {
  viridis: ramp([[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
    [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]]),
  magma: ramp([[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122],
    [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]]),
  ice: ramp([[8, 24, 44], [17, 61, 92], [24, 104, 128], [46, 148, 148], [110, 188, 168],
    [186, 219, 199], [240, 244, 240]]),
  divergent: ramp([[33, 62, 110], [72, 116, 166], [146, 180, 210], [238, 238, 238],
    [230, 172, 150], [190, 96, 80], [130, 30, 40]])
};

/* ------------------------------------------------------------ formatação */
function fmt(v, d) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(d == null ? 1 : d);
  return v.toFixed(d == null ? (a < 1 ? 2 : a < 100 ? 1 : 0) : d);
}
function niceTicks(lo, hi, target) {
  target = target || 6;
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) return [lo];
  const span = hi - lo, raw = span / target, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = []; let t = Math.ceil(lo / step) * step;
  while (t <= hi + step * 1e-6) { out.push(Math.abs(t) < step * 1e-9 ? 0 : t); t += step; }
  return out;
}
function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++)
    for (const m of [1, 2, 5]) { const v = m * Math.pow(10, e); if (v >= lo && v <= hi) out.push(v); }
  return out;
}

/* ============================================================== CHART ==== */
class Chart {
  constructor(canvas, o) {
    o = o || {};
    this.c = canvas;
    this.dpr = Math.min(root.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    this.w = o.width || rect.width || 640;
    this.h = o.height || rect.height || 300;
    canvas.width = this.w * this.dpr; canvas.height = this.h * this.dpr;
    canvas.style.width = this.w + 'px'; canvas.style.height = this.h + 'px';
    this.ctx = canvas.getContext('2d');
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.pad = Object.assign({ l: 58, r: 16, t: 22, b: 40 }, o.pad);
    this.xlim = o.xlim || [0, 1]; this.ylim = o.ylim || [0, 1];
    this.xlog = !!o.xlog; this.ylog = !!o.ylog;
    this.xlabel = o.xlabel || ''; this.ylabel = o.ylabel || ''; this.title = o.title || '';
    this.theme = Object.assign({
      ink: '#0E1A24', muted: '#5C7284', rule: '#C4D0D9', grid: '#E1E8ED',
      panel: '#FFFFFF', mono: '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    }, o.theme);
    this.ctx.fillStyle = this.theme.panel;
    this.ctx.fillRect(0, 0, this.w, this.h);
    this._legend = [];
  }
  get x0() { return this.pad.l; }
  get x1() { return this.w - this.pad.r; }
  get y0() { return this.h - this.pad.b; }
  get y1() { return this.pad.t; }
  X(v) {
    if (this.xlog) {
      const a = Math.log10(Math.max(this.xlim[0], 1e-12)), b = Math.log10(this.xlim[1]);
      return this.x0 + (Math.log10(Math.max(v, 1e-12)) - a) / (b - a) * (this.x1 - this.x0);
    }
    return this.x0 + (v - this.xlim[0]) / (this.xlim[1] - this.xlim[0]) * (this.x1 - this.x0);
  }
  Y(v) {
    if (this.ylog) {
      const a = Math.log10(Math.max(this.ylim[0], 1e-12)), b = Math.log10(this.ylim[1]);
      return this.y0 - (Math.log10(Math.max(v, 1e-12)) - a) / (b - a) * (this.y0 - this.y1);
    }
    return this.y0 - (v - this.ylim[0]) / (this.ylim[1] - this.ylim[0]) * (this.y0 - this.y1);
  }
  clip(on) {
    const x = this.ctx;
    if (on) { x.save(); x.beginPath(); x.rect(this.x0, this.y1, this.x1 - this.x0, this.y0 - this.y1); x.clip(); }
    else x.restore();
  }
  axes(o) {
    o = o || {};
    const x = this.ctx, th = this.theme;
    x.font = th.mono; x.lineWidth = 1;
    const xt = o.xticks || (this.xlog ? logTicks(this.xlim[0], this.xlim[1]) : niceTicks(this.xlim[0], this.xlim[1], o.nx || 6));
    const yt = o.yticks || (this.ylog ? logTicks(this.ylim[0], this.ylim[1]) : niceTicks(this.ylim[0], this.ylim[1], o.ny || 5));
    x.strokeStyle = th.grid;
    x.beginPath();
    if (o.grid !== false) {
      xt.forEach(t => { const px = Math.round(this.X(t)) + .5; x.moveTo(px, this.y1); x.lineTo(px, this.y0); });
      yt.forEach(t => { const py = Math.round(this.Y(t)) + .5; x.moveTo(this.x0, py); x.lineTo(this.x1, py); });
    }
    x.stroke();
    x.strokeStyle = th.rule; x.beginPath();
    x.moveTo(this.x0, Math.round(this.y0) + .5); x.lineTo(this.x1, Math.round(this.y0) + .5);
    x.moveTo(Math.round(this.x0) + .5, this.y0); x.lineTo(Math.round(this.x0) + .5, this.y1);
    x.stroke();
    x.fillStyle = th.muted; x.textAlign = 'center'; x.textBaseline = 'top';
    xt.forEach(t => x.fillText(o.xfmt ? o.xfmt(t) : fmt(t), this.X(t), this.y0 + 6));
    x.textAlign = 'right'; x.textBaseline = 'middle';
    yt.forEach(t => x.fillText(o.yfmt ? o.yfmt(t) : fmt(t), this.x0 - 7, this.Y(t)));
    x.fillStyle = th.ink;
    if (this.xlabel) { x.textAlign = 'center'; x.textBaseline = 'bottom'; x.fillText(this.xlabel, (this.x0 + this.x1) / 2, this.h - 3); }
    if (this.ylabel) {
      x.save(); x.translate(11, (this.y0 + this.y1) / 2); x.rotate(-Math.PI / 2);
      x.textAlign = 'center'; x.textBaseline = 'top'; x.fillText(this.ylabel, 0, 0); x.restore();
    }
    if (this.title) {
      x.textAlign = 'left'; x.textBaseline = 'bottom';
      x.font = '600 11.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      x.fillStyle = th.ink; x.fillText(this.title, this.x0, this.y1 - 7);
    }
    return this;
  }
  line(xs, ys, o) {
    o = o || {}; const x = this.ctx; this.clip(true);
    x.beginPath(); x.strokeStyle = o.color || '#000'; x.lineWidth = o.width || 1.4;
    x.lineJoin = 'round'; x.lineCap = 'round';
    if (o.dash) x.setLineDash(o.dash);
    let started = false;
    for (let i = 0; i < xs.length; i++) {
      const vy = ys[i];
      if (!isFinite(vy) || !isFinite(xs[i]) || (this.ylog && vy <= 0)) { started = false; continue; }
      const px = this.X(xs[i]), py = this.Y(vy);
      if (!started) { x.moveTo(px, py); started = true; } else x.lineTo(px, py);
    }
    x.stroke(); x.setLineDash([]); this.clip(false);
    if (o.label) this._legend.push({ label: o.label, color: o.color, dash: o.dash });
    return this;
  }
  area(xs, lo, hi, o) {
    o = o || {}; const x = this.ctx; this.clip(true);
    x.beginPath(); let started = false;
    for (let i = 0; i < xs.length; i++) {
      if (!isFinite(hi[i])) continue;
      const px = this.X(xs[i]), py = this.Y(hi[i]);
      if (!started) { x.moveTo(px, py); started = true; } else x.lineTo(px, py);
    }
    for (let i = xs.length - 1; i >= 0; i--) {
      if (!isFinite(lo[i])) continue;
      x.lineTo(this.X(xs[i]), this.Y(lo[i]));
    }
    x.closePath();
    x.globalAlpha = o.alpha == null ? .18 : o.alpha;
    x.fillStyle = o.color || '#888'; x.fill(); x.globalAlpha = 1;
    this.clip(false);
    if (o.label) this._legend.push({ label: o.label, color: o.color, swatch: 'area' });
    return this;
  }
  bars(centers, values, o) {
    o = o || {}; const x = this.ctx; this.clip(true);
    const w = o.width || (this.X(centers[1]) - this.X(centers[0])) * .8 || 8;
    const base = this.Y(o.base == null ? Math.max(this.ylim[0], 0) : o.base);
    centers.forEach((c, i) => {
      if (!isFinite(values[i])) return;
      x.fillStyle = typeof o.color === 'function' ? o.color(values[i], i) : (o.color || '#666');
      const px = this.X(c) - w / 2, py = this.Y(values[i]);
      x.fillRect(px, Math.min(py, base), w, Math.abs(base - py) || 1);
    });
    this.clip(false);
    if (o.label) this._legend.push({ label: o.label, color: typeof o.color === 'function' ? '#666' : o.color, swatch: 'area' });
    return this;
  }
  scatter(xs, ys, o) {
    o = o || {}; const x = this.ctx; this.clip(true);
    const r = o.size || 2.6;
    for (let i = 0; i < xs.length; i++) {
      if (!isFinite(xs[i]) || !isFinite(ys[i])) continue;
      x.beginPath();
      x.fillStyle = typeof o.color === 'function' ? o.color(i) : (o.color || '#333');
      x.globalAlpha = o.alpha == null ? .75 : o.alpha;
      x.arc(this.X(xs[i]), this.Y(ys[i]), r, 0, 6.284); x.fill();
    }
    x.globalAlpha = 1; this.clip(false);
    if (o.label) this._legend.push({ label: o.label, color: typeof o.color === 'function' ? '#333' : o.color });
    return this;
  }
  /* matrix: array de linhas (cada linha = array de valores). rows→y, cols→x */
  heat(matrix, o) {
    o = o || {};
    const rows = matrix.length, cols = matrix[0].length;
    const cm = CMAPS[o.cmap || 'viridis'];
    let zmin = o.zmin, zmax = o.zmax;
    if (zmin == null || zmax == null) {
      let mn = Infinity, mx = -Infinity;
      for (const r of matrix) for (const v of r) if (isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
      zmin = zmin == null ? mn : zmin; zmax = zmax == null ? mx : zmax;
    }
    const off = document.createElement('canvas');
    off.width = cols; off.height = rows;
    const octx = off.getContext('2d');
    const img = octx.createImageData(cols, rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const v = matrix[r][c], k = (r * cols + c) * 4;
      if (!isFinite(v)) { img.data[k + 3] = 0; continue; }
      const t = (v - zmin) / (zmax - zmin || 1);
      const rgb = cm(t).match(/\d+/g);
      img.data[k] = +rgb[0]; img.data[k + 1] = +rgb[1]; img.data[k + 2] = +rgb[2]; img.data[k + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    const x = this.ctx; this.clip(true);
    x.imageSmoothingEnabled = o.smooth !== false;
    x.drawImage(off, this.x0, this.y1, this.x1 - this.x0, this.y0 - this.y1);
    this.clip(false);
    this._z = { zmin, zmax, cmap: o.cmap || 'viridis' };
    return this;
  }
  colorbar(o) {
    o = o || {};
    const z = this._z || {}; const x = this.ctx;
    const bw = 10, bx = this.x1 + 6, by0 = this.y1, by1 = this.y0;
    const cm = CMAPS[z.cmap || 'viridis'];
    for (let py = by0; py < by1; py++) {
      x.fillStyle = cm(1 - (py - by0) / (by1 - by0));
      x.fillRect(bx, py, bw, 1);
    }
    x.strokeStyle = this.theme.rule; x.strokeRect(bx + .5, by0 + .5, bw, by1 - by0);
    x.fillStyle = this.theme.muted; x.font = this.theme.mono;
    x.textAlign = 'left'; x.textBaseline = 'top'; x.fillText(fmt(z.zmax), bx + bw + 4, by0);
    x.textBaseline = 'bottom'; x.fillText(fmt(z.zmin), bx + bw + 4, by1);
    if (o.label) {
      x.save(); x.translate(bx + bw + 34, (by0 + by1) / 2); x.rotate(-Math.PI / 2);
      x.textAlign = 'center'; x.textBaseline = 'top'; x.fillText(o.label, 0, 0); x.restore();
    }
    return this;
  }
  vline(v, o) {
    o = o || {}; const x = this.ctx; this.clip(true);
    x.beginPath(); x.strokeStyle = o.color || '#999'; x.lineWidth = o.width || 1;
    if (o.dash !== null) x.setLineDash(o.dash || [4, 3]);
    const px = Math.round(this.X(v)) + .5; x.moveTo(px, this.y1); x.lineTo(px, this.y0); x.stroke();
    x.setLineDash([]);
    if (o.label) {
      x.fillStyle = o.color || '#999'; x.font = this.theme.mono;
      x.textAlign = o.align || 'left'; x.textBaseline = 'top';
      x.fillText(o.label, px + (o.align === 'right' ? -4 : 4), this.y1 + (o.dy || 2));
    }
    this.clip(false); return this;
  }
  hline(v, o) {
    o = o || {}; const x = this.ctx; this.clip(true);
    x.beginPath(); x.strokeStyle = o.color || '#999'; x.lineWidth = o.width || 1;
    x.setLineDash(o.dash || [4, 3]);
    const py = Math.round(this.Y(v)) + .5; x.moveTo(this.x0, py); x.lineTo(this.x1, py); x.stroke();
    x.setLineDash([]);
    if (o.label) {
      x.fillStyle = o.color || '#999'; x.font = this.theme.mono;
      x.textAlign = 'right'; x.textBaseline = 'bottom'; x.fillText(o.label, this.x1 - 3, py - 2);
    }
    this.clip(false); return this;
  }
  span(a, b, o) {
    o = o || {}; const x = this.ctx; this.clip(true);
    x.globalAlpha = o.alpha == null ? .12 : o.alpha;
    x.fillStyle = o.color || '#888';
    x.fillRect(this.X(a), this.y1, this.X(b) - this.X(a), this.y0 - this.y1);
    x.globalAlpha = 1;
    if (o.label) {
      x.fillStyle = o.color || '#888'; x.font = this.theme.mono;
      x.textAlign = 'center'; x.textBaseline = 'top';
      x.fillText(o.label, (this.X(a) + this.X(b)) / 2, this.y1 + 2);
    }
    this.clip(false); return this;
  }
  marker(vx, vy, o) {
    o = o || {}; const x = this.ctx;
    x.fillStyle = o.color || '#c00'; x.beginPath();
    const px = this.X(vx), py = this.Y(vy), s = o.size || 5;
    if (o.shape === 'tri') { x.moveTo(px, py - 2); x.lineTo(px - s, py - s * 2 - 2); x.lineTo(px + s, py - s * 2 - 2); }
    else x.arc(px, py, s, 0, 6.284);
    x.closePath(); x.fill();
    if (o.label) {
      x.font = '600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      x.textAlign = o.align || 'left'; x.textBaseline = 'bottom';
      x.fillText(o.label, px + (o.align === 'right' ? -8 : 8), py - 4);
    }
    return this;
  }
  text(px, py, s, o) {
    o = o || {}; const x = this.ctx;
    x.font = o.font || this.theme.mono; x.fillStyle = o.color || this.theme.muted;
    x.textAlign = o.align || 'left'; x.textBaseline = o.baseline || 'top';
    x.fillText(s, px, py); return this;
  }
  legend(o) {
    o = o || {};
    if (!this._legend.length) return this;
    const x = this.ctx; x.font = this.theme.mono;
    const items = this._legend;
    const wid = Math.max(...items.map(i => x.measureText(i.label).width)) + 26;
    const lh = 14, bx = o.x != null ? o.x : this.x1 - wid - 8, by = o.y != null ? o.y : this.y1 + 6;
    x.globalAlpha = .92; x.fillStyle = this.theme.panel;
    x.fillRect(bx - 5, by - 4, wid + 10, items.length * lh + 8);
    x.globalAlpha = 1; x.strokeStyle = this.theme.grid;
    x.strokeRect(bx - 5.5, by - 4.5, wid + 10, items.length * lh + 8);
    items.forEach((it, i) => {
      const yy = by + i * lh + lh / 2;
      x.strokeStyle = it.color; x.fillStyle = it.color; x.lineWidth = 2;
      if (it.swatch === 'area') { x.globalAlpha = .3; x.fillRect(bx, yy - 4, 16, 8); x.globalAlpha = 1; }
      else {
        x.beginPath(); if (it.dash) x.setLineDash(it.dash);
        x.moveTo(bx, yy); x.lineTo(bx + 16, yy); x.stroke(); x.setLineDash([]);
      }
      x.fillStyle = this.theme.ink; x.textAlign = 'left'; x.textBaseline = 'middle';
      x.fillText(it.label, bx + 21, yy);
    });
    return this;
  }
}

/* ====================================================== GRÁFICO POLAR ==== */
function polarBars(canvas, values, o) {
  o = o || {};
  const dpr = Math.min(root.devicePixelRatio || 1, 2);
  const W = o.width || canvas.getBoundingClientRect().width || 320;
  const H = o.height || W;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const x = canvas.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.fillStyle = o.panel || '#fff'; x.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2 + 4, R = Math.min(W, H) / 2 - 30;
  const vals = values.filter(isFinite);
  const vmin = o.rmin != null ? o.rmin : Math.min(...vals);
  const vmax = o.rmax != null ? o.rmax : Math.max(...vals);
  const r0 = R * .32;
  const rad = v => r0 + (v - vmin) / (vmax - vmin || 1) * (R - r0);
  /* grade horária */
  x.strokeStyle = o.grid || '#E1E8ED'; x.fillStyle = o.muted || '#5C7284';
  x.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  for (let h = 0; h < 24; h += 3) {
    const a = (h / 24) * 2 * Math.PI - Math.PI / 2;
    x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    x.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); x.stroke();
    x.fillText(String(h).padStart(2, '0') + 'h', cx + Math.cos(a) * (R + 15), cy + Math.sin(a) * (R + 15));
  }
  [r0, (r0 + R) / 2, R].forEach(r => { x.beginPath(); x.arc(cx, cy, r, 0, 6.284); x.stroke(); });
  /* faixa noturna 22h–06h */
  if (o.night !== false) {
    x.globalAlpha = .10; x.fillStyle = o.nightColor || '#1B3A5C';
    x.beginPath(); x.moveTo(cx, cy);
    x.arc(cx, cy, R, (22 / 24) * 2 * Math.PI - Math.PI / 2, (30 / 24) * 2 * Math.PI - Math.PI / 2);
    x.closePath(); x.fill(); x.globalAlpha = 1;
  }
  /* barras */
  const n = values.length, aw = (2 * Math.PI / n) * .82;
  values.forEach((v, i) => {
    if (!isFinite(v)) return;
    const a = (i / n) * 2 * Math.PI - Math.PI / 2;
    x.beginPath();
    x.fillStyle = typeof o.color === 'function' ? o.color(v, i) : (o.color || '#1B4A72');
    x.arc(cx, cy, rad(v), a - aw / 2, a + aw / 2);
    x.arc(cx, cy, r0, a + aw / 2, a - aw / 2, true);
    x.closePath(); x.fill();
  });
  /* vetor de acrofase */
  if (o.acrophaseHours != null && isFinite(o.acrophaseHours)) {
    const a = (o.acrophaseHours / 24) * 2 * Math.PI - Math.PI / 2;
    x.strokeStyle = o.acroColor || '#9C3050'; x.lineWidth = 2.4;
    x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(a) * R * .95, cy + Math.sin(a) * R * .95); x.stroke();
    x.beginPath(); x.arc(cx + Math.cos(a) * R * .95, cy + Math.sin(a) * R * .95, 3.5, 0, 6.284);
    x.fillStyle = o.acroColor || '#9C3050'; x.fill();
  }
  x.fillStyle = o.ink || '#0E1A24';
  x.font = '600 11.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  if (o.center) x.fillText(o.center, cx, cy);
  if (o.title) { x.textAlign = 'left'; x.textBaseline = 'top'; x.fillText(o.title, 8, 6); }
  return canvas;
}

/* ------------------------------------------------------------- exportar  */
function downloadCanvas(canvas, name) {
  const a = document.createElement('a');
  a.download = name.endsWith('.png') ? name : name + '.png';
  a.href = canvas.toDataURL('image/png');
  a.click();
}
function downloadText(text, name, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.download = name; a.href = URL.createObjectURL(blob); a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function toCSV(rows, headers) {
  const esc = v => (v == null || (typeof v === 'number' && !isFinite(v))) ? ''
    : (/[",;\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  const h = headers || Object.keys(rows[0] || {});
  return [h.join(','), ...rows.map(r => h.map(k => esc(r[k])).join(','))].join('\n');
}

const API = { Chart, polarBars, CMAPS, fmt, niceTicks, logTicks, downloadCanvas, downloadText, toCSV };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.PerceptPlot = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
