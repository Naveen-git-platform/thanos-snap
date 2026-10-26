// Thanos Snap engine. Runs in the call page's MAIN world (and directly in
// test/test.html). Wraps getUserMedia so the camera track the call receives
// passes through the compositor (src/compositor.js, run in a Worker), which
// can swap you for the empty room. This file is the controller: state,
// room snapshot, snap detector and hand-gesture trigger.
//
// Talks to bridge.js (or the test page) with window.postMessage:
//   in:  { __thanosSnap: 'to-engine',   type, payload }
//   out: { __thanosSnap: 'from-engine', type, payload }
(() => {
  'use strict';

  const NS = '__thanosSnap';
  if (window[NS + 'Engine']) return;

  const SnapAnalyzer = window.ThanosSnapAnalyzer;
  const compositorFn = window.__thanosSnapCompositor;
  try {
    delete window.ThanosSnapAnalyzer;
    delete window.__thanosSnapCompositor;
  } catch {}

  const md = navigator.mediaDevices;
  const origGetUserMedia = md && md.getUserMedia ? MediaDevices.prototype.getUserMedia : null;
  const supported = !!(
    origGetUserMedia &&
    compositorFn &&
    window.MediaStreamTrackProcessor &&
    window.MediaStreamTrackGenerator &&
    window.OffscreenCanvas &&
    window.VideoFrame
  );

  const debug = { errors: 0, lastError: null, frames: 0, workers: 0, inline: 0 };
  Object.defineProperty(window, NS + 'Engine', {
    value: Object.freeze({
      debug,
      originalGetUserMedia: (c) => origGetUserMedia.call(navigator.mediaDevices, c),
    }),
  });

  const ANIM_SAFETY_MS = { thanos: 4500, fade: 1500 };
  const GESTURE_INTERVAL_MS = 100; // up to 10 recognitions per second
  const GESTURE_HOLD_MS = 200; // gesture must be held this long to count
  const GESTURE_REARM_MS = 600; // and dropped this long before it counts again
  const GESTURE_MIN_SCORE = 0.55;

  const settings = {
    thanos: true,
    snapEnabled: false,
    sensitivity: 0.5,
    doubleSnap: false,
    gestureEnabled: true,
    gesture: 'Victory',
  };
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
  const gesture = { running: false, status: 'off', heldSince: 0, lastSeen: 0, armed: true, fails: 0 };

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
      micFiltered: !!(detector && detector.filtered),
      capture: capture ? capture.phase : null,
      calibrated: !!calibration,
      learning: !!learning,
      gesture: gesture.status,
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
        syncGesture();
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
      case 'gestureResult':
        resolveRecognition(p);
        break;
    }
  });

  function toCompositors(msg) {
    for (const p of pipelines) p.port.postMessage(msg);
  }

  function newestPipeline() {
    let last = null;
    for (const p of pipelines) last = p;
    return last;
  }

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
    anim = { dir };
    toCompositors({ type: 'anim', dir, thanos });
    // If no frames arrive (camera paused), still settle the state.
    const a = anim;
    setTimeout(() => {
      if (anim === a) finishAnim();
    }, thanos ? ANIM_SAFETY_MS.thanos : ANIM_SAFETY_MS.fade);
    emitStatus();
  }

  function finishAnim() {
    if (!anim) return;
    state = anim.dir === 'out' ? 'vanished' : 'live';
    anim = null;
    toCompositors({ type: 'mode', mode: state });
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

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function useRoom(bitmap, url) {
    roomVersion++;
    room = bitmap ? { bitmap, url } : null;
    toCompositors({ type: 'room', bitmap });
    if (!room && state !== 'live') {
      anim = null;
      state = 'live';
    }
  }

  async function setRoomFromUrl(url) {
    if ((room && room.url === url) || (!room && !url)) return;
    const version = ++roomVersion;
    if (!url) {
      useRoom(null, null);
      emitStatus();
      return;
    }
    try {
      // Decoding from a Blob avoids the call site's CSP for data: URLs.
      const bitmap = await createImageBitmap(dataUrlToBlob(url));
      if (version !== roomVersion) return;
      useRoom(bitmap, url);
    } catch (err) {
      reportError(err);
    }
    emitStatus();
  }

  function startCapture(opts) {
    if (!pipelines.size) return notice('noCamera');
    if (capture) return;
    if (state !== 'live') {
      anim = null;
      state = 'live';
      toCompositors({ type: 'mode', mode: 'live' });
    }
    capture = {
      phase: 'leave',
      start: performance.now(),
      leaveMs: opts.leaveMs ?? 5000,
      holdMs: opts.holdMs ?? 3000,
      lastSecond: -1,
      pipeline: newestPipeline(),
    };
    capture.timer = setInterval(tickCapture, 100);
    tickCapture();
    emitStatus();
  }

  function tickCapture() {
    const c = capture;
    if (!c) return;
    if (!pipelines.has(c.pipeline)) return endCapture(false);
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
      c.pipeline.port.postMessage({ type: 'captureStart' });
      beep([880]);
      emitStatus();
    }
    const seconds = Math.ceil(left / 1000);
    if (seconds !== c.lastSecond) {
      c.lastSecond = seconds;
      post('capture', { phase, seconds });
    }
  }

  function endCapture(ok) {
    const c = capture;
    if (!c) return;
    capture = null;
    clearInterval(c.timer);
    if (!ok) {
      if (pipelines.has(c.pipeline)) c.pipeline.port.postMessage({ type: 'captureCancel' });
      emitStatus();
      return;
    }
    c.pipeline.port.postMessage({ type: 'captureEnd' });
    c.pipeline.onCaptured = async (m) => {
      if (!m.ok) {
        if (m.error) reportError(m.error);
        notice('captureFailed');
        emitStatus();
        return;
      }
      try {
        const url = await blobToDataUrl(m.blob);
        useRoom(m.bitmap, url);
        post('roomCaptured', { dataUrl: url });
        post('capture', { phase: 'done', seconds: 0 });
        beep([660, 990]);
      } catch (err) {
        reportError(err);
        notice('captureFailed');
      }
      emitStatus();
    };
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

  // ---------- compositor (Worker, or inline fallback) ----------

  let workerAllowed = null; // unknown until the first try
  let workerUrl = null;
  let ttPolicy = null;

  function makeWorker() {
    workerUrl ||= URL.createObjectURL(
      new Blob([`(${compositorFn.toString()})(self);`], { type: 'text/javascript' }),
    );
    let url = workerUrl;
    // Sites enforcing Trusted Types need a policy for the worker URL.
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      try {
        ttPolicy ||= window.trustedTypes.createPolicy('thanos-snap', { createScriptURL: (s) => s });
        url = ttPolicy.createScriptURL(url);
      } catch {}
    }
    return new Worker(url);
  }

  async function createCompositor() {
    if (workerAllowed !== false) {
      try {
        const worker = makeWorker();
        const ok = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 2000);
          worker.onmessage = (e) => {
            if (e.data && e.data.type === 'pong') {
              clearTimeout(timer);
              resolve(true);
            }
          };
          worker.onerror = () => {
            clearTimeout(timer);
            resolve(false);
          };
          worker.postMessage({ type: 'ping' });
        });
        if (ok) {
          workerAllowed = true;
          debug.workers++;
          return { port: worker, worker, api: null };
        }
        worker.terminate();
      } catch {}
      workerAllowed = false;
    }
    // The site's CSP blocks blob workers: run on this thread instead.
    const channel = new MessageChannel();
    const api = compositorFn(channel.port2);
    debug.inline++;
    return { port: channel.port1, worker: null, api };
  }

  function onCompositorMessage(p, m) {
    switch (m.type) {
      case 'animDone':
        if (anim && anim.dir === m.dir) finishAnim();
        break;
      case 'captured':
        if (p.onCaptured) p.onCaptured(m);
        p.onCaptured = null;
        break;
      case 'grabbed':
        if (p.onGrab) p.onGrab(m.bitmap);
        else if (m.bitmap) m.bitmap.close();
        p.onGrab = null;
        break;
      case 'stats':
        debug.frames += m.frames;
        if (m.errors) {
          debug.errors += m.errors;
          debug.lastError = m.lastError;
        }
        break;
      case 'ended':
        endPipeline(p);
        break;
    }
  }

  // ---------- getUserMedia wrapper ----------

  function reportError(err) {
    debug.errors++;
    debug.lastError = String((err && err.stack) || err);
    console.warn('[Thanos Snap]', err);
  }

  async function wrapTrack(src) {
    const comp = await createCompositor();
    // A short queue: under load, drop stale frames instead of lagging.
    const processor = new MediaStreamTrackProcessor({ track: src, maxBufferSize: 2 });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const p = { src, generator, port: comp.port, worker: comp.worker, onGrab: null, onCaptured: null };
    comp.port.onmessage = (e) => onCompositorMessage(p, e.data || {});

    if (comp.api) comp.api.attach(processor.readable, generator.writable);
    else {
      const { readable } = processor;
      const { writable } = generator;
      comp.port.postMessage({ type: 'stream', readable, writable }, [readable, writable]);
    }
    if (room) comp.port.postMessage({ type: 'room', bitmap: room.bitmap });
    comp.port.postMessage({ type: 'mode', mode: state === 'vanished' || state === 'vanishing' ? 'vanished' : 'live' });

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
    syncGesture();
    return generator;
  }

  function endPipeline(p) {
    if (!pipelines.delete(p)) return;
    if (p.worker) setTimeout(() => p.worker.terminate(), 500);
    if (p.onGrab) p.onGrab(null);
    if (!pipelines.size) {
      if (anim) finishAnim();
      if (capture) endCapture(false);
    }
    emitStatus();
    syncDetector();
    syncGesture();
  }

  async function wrapStream(stream) {
    if (!stream.getVideoTracks().length) return stream;
    const tracks = await Promise.all(
      stream.getTracks().map(async (t) => {
        if (t.kind !== 'video') return t;
        try {
          return await wrapTrack(t);
        } catch (err) {
          reportError(err);
          return t;
        }
      }),
    );
    return new MediaStream(tracks);
  }
  debug.wrapStream = wrapStream;

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

  // ---------- hand gesture ----------
  // Small raw frames go to the recogniser (an offscreen extension page, via
  // bridge.js) about 10 times a second. Holding the chosen gesture toggles
  // vanish/return once; drop the hand and show it again to toggle back.

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let recognitionId = 0;
  const recognitions = new Map();

  function syncGesture() {
    const want = supported && !!settings.gestureEnabled && pipelines.size > 0;
    if (want && !gesture.running) runGestureLoop();
    if (!want && gesture.status !== 'off') {
      gesture.status = 'off';
      emitStatus();
    }
  }

  function grabFrame(p) {
    return new Promise((resolve) => {
      if (p.onGrab) p.onGrab(null);
      p.onGrab = resolve;
      p.port.postMessage({ type: 'grab', width: 480 });
      setTimeout(() => {
        if (p.onGrab === resolve) {
          p.onGrab = null;
          resolve(null);
        }
      }, 1000);
    });
  }

  function recognize(bitmap, timeoutMs) {
    const id = ++recognitionId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        recognitions.delete(id);
        resolve({ error: 'timeout' });
      }, timeoutMs);
      recognitions.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      // Copied, not transferred: the bridge receives it in another JS world.
      post('gestureFrame', { id, bitmap });
      bitmap.close();
    });
  }

  function resolveRecognition(p) {
    const done = recognitions.get(p.id);
    if (!done) return;
    recognitions.delete(p.id);
    done(p);
  }

  async function runGestureLoop() {
    gesture.running = true;
    gesture.status = 'loading';
    gesture.fails = 0;
    emitStatus();
    try {
      while (settings.gestureEnabled && pipelines.size) {
        const t0 = performance.now();
        const p = newestPipeline();
        if (!p) break;
        const bitmap = await grabFrame(p);
        if (bitmap) {
          // The first call loads the model, which can take a few seconds.
          const res = await recognize(bitmap, gesture.status === 'on' ? 3000 : 20000);
          if (res.error) {
            gesture.fails++;
            if (gesture.fails >= 3 && gesture.status !== 'error') {
              gesture.status = 'error';
              debug.gestureError = res.error;
              emitStatus();
            }
            await sleep(Math.min(5000, 500 * gesture.fails));
            continue;
          }
          gesture.fails = 0;
          onGestureResult(res.result || { hands: [] });
        }
        const wait = GESTURE_INTERVAL_MS - (performance.now() - t0);
        if (wait > 0) await sleep(wait);
      }
    } finally {
      gesture.running = false;
      gesture.status = 'off';
      gesture.heldSince = 0;
      emitStatus();
    }
  }

  function onGestureResult(result) {
    const now = performance.now();
    if (gesture.status !== 'on') {
      gesture.status = 'on';
      emitStatus();
    }
    const hands = result.hands || [];
    const hit = hands.some((h) => h.gesture === settings.gesture && h.score >= GESTURE_MIN_SCORE);
    if (hit) {
      gesture.lastSeen = now;
      if (!gesture.heldSince) gesture.heldSince = now;
      if (gesture.armed && now - gesture.heldSince >= GESTURE_HOLD_MS) {
        gesture.armed = false;
        if (!learning && !capture) toggle();
      }
    } else {
      gesture.heldSince = 0;
      if (!gesture.armed && now - gesture.lastSeen >= GESTURE_REARM_MS) gesture.armed = true;
    }
    post('gesture', { seen: hit, top: hands[0] ? hands[0].gesture : 'None' });
  }

  // ---------- snap detector ----------

  function syncDetector() {
    const want = supported && !!settings.snapEnabled && pipelines.size > 0;
    if (want && !detector) startDetector();
    else if (!want && detector) {
      endLearning(false);
      stopDetector();
    } else if (detector && detector.analyzer) detector.analyzer.setSensitivity(settings.sensitivity);
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
      // Noise suppression and echo cancellation remove clicks like snaps.
      // We ask for them off; report it if the browser kept them on anyway.
      const mic = stream.getAudioTracks()[0].getSettings();
      d.filtered = !!(mic.noiseSuppression || mic.echoCancellation);
      const ac = new AudioContext({ latencyHint: 'interactive' });
      const source = ac.createMediaStreamSource(stream);
      // ScriptProcessor keeps running in background tabs and needs no module
      // URL, which call sites' CSP could block for AudioWorklet. 512 samples
      // (~11 ms) keeps the reaction quick.
      const sp = ac.createScriptProcessor(512, 1, 1);
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

  if (compositorFn) debug.personMask = (...args) => compositorFn({ postMessage() {} }).personMask(...args);

  post('ready', { supported });
  emitStatus();
})();
