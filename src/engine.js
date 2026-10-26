// Thanos Snap engine. Runs in the call page's MAIN world (and directly in
// test/test.html). Wraps getUserMedia so the camera track the call receives
// passes through our compositor, which can swap you for the empty room.
//
// Talks to bridge.js (or the test page) with window.postMessage:
//   in:  { __thanosSnap: 'to-engine',   type, payload }
//   out: { __thanosSnap: 'from-engine', type, payload }
(() => {
  'use strict';

  const NS = '__thanosSnap';
  if (window[NS + 'Engine']) return;

  const SnapAnalyzer = window.ThanosSnapAnalyzer;
  try {
    delete window.ThanosSnapAnalyzer;
  } catch {}

  const md = navigator.mediaDevices;
  const origGetUserMedia = md && md.getUserMedia ? MediaDevices.prototype.getUserMedia : null;
  const supported = !!(
    origGetUserMedia &&
    window.MediaStreamTrackProcessor &&
    window.MediaStreamTrackGenerator &&
    window.OffscreenCanvas &&
    window.VideoFrame
  );

  const debug = { errors: 0, lastError: null, frames: 0 };
  Object.defineProperty(window, NS + 'Engine', {
    value: Object.freeze({
      debug,
      originalGetUserMedia: (c) => origGetUserMedia.call(navigator.mediaDevices, c),
    }),
  });

  const FADE_SEC = 0.7;
  const DUST_SWEEP_SEC = 2.0; // time for the dissolve front to cross the frame
  const DUST_LIFE_MAX = 1.7; // longest particle flight

  const settings = { thanos: true, snapEnabled: false, sensitivity: 0.5, doubleSnap: false };
  const pipelines = new Set();
  let state = 'live'; // live | vanishing | vanished | returning
  let anim = null;
  let room = null; // { bitmap, url }
  let roomVersion = 0;
  let capture = null;
  let detector = null;
  let calibration = null; // thresholds learned from the user's own snaps
  let learning = null;
  let lastSnapAt = 0;
  let lastToggleAt = 0;

  // ---------- messaging ----------

  function post(type, payload) {
    window.postMessage({ [NS]: 'from-engine', type, payload }, '*');
  }

  function notice(key) {
    post('notice', { key });
  }

  function emitStatus() {
    post('status', {
      supported,
      camera: pipelines.size > 0,
      state,
      hasRoom: !!room,
      detector: detector ? detector.status : 'off',
      capture: capture ? capture.phase : null,
      calibrated: !!calibration,
      learning: !!learning,
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[NS] !== 'to-engine') return;
    const p = d.payload || {};
    switch (d.type) {
      case 'hello':
        emitStatus();
        break;
      case 'settings':
        for (const k of Object.keys(settings)) if (k in p) settings[k] = p[k];
        syncDetector();
        break;
      case 'room':
        setRoomFromUrl(p.dataUrl || null);
        break;
      case 'toggle':
        toggle();
        break;
      case 'vanish':
        vanish();
        break;
      case 'return':
        reappear();
        break;
      case 'captureRoom':
        startCapture(p);
        break;
      case 'cancelCapture':
        endCapture(false);
        break;
      case 'calibration':
        calibration = p.value || null;
        if (detector && detector.analyzer) detector.analyzer.configure(null, calibration);
        emitStatus();
        break;
      case 'learnSnap':
        startLearning();
        break;
      case 'cancelLearn':
        endLearning(false);
        break;
    }
  });

  // ---------- state machine ----------

  function toggle() {
    if (state === 'live') vanish();
    else if (state === 'vanished') reappear();
  }

  function vanish() {
    if (state !== 'live') return;
    if (!pipelines.size) return notice('noCamera');
    if (!room) return notice('needRoom');
    if (capture) return notice('capturing');
    startAnim('out');
  }

  function reappear() {
    if (state !== 'vanished') return;
    startAnim('in');
  }

  function startAnim(dir) {
    state = dir === 'out' ? 'vanishing' : 'returning';
    lastToggleAt = performance.now();
    const thanos = !!settings.thanos;
    const total = thanos ? DUST_SWEEP_SEC + DUST_LIFE_MAX : FADE_SEC;
    anim = { dir, thanos, start: null, fx: null, total };
    // If no frames arrive (camera paused), still settle the state.
    const a = anim;
    setTimeout(() => {
      if (anim === a) finishAnim();
    }, total * 1000 + 1500);
    emitStatus();
  }

  function finishAnim() {
    if (!anim) return;
    state = anim.dir === 'out' ? 'vanished' : 'live';
    anim = null;
    emitStatus();
  }

  // ---------- room snapshot ----------

  function dataUrlToBlob(url) {
    const [head, b64] = url.split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  async function setRoomFromUrl(url) {
    if (room && room.url === url) return;
    const version = ++roomVersion;
    if (!url) {
      room = null;
      if (state !== 'live') {
        anim = null;
        state = 'live';
      }
      emitStatus();
      return;
    }
    try {
      // Decoding from a Blob avoids the call site's CSP for data: URLs.
      const bitmap = await createImageBitmap(dataUrlToBlob(url));
      if (version !== roomVersion) return;
      room = { bitmap, url };
    } catch (err) {
      reportError(err);
      room = null;
    }
    emitStatus();
  }

  function startCapture(opts) {
    if (!pipelines.size) return notice('noCamera');
    if (capture) return;
    anim = null;
    if (state !== 'live') state = 'live';
    capture = {
      phase: 'leave',
      start: performance.now(),
      leaveMs: opts.leaveMs ?? 5000,
      holdMs: opts.holdMs ?? 3000,
      lastSample: 0,
      acc: null,
      w: 0,
      h: 0,
      n: 0,
      canvas: null,
      lastSecond: -1,
    };
    capture.timer = setInterval(tickCapture, 100);
    tickCapture();
    emitStatus();
  }

  function tickCapture() {
    const c = capture;
    if (!c) return;
    const t = performance.now() - c.start;
    let phase, left;
    if (t < c.leaveMs) {
      phase = 'leave';
      left = c.leaveMs - t;
    } else if (t < c.leaveMs + c.holdMs) {
      phase = 'hold';
      left = c.leaveMs + c.holdMs - t;
    } else {
      endCapture(true);
      return;
    }
    if (phase !== c.phase) {
      c.phase = phase;
      beep([880]);
      emitStatus();
    }
    const seconds = Math.ceil(left / 1000);
    if (seconds !== c.lastSecond) {
      c.lastSecond = seconds;
      post('capture', { phase, seconds });
    }
    if (!pipelines.size) endCapture(false);
  }

  function sampleCapture(frame, w, h) {
    const c = capture;
    const now = performance.now();
    if (c.phase !== 'hold' || now - c.lastSample < 200) return;
    c.lastSample = now;
    if (!c.acc || c.w !== w || c.h !== h) {
      c.w = w;
      c.h = h;
      c.n = 0;
      c.acc = new Uint32Array(w * h * 4);
      c.canvas = new OffscreenCanvas(w, h);
      c.ctx = c.canvas.getContext('2d', { willReadFrequently: true });
    }
    c.ctx.drawImage(frame, 0, 0, w, h);
    const px = c.ctx.getImageData(0, 0, w, h).data;
    const acc = c.acc;
    for (let i = 0; i < px.length; i++) acc[i] += px[i];
    c.n++;
  }

  async function endCapture(ok) {
    const c = capture;
    if (!c) return;
    capture = null;
    clearInterval(c.timer);
    if (!ok) {
      emitStatus();
      return;
    }
    if (!c.n) {
      notice('captureFailed');
      emitStatus();
      return;
    }
    try {
      const img = c.ctx.createImageData(c.w, c.h);
      for (let i = 0; i < c.acc.length; i++) img.data[i] = Math.round(c.acc[i] / c.n);
      c.ctx.putImageData(img, 0, 0);
      const blob = await c.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      const url = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      const bitmap = await createImageBitmap(c.canvas);
      roomVersion++;
      room = { bitmap, url };
      post('roomCaptured', { dataUrl: url });
      post('capture', { phase: 'done', seconds: 0 });
      beep([660, 990]);
    } catch (err) {
      reportError(err);
      notice('captureFailed');
    }
    emitStatus();
  }

  let beepCtx = null;
  function beep(freqs) {
    try {
      beepCtx ||= new AudioContext();
      if (beepCtx.state === 'suspended') beepCtx.resume();
      let t = beepCtx.currentTime + 0.02;
      for (const f of freqs) {
        const osc = beepCtx.createOscillator();
        const g = beepCtx.createGain();
        osc.frequency.value = f;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.15, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        osc.connect(g).connect(beepCtx.destination);
        osc.start(t);
        osc.stop(t + 0.16);
        t += 0.18;
      }
    } catch {}
  }

  // ---------- compositor ----------

  // Per-resolution drawing surfaces, cached on the pipeline.
  function getSurface(p, w, h) {
    let s = p.surface;
    if (!s || s.w !== w || s.h !== h) {
      const cell = Math.max(4, Math.round(Math.max(w, h) / 160));
      const gw = Math.ceil(w / cell);
      const gh = Math.ceil(h / cell);
      const canvas = new OffscreenCanvas(w, h);
      const grid = new OffscreenCanvas(gw, gh);
      const mask = new OffscreenCanvas(gw, gh);
      const layer = new OffscreenCanvas(w, h);
      const maskCtx = mask.getContext('2d');
      s = p.surface = {
        w,
        h,
        cell,
        gw,
        gh,
        canvas,
        ctx: canvas.getContext('2d', { alpha: false }),
        grid,
        gridCtx: grid.getContext('2d', { willReadFrequently: true }),
        mask,
        maskCtx,
        maskData: maskCtx.createImageData(gw, gh),
        layer,
        layerCtx: layer.getContext('2d'),
        roomFor: -1,
        roomLayer: new OffscreenCanvas(w, h),
        roomGrid: null,
      };
    }
    if (s.roomFor !== roomVersion && room) {
      const rc = s.roomLayer.getContext('2d');
      const b = room.bitmap;
      const scale = Math.max(w / b.width, h / b.height);
      const dw = b.width * scale;
      const dh = b.height * scale;
      rc.drawImage(b, (w - dw) / 2, (h - dh) / 2, dw, dh);
      s.gridCtx.drawImage(s.roomLayer, 0, 0, s.gw, s.gh);
      s.roomGrid = s.gridCtx.getImageData(0, 0, s.gw, s.gh).data;
      s.roomFor = roomVersion;
    }
    return s;
  }

  function processFrame(frame, p) {
    debug.frames++;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (capture) sampleCapture(frame, w, h);
    if ((state === 'live' && !anim) || !room) return frame;

    const s = getSurface(p, w, h);
    const init = { timestamp: frame.timestamp };
    if (frame.duration != null) init.duration = frame.duration;

    if (state === 'vanished') {
      const out = new VideoFrame(s.roomLayer, init);
      frame.close();
      return out;
    }

    const now = performance.now();
    if (anim.start == null) anim.start = now;
    const t = (now - anim.start) / 1000;
    const ctx = s.ctx;
    ctx.drawImage(frame, 0, 0, w, h);

    if (!anim.thanos) {
      const k = Math.min(1, t / FADE_SEC);
      const e = k * k * (3 - 2 * k);
      ctx.globalAlpha = anim.dir === 'out' ? e : 1 - e;
      ctx.drawImage(s.roomLayer, 0, 0);
      ctx.globalAlpha = 1;
    } else {
      if (!anim.fx || anim.fx.w !== w || anim.fx.h !== h) anim.fx = buildDust(frame, s);
      renderDust(s, anim.fx, anim.dir, t);
    }

    const out = new VideoFrame(s.canvas, init);
    frame.close();
    if (t >= anim.total) finishAnim();
    return out;
  }

  // Cheap smooth noise for clumpy dissolve fronts.
  function hash(x, y) {
    let n = (x * 374761393 + y * 668265263) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }

  function valueNoise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  function median(values) {
    const a = Float32Array.from(values).sort();
    return a.length ? a[a.length >> 1] : 0;
  }

  // Grid cells (gw x gh) where the live frame differs from the empty room,
  // i.e. where the person is.
  function personMask(cur, bg, gw, gh) {
    const n = gw * gh;

    // The camera re-adjusts exposure and white balance when you step back
    // in, which shifts the colour of the whole frame. Most of the frame is
    // still background, so the median per-channel ratio is that shift.
    const gain = [0, 1, 2].map((c) => {
      const r = [];
      for (let i = 0; i < n; i++) if (bg[i * 4 + c] > 12) r.push(cur[i * 4 + c] / bg[i * 4 + c]);
      const m = median(r);
      return m > 0.4 && m < 2.5 ? m : 1;
    });

    const diff = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      diff[i] =
        (Math.abs(cur[o] - bg[o] * gain[0]) +
          Math.abs(cur[o + 1] - bg[o + 1] * gain[1]) +
          Math.abs(cur[o + 2] - bg[o + 2] * gain[2])) /
        3;
    }
    // Threshold well above the background's own noise (its median diff).
    const thr = Math.max(14, median(diff) * 3 + 6);
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = diff[i] > thr ? 1 : 0;

    // Close small gaps: grow by one cell, then keep cells with a full
    // neighbourhood of grown cells (erode).
    const grown = dilate(raw, gw, gh);
    const closed = new Uint8Array(n);
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        let all = 1;
        for (let dy = -1; dy <= 1 && all; dy++)
          for (let dx = -1; dx <= 1 && all; dx++) {
            const xx = Math.min(gw - 1, Math.max(0, x + dx));
            const yy = Math.min(gh - 1, Math.max(0, y + dy));
            all = grown[yy * gw + xx];
          }
        closed[y * gw + x] = all;
      }

    // Keep big blobs only (a person, not noise or a flickering screen).
    const label = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    const blobs = [];
    for (let i = 0; i < n; i++) {
      if (!closed[i] || label[i] >= 0) continue;
      const id = blobs.length;
      let head = 0;
      let tail = 0;
      queue[tail++] = i;
      label[i] = id;
      while (head < tail) {
        const j = queue[head++];
        const x = j % gw;
        const y = (j / gw) | 0;
        const nbs = [x > 0 ? j - 1 : -1, x < gw - 1 ? j + 1 : -1, y > 0 ? j - gw : -1, y < gh - 1 ? j + gw : -1];
        for (const q of nbs)
          if (q >= 0 && closed[q] && label[q] < 0) {
            label[q] = id;
            queue[tail++] = q;
          }
      }
      blobs.push(tail);
    }
    const biggest = Math.max(0, ...blobs);
    const keep = blobs.map((size) => size >= n * 0.015 || size === biggest);
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = label[i] >= 0 && keep[label[i]] && biggest >= n * 0.004 ? 1 : 0;

    // Fill holes: background is whatever is reachable from the frame edge
    // without crossing the person.
    const outside = new Uint8Array(n);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < n; i++) {
      const x = i % gw;
      const y = (i / gw) | 0;
      if ((x === 0 || y === 0 || x === gw - 1 || y === gh - 1) && !mask[i]) {
        outside[i] = 1;
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const j = queue[head++];
      const x = j % gw;
      const y = (j / gw) | 0;
      const nbs = [x > 0 ? j - 1 : -1, x < gw - 1 ? j + 1 : -1, y > 0 ? j - gw : -1, y < gh - 1 ? j + gw : -1];
      for (const q of nbs)
        if (q >= 0 && !mask[q] && !outside[q]) {
          outside[q] = 1;
          queue[tail++] = q;
        }
    }
    for (let i = 0; i < n; i++) if (!outside[i]) mask[i] = 1;
    return dilate(mask, gw, gh);
  }

  function dilate(src, gw, gh) {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        let on = 0;
        for (let dy = -1; dy <= 1 && !on; dy++)
          for (let dx = -1; dx <= 1 && !on; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && src[yy * gw + xx]) on = 1;
          }
        out[y * gw + x] = on;
      }
    return out;
  }

  // Typical webcam framing: head and shoulders, centred, touching the bottom.
  function inFraming(x, y, gw, gh, widen = 1) {
    const nx = (x / gw - 0.5) / (0.3 * widen);
    const ny = (y / gh - 0.8) / (0.65 * widen);
    return nx * nx + ny * ny < 1;
  }

  // Person mask, then one particle (or more) per person cell.
  function buildDust(frame, s) {
    const { gw, gh, cell, w, h } = s;
    s.gridCtx.drawImage(frame, 0, 0, gw, gh);
    const cur = s.gridCtx.getImageData(0, 0, gw, gh).data;
    const n = gw * gh;
    const person = personMask(cur, s.roomGrid, gw, gh);
    let count = person.reduce((a, b) => a + b, 0);

    // Nothing differs from the room: assume the usual framing. Almost
    // everything differs (camera moved, lights changed): trust only the
    // part of the change that sits where a person usually is.
    if (count < n * 0.005 || count > n * 0.7) {
      const widen = count < n * 0.005 ? 1 : 1.4;
      const fallback = count < n * 0.005;
      count = 0;
      for (let y = 0; y < gh; y++)
        for (let x = 0; x < gw; x++) {
          const i = y * gw + x;
          const on = inFraming(x, y, gw, gh, widen) && (fallback || person[i]) ? 1 : 0;
          person[i] = on;
          count += on;
        }
    }

    // Dissolve time per person cell: a sweep across the person from
    // bottom-left to top-right, broken up by clumpy noise so it crumbles in
    // patches.
    let x0 = gw;
    let x1 = 0;
    let y0 = gh;
    let y1 = 0;
    for (let i = 0; i < n; i++)
      if (person[i]) {
        const x = i % gw;
        const y = (i / gw) | 0;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    const bw = Math.max(1, x1 - x0);
    const bh = Math.max(1, y1 - y0);
    const td = new Float32Array(n);
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        const sweep = 0.6 * ((x - x0) / bw) + 0.4 * (1 - (y - y0) / bh);
        const clump = valueNoise(x / 7, y / 7);
        const fine = hash(x + 911, y + 37);
        td[y * gw + x] = DUST_SWEEP_SEC * Math.min(1, Math.max(0, 0.55 * sweep + 0.3 * clump + 0.15 * fine));
      }

    const MAX = 7000;
    const per = Math.min(2, MAX / Math.max(1, count));
    const est = Math.ceil(count * Math.max(per, 1)) + 8;
    const P = {
      x0: new Float32Array(est),
      y0: new Float32Array(est),
      vx: new Float32Array(est),
      vy: new Float32Array(est),
      ax: new Float32Array(est),
      ay: new Float32Array(est),
      ph: new Float32Array(est),
      life: new Float32Array(est),
      size: new Float32Array(est),
      td: new Float32Array(est),
      rgb: new Array(est),
      ash: new Array(est),
      n: 0,
    };
    const scale = w / 640;
    let k = 0;
    for (let i = 0; i < n && k < est; i++) {
      if (!person[i]) continue;
      let spawn = Math.floor(per) + (Math.random() < per % 1 ? 1 : 0);
      const cx = (i % gw) * cell;
      const cy = Math.floor(i / gw) * cell;
      const o = i * 4;
      while (spawn-- > 0 && k < est) {
        P.x0[k] = cx + Math.random() * cell;
        P.y0[k] = cy + Math.random() * cell;
        P.vx[k] = (30 + Math.random() * 110) * scale;
        P.vy[k] = (-15 - Math.random() * 70) * scale;
        P.ax[k] = (20 + Math.random() * 70) * scale;
        P.ay[k] = (-10 - Math.random() * 40) * scale;
        P.ph[k] = Math.random() * 6.28;
        P.life[k] = 0.9 + Math.random() * (DUST_LIFE_MAX - 0.9);
        P.size[k] = cell * (0.45 + Math.random() * 0.6);
        P.td[k] = td[i];
        const r = cur[o];
        const g = cur[o + 1];
        const b = cur[o + 2];
        P.rgb[k] = `rgb(${r},${g},${b})`;
        // Fade toward ashy brown-grey as the particle ages.
        P.ash[k] = `rgb(${(r * 0.35 + 88 * 0.65) | 0},${(g * 0.35 + 76 * 0.65) | 0},${(b * 0.35 + 66 * 0.65) | 0})`;
        k++;
      }
    }
    P.n = k;
    return { w, h, td, person, P };
  }

  const smoothstep = (a, b, x) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };

  // Only the person crumbles:
  // "out": person cell i shows the room once t >= td[i] and its particles
  //        fly off; the background crossfades to the snapshot smoothly.
  // "in":  the same film played backwards (particles fly in, cells land).
  function renderDust(s, fx, dir, t) {
    const { gw, gh, w, h, ctx, maskCtx, maskData } = s;
    const alpha = maskData.data;
    const n = gw * gh;
    const { td, person } = fx;
    const bg =
      dir === 'out'
        ? smoothstep(0, DUST_SWEEP_SEC, t)
        : 1 - smoothstep(DUST_LIFE_MAX * 0.5, DUST_SWEEP_SEC + DUST_LIFE_MAX, t);
    const bgAlpha = Math.round(bg * 255);
    for (let i = 0; i < n; i++) {
      if (!person[i]) {
        alpha[i * 4 + 3] = bgAlpha;
        continue;
      }
      const showsRoom = dir === 'out' ? t >= td[i] : t < td[i] + DUST_LIFE_MAX;
      alpha[i * 4 + 3] = showsRoom ? 255 : 0;
    }
    maskCtx.putImageData(maskData, 0, 0);
    const lc = s.layerCtx;
    lc.globalCompositeOperation = 'copy';
    lc.drawImage(s.roomLayer, 0, 0);
    lc.globalCompositeOperation = 'destination-in';
    lc.imageSmoothingEnabled = false;
    lc.drawImage(s.mask, 0, 0, w, h);
    lc.globalCompositeOperation = 'source-over';
    ctx.drawImage(s.layer, 0, 0);

    const P = fx.P;
    for (let k = 0; k < P.n; k++) {
      const age = dir === 'out' ? t - P.td[k] : P.td[k] + DUST_LIFE_MAX - t;
      const life = P.life[k];
      if (age < 0 || age > life) continue;
      const q = age / life;
      const x = P.x0[k] + P.vx[k] * age + 0.5 * P.ax[k] * age * age + Math.sin(age * 9 + P.ph[k]) * 2;
      const y = P.y0[k] + P.vy[k] * age + 0.5 * P.ay[k] * age * age;
      if (x > w || y < -8) continue;
      const size = P.size[k] * (1 - 0.6 * q);
      ctx.globalAlpha = Math.pow(1 - q, 1.3);
      ctx.fillStyle = q < 0.35 ? P.rgb[k] : P.ash[k];
      ctx.fillRect(x, y, size, size);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- getUserMedia wrapper ----------

  function reportError(err) {
    debug.errors++;
    debug.lastError = String((err && err.stack) || err);
    console.warn('[Thanos Snap]', err);
  }

  function wrapTrack(src) {
    const processor = new MediaStreamTrackProcessor({ track: src });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const p = { src, generator, surface: null };

    const transformer = new TransformStream({
      transform(frame, controller) {
        let out = frame;
        try {
          out = processFrame(frame, p);
        } catch (err) {
          reportError(err);
        }
        controller.enqueue(out);
      },
    });
    processor.readable
      .pipeThrough(transformer)
      .pipeTo(generator.writable)
      .catch(() => {})
      .finally(() => endPipeline(p));

    // Make the generated track behave like the camera track it replaces.
    const define = (name, value) =>
      Object.defineProperty(generator, name, { value, configurable: true, writable: true });
    const genStop = generator.stop.bind(generator);
    define('stop', () => {
      genStop();
      src.stop();
      endPipeline(p);
    });
    for (const m of ['getSettings', 'getConstraints', 'getCapabilities']) define(m, () => src[m]());
    define('applyConstraints', (c) => src.applyConstraints(c));
    Object.defineProperty(generator, 'label', { get: () => src.label, configurable: true });
    const enabledDesc = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');
    Object.defineProperty(generator, 'enabled', {
      configurable: true,
      get: () => enabledDesc.get.call(generator),
      set: (v) => {
        enabledDesc.set.call(generator, v);
        src.enabled = v;
      },
    });
    try {
      generator.contentHint = src.contentHint;
    } catch {}
    src.addEventListener('ended', () => endPipeline(p));

    pipelines.add(p);
    emitStatus();
    syncDetector();
    return generator;
  }

  function endPipeline(p) {
    if (!pipelines.delete(p)) return;
    if (!pipelines.size) {
      if (anim) finishAnim();
      if (capture) endCapture(false);
    }
    emitStatus();
    syncDetector();
  }

  function wrapStream(stream) {
    if (!stream.getVideoTracks().length) return stream;
    const tracks = stream.getTracks().map((t) => {
      if (t.kind !== 'video') return t;
      try {
        return wrapTrack(t);
      } catch (err) {
        reportError(err);
        return t;
      }
    });
    return new MediaStream(tracks);
  }

  if (supported) {
    const getUserMedia = async function getUserMedia(constraints) {
      const stream = await origGetUserMedia.call(this, constraints);
      return constraints && constraints.video ? wrapStream(stream) : stream;
    };
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      value: getUserMedia,
      configurable: true,
      writable: true,
    });
  }

  // ---------- snap detector ----------

  function syncDetector() {
    const want = supported && !!settings.snapEnabled && pipelines.size > 0;
    if (want && !detector) startDetector();
    else if (!want && detector) {
      endLearning(false);
      stopDetector();
    }
    else if (detector && detector.analyzer) detector.analyzer.setSensitivity(settings.sensitivity);
  }

  async function startDetector() {
    const d = (detector = { status: 'starting', stopped: false });
    emitStatus();
    try {
      const stream = await origGetUserMedia.call(navigator.mediaDevices, {
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (d.stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const ac = new AudioContext();
      const source = ac.createMediaStreamSource(stream);
      // ScriptProcessor keeps running in background tabs and needs no module
      // URL, which call sites' CSP could block for AudioWorklet.
      const sp = ac.createScriptProcessor(1024, 1, 1);
      const mute = ac.createGain();
      mute.gain.value = 0;
      const analyzer = new SnapAnalyzer(ac.sampleRate, settings.sensitivity, calibration);
      let lastLevelPost = 0;
      sp.onaudioprocess = (e) => {
        const snaps = analyzer.process(e.inputBuffer.getChannelData(0));
        const now = performance.now();
        if (now - lastLevelPost > 70) {
          lastLevelPost = now;
          post('level', { value: analyzer.takeLevel() });
        }
        for (const ev of analyzer.takeEvents()) onTransient(ev);
        if (snaps && !learning) onSnap();
      };
      source.connect(sp);
      sp.connect(mute);
      mute.connect(ac.destination);
      Object.assign(d, { stream, ac, source, sp, analyzer });

      const update = () => {
        if (d.stopped) return;
        d.status = ac.state === 'running' ? 'on' : 'waiting';
        emitStatus();
      };
      ac.onstatechange = update;
      if (ac.state !== 'running') {
        ac.resume().catch(() => {});
        // Autoplay policy: resume on the next interaction with the page.
        const resume = () => ac.resume().catch(() => {});
        window.addEventListener('pointerdown', resume, { capture: true, once: true });
        window.addEventListener('keydown', resume, { capture: true, once: true });
      }
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (detector === d) {
          stopDetector();
          notice('micError');
        }
      });
      update();
    } catch (err) {
      reportError(err);
      if (detector === d) detector = null;
      notice('micError');
      emitStatus();
    }
  }

  function stopDetector() {
    const d = detector;
    if (!d) return;
    detector = null;
    d.stopped = true;
    try {
      d.sp && (d.sp.onaudioprocess = null);
      d.source && d.source.disconnect();
      d.stream && d.stream.getTracks().forEach((t) => t.stop());
      d.ac && d.ac.close();
    } catch {}
    emitStatus();
  }

  // Every sharp sound, judged: lets the popup say why a snap didn't count.
  function onTransient(ev) {
    if (learning) {
      if (ev.snr < 4) return;
      learning.samples.push(ev);
      post('learn', { phase: 'listening', count: learning.samples.length });
      if (learning.samples.length >= 3) endLearning(true);
      return;
    }
    post('transient', { verdict: ev.verdict, db: Math.round(10 * Math.log10(ev.snr)) });
  }

  function startLearning() {
    if (!detector || detector.status !== 'on') return notice('learnNeedsMic');
    endLearning(false);
    learning = { samples: [], timer: setTimeout(() => endLearning(true), 10000) };
    post('learn', { phase: 'listening', count: 0 });
    emitStatus();
  }

  function endLearning(finish) {
    const l = learning;
    if (!l) return;
    learning = null;
    clearTimeout(l.timer);
    if (finish) {
      const cal = SnapAnalyzer.calibrate(l.samples);
      if (cal) {
        calibration = cal;
        if (detector && detector.analyzer) detector.analyzer.configure(0.5, cal);
        post('calibrated', { value: cal });
        post('learn', { phase: 'done', count: l.samples.length });
      } else {
        post('learn', { phase: 'failed', count: l.samples.length });
      }
    } else {
      post('learn', { phase: 'cancelled', count: l.samples.length });
    }
    emitStatus();
  }

  function onSnap() {
    const now = performance.now();
    post('snap', {});
    if (settings.doubleSnap) {
      if (now - lastSnapAt > 1200) {
        lastSnapAt = now;
        return;
      }
      lastSnapAt = 0;
    }
    if (now - lastToggleAt < 1000) return;
    toggle();
  }

  debug.personMask = personMask;

  post('ready', { supported });
  emitStatus();
})();
