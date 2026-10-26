// Thanos Snap compositor: everything that touches camera frames.
//
// engine.js runs this function inside a Worker (built from its source), so
// per-frame work never competes with the call site's busy main thread. If
// the site forbids workers, engine.js runs it inline with a MessageChannel.
// It must stay self-contained: no references to anything outside itself.
//
// Messages in (scope.onmessage):
//   stream {readable, writable}   frames to process (worker mode)
//   room {bitmap|null}            empty-room snapshot
//   mode {mode: live|vanished}    steady state
//   anim {dir: out|in, thanos}    start a transition
//   captureStart / captureEnd / captureCancel
//   grab {width}                  send the next raw frame, downscaled
// Messages out: animDone, captured, grabbed, stats, ended, pong
window.__thanosSnapCompositor = function thanosSnapCompositor(scope) {
  'use strict';

  const FADE_SEC = 0.5;
  const DUST_SWEEP_SEC = 1.3; // time for the dissolve to cross the person
  const DUST_LIFE_MAX = 1.2; // longest particle flight
  const MAX_PARTICLES = 6000;

  let mode = 'live';
  let anim = null;
  let room = null;
  let roomVersion = 0;
  let surface = null;
  let capture = null;
  let grabWidth = 0;
  let frames = 0;
  let errors = 0;
  let lastError = null;

  const send = (msg, transfer) => scope.postMessage(msg, transfer || []);

  scope.onmessage = (e) => {
    const m = e.data || {};
    switch (m.type) {
      case 'ping':
        send({ type: 'pong' });
        break;
      case 'stream':
        attach(m.readable, m.writable);
        break;
      case 'room':
        if (room && room.close) room.close();
        room = m.bitmap || null;
        roomVersion++;
        if (!room) {
          mode = 'live';
          anim = null;
        }
        break;
      case 'mode':
        mode = m.mode;
        anim = null;
        break;
      case 'anim':
        anim = {
          dir: m.dir,
          thanos: !!m.thanos,
          start: null,
          fx: null,
          total: m.thanos ? DUST_SWEEP_SEC + DUST_LIFE_MAX : FADE_SEC,
        };
        break;
      case 'captureStart':
        capture = { lastSample: 0, acc: null, n: 0 };
        break;
      case 'captureEnd':
        // Too few frames so far (camera just started, or a slow machine):
        // keep sampling a little longer rather than fail.
        if (capture && capture.n < 3) {
          capture.pendingEnd = true;
          setTimeout(() => capture && capture.pendingEnd && finishCapture(), 3000);
        } else finishCapture();
        break;
      case 'captureCancel':
        capture = null;
        break;
      case 'grab':
        grabWidth = m.width || 480;
        break;
    }
  };

  function attach(readable, writable) {
    readable
      .pipeThrough(
        new TransformStream({
          transform(frame, controller) {
            let out = frame;
            try {
              out = processFrame(frame);
            } catch (err) {
              errors++;
              lastError = String((err && err.stack) || err);
            }
            controller.enqueue(out);
          },
        }),
      )
      .pipeTo(writable)
      .catch(() => {})
      .finally(() => send({ type: 'ended' }));
  }

  function processFrame(frame) {
    frames++;
    if (frames % 30 === 0) {
      send({ type: 'stats', frames: 30, errors, lastError });
      errors = 0;
    }
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (grabWidth) grab(frame, w, h);
    if (capture) sampleCapture(frame, w, h);
    if ((mode === 'live' && !anim) || !room) return frame;

    const s = getSurface(w, h);
    const init = { timestamp: frame.timestamp };
    if (frame.duration != null) init.duration = frame.duration;

    if (!anim) {
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
    if (t >= anim.total) {
      mode = anim.dir === 'out' ? 'vanished' : 'live';
      send({ type: 'animDone', dir: anim.dir });
      anim = null;
    }
    return out;
  }

  // Small copy of the raw camera frame for gesture recognition.
  function grab(frame, w, h) {
    const width = Math.min(grabWidth, w);
    const height = Math.round((h * width) / w);
    grabWidth = 0;
    const copy = frame.clone();
    createImageBitmap(copy, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' })
      .then((bitmap) => send({ type: 'grabbed', bitmap }, [bitmap]))
      .catch(() => send({ type: 'grabbed', bitmap: null }))
      .finally(() => copy.close());
  }

  // ---------- room capture ----------

  function sampleCapture(frame, w, h) {
    const c = capture;
    const now = performance.now();
    if (now - c.lastSample < 200) return;
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
    if (c.pendingEnd && c.n >= 3) finishCapture();
  }

  async function finishCapture() {
    const c = capture;
    capture = null;
    if (!c || !c.n) {
      send({ type: 'captured', ok: false });
      return;
    }
    try {
      const img = c.ctx.createImageData(c.w, c.h);
      for (let i = 0; i < c.acc.length; i++) img.data[i] = Math.round(c.acc[i] / c.n);
      c.ctx.putImageData(img, 0, 0);
      const blob = await c.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      const bitmap = await createImageBitmap(c.canvas);
      send({ type: 'captured', ok: true, blob, bitmap }, [bitmap]);
    } catch (err) {
      send({ type: 'captured', ok: false, error: String(err) });
    }
  }

  // ---------- drawing surfaces ----------

  function getSurface(w, h) {
    let s = surface;
    if (!s || s.w !== w || s.h !== h) {
      const cell = Math.max(4, Math.round(Math.max(w, h) / 160));
      const gw = Math.ceil(w / cell);
      const gh = Math.ceil(h / cell);
      const canvas = new OffscreenCanvas(w, h);
      const grid = new OffscreenCanvas(gw, gh);
      const mask = new OffscreenCanvas(gw, gh);
      const layer = new OffscreenCanvas(w, h);
      const maskCtx = mask.getContext('2d');
      s = surface = {
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
      const scale = Math.max(w / room.width, h / room.height);
      const dw = room.width * scale;
      const dh = room.height * scale;
      rc.drawImage(room, (w - dw) / 2, (h - dh) / 2, dw, dh);
      s.gridCtx.drawImage(s.roomLayer, 0, 0, s.gw, s.gh);
      s.roomGrid = s.gridCtx.getImageData(0, 0, s.gw, s.gh).data;
      s.roomFor = roomVersion;
    }
    return s;
  }

  // ---------- Thanos dust ----------

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
    let biggest = 0;
    for (const size of blobs) biggest = Math.max(biggest, size);
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
  function inFraming(x, y, gw, gh, widen) {
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
      const fallback = count < n * 0.005;
      const widen = fallback ? 1 : 1.4;
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

    const per = Math.min(2, MAX_PARTICLES / Math.max(1, count));
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
        P.vx[k] = (40 + Math.random() * 130) * scale;
        P.vy[k] = (-20 - Math.random() * 80) * scale;
        P.ax[k] = (30 + Math.random() * 90) * scale;
        P.ay[k] = (-15 - Math.random() * 50) * scale;
        P.ph[k] = Math.random() * 6.28;
        P.life[k] = 0.7 + Math.random() * (DUST_LIFE_MAX - 0.7);
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

  return { attach, personMask, durations: { FADE_SEC, DUST_SWEEP_SEC, DUST_LIFE_MAX } };
};
