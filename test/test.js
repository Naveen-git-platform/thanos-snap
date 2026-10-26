// Test page: plays the role of bridge.js + popup for the engine loaded in
// this page. Works as an extension page (shares settings and the room
// snapshot with your calls) and as a plain web page (in-memory storage).
// Append ?autotest to run the automated end-to-end check.
'use strict';

const NS = '__thanosSnap';
const DEFAULTS = { thanos: true, snapEnabled: false, sensitivity: 0.5, doubleSnap: false };
const ext = typeof chrome !== 'undefined' && !!chrome.storage?.local;
const $ = (id) => document.getElementById(id);
let fallback = {};
const t = (key, subs) => {
  if (ext) return chrome.i18n.getMessage(key, subs) || key;
  const m = fallback[key];
  return m ? m.message.replace(/\$[A-Z]+\$/g, () => (subs || [])[0] ?? '') : key;
};

const store = ext
  ? {
      get: (keys) => chrome.storage.local.get(keys),
      set: (obj) => chrome.storage.local.set(obj),
      remove: (key) => chrome.storage.local.remove(key),
    }
  : (() => {
      const mem = {};
      return {
        get: async () => ({ ...mem }),
        set: async (obj) => Object.assign(mem, obj),
        remove: async (key) => delete mem[key],
      };
    })();

let settings = { ...DEFAULTS };
let status = null;
let roomUrl = null;
let calibration = null;
let learnResult = null;
let streams = [];
let snapCount = 0;
let flashTimer = 0;
let noticeTimer = 0;

async function localize() {
  if (!ext) {
    try {
      fallback = await (await fetch('../_locales/en/messages.json')).json();
    } catch {}
  }
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}

function toEngine(type, payload) {
  window.postMessage({ [NS]: 'to-engine', type, payload }, '*');
}

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d[NS] !== 'from-engine') return;
  const p = d.payload || {};
  switch (d.type) {
    case 'ready':
      toEngine('settings', settings);
      toEngine('room', { dataUrl: roomUrl });
      toEngine('calibration', { value: calibration });
      break;
    case 'status':
      status = p;
      render();
      break;
    case 'roomCaptured':
      setRoom(p.dataUrl);
      store.set({ room: p.dataUrl });
      break;
    case 'capture':
      $('captureMsg').textContent =
        p.phase === 'done'
          ? t('captureDone')
          : t(p.phase === 'leave' ? 'captureLeave' : 'captureHold', [String(p.seconds)]);
      break;
    case 'level':
      $('meterFill').style.width = Math.min(100, (p.value / 1.5) * 100) + '%';
      break;
    case 'snap':
      snapCount++;
      $('snapFlash').classList.add('on');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => $('snapFlash').classList.remove('on'), 120);
      break;
    case 'transient':
      $('heard').className = 'status' + (p.verdict === 'snap' ? ' ok' : '');
      $('heard').textContent = t('heard_' + p.verdict, [String(p.db)]);
      break;
    case 'calibrated':
      calibration = p.value;
      store.set({ calibration });
      break;
    case 'learn':
      learnResult = p.phase;
      $('learnMsg').className = 'status' + (p.phase === 'done' ? ' ok' : p.phase === 'failed' ? ' warn' : '');
      $('learnMsg').textContent =
        p.phase === 'listening'
          ? t('learnListening', [String(p.count)])
          : p.phase === 'done'
            ? t('learnDone')
            : p.phase === 'failed'
              ? t('learnFailed')
              : '';
      if (p.phase === 'done') saveSettings({ sensitivity: 0.5 });
      break;
    case 'notice':
      $('notice').textContent = t(p.key);
      $('notice').hidden = false;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => ($('notice').hidden = true), 5000);
      break;
  }
});

function setRoom(url) {
  roomUrl = url;
  $('roomImg').hidden = !url;
  $('roomEmpty').hidden = !!url;
  $('clearRoomBtn').hidden = !url;
  if (url) $('roomImg').src = url;
}

function render() {
  const s = status || {};
  const on = streams.length > 0;
  $('camBtn').textContent = t(on ? 'testStop' : 'testStart');
  $('status').textContent = s.supported === false ? t('unsupported') : s.camera ? t('camOn') : '';
  const label = { live: 'vanish', vanishing: 'vanishing', vanished: 'return', returning: 'returning' }[s.state || 'live'];
  const btn = $('vanishBtn');
  btn.textContent = t(label);
  btn.classList.toggle('return', s.state && s.state !== 'live');
  btn.disabled = !s.camera || !!s.capture || s.state === 'vanishing' || s.state === 'returning' ||
    (s.state === 'live' && !roomUrl);
  $('captureBtn').disabled = !s.camera || !!s.capture;
  $('snapToggle').checked = settings.snapEnabled;
  $('thanosToggle').checked = settings.thanos;
  $('doubleToggle').checked = settings.doubleSnap;
  $('sensitivity').value = Math.round(settings.sensitivity * 100);
  $('snapBox').hidden = !settings.snapEnabled;
  const mic = $('micState');
  mic.hidden = !settings.snapEnabled;
  mic.className = 'pill small' + (s.detector === 'on' ? ' on' : '');
  mic.textContent = t(s.detector === 'on' ? 'micOn' : s.detector === 'off' ? 'micIdle' : 'micWaiting');
  $('learnBtn').textContent = t(s.learning ? 'cancel' : 'learnBtn');
  $('learnBtn').disabled = s.detector !== 'on' && !s.learning;
  $('resetLearnBtn').hidden = !s.calibrated || s.learning;
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  store.set({ settings });
  toEngine('settings', settings);
  render();
}

async function startCamera() {
  const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
  // Patched getUserMedia -> processed track; original -> raw preview.
  const processed = await navigator.mediaDevices.getUserMedia({ video });
  const raw = await window.__thanosSnapEngine.originalGetUserMedia({ video });
  streams = [processed, raw];
  $('processed').srcObject = processed;
  $('raw').srcObject = raw;
  render();
}

function stopCamera() {
  for (const s of streams) s.getTracks().forEach((tr) => tr.stop());
  streams = [];
  $('processed').srcObject = null;
  $('raw').srcObject = null;
  render();
}

$('camBtn').addEventListener('click', () => (streams.length ? stopCamera() : startCamera().catch(alert)));
$('vanishBtn').addEventListener('click', () => toEngine('toggle'));
$('captureBtn').addEventListener('click', () => toEngine('captureRoom', {}));
$('clearRoomBtn').addEventListener('click', () => {
  store.remove('room');
  setRoom(null);
  toEngine('room', { dataUrl: null });
  render();
});
$('learnBtn').addEventListener('click', () => toEngine(status?.learning ? 'cancelLearn' : 'learnSnap'));
$('resetLearnBtn').addEventListener('click', () => {
  calibration = null;
  store.remove('calibration');
  toEngine('calibration', { value: null });
  $('learnMsg').textContent = '';
});
$('snapToggle').addEventListener('change', (e) => saveSettings({ snapEnabled: e.target.checked }));
$('thanosToggle').addEventListener('change', (e) => saveSettings({ thanos: e.target.checked }));
$('doubleToggle').addEventListener('change', (e) => saveSettings({ doubleSnap: e.target.checked }));
$('sensitivity').addEventListener('input', (e) => saveSettings({ sensitivity: e.target.value / 100 }));

// ---------- automated check ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, ms, what) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await sleep(50);
  }
}

// Mean absolute per-channel difference of two images at 160x90.
function meanDiff(a, b) {
  const c = new OffscreenCanvas(160, 90);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(a, 0, 0, 160, 90);
  const pa = ctx.getImageData(0, 0, 160, 90).data;
  ctx.drawImage(b, 0, 0, 160, 90);
  const pb = ctx.getImageData(0, 0, 160, 90).data;
  let sum = 0;
  for (let i = 0; i < pa.length; i += 4)
    sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
  return +(sum / (pa.length / 4) / 3).toFixed(2);
}

async function autotest() {
  const R = {};
  const phase = (p) => (document.body.dataset.phase = R.phase = p);
  try {
    saveSettings({ ...DEFAULTS, thanos: true });
    await startCamera();
    await waitFor(() => status?.camera, 5000, 'camera');
    await sleep(800);

    phase('capture');
    toEngine('captureRoom', { leaveMs: 300, holdMs: 1000 });
    await waitFor(() => roomUrl, 6000, 'room capture');
    await $('roomImg').decode();
    R.roomBytes = roomUrl.length;

    phase('vanishing');
    toEngine('vanish');
    await waitFor(() => status.state === 'vanishing', 2000, 'vanishing');
    await sleep(1400);
    phase('vanish-mid');
    await sleep(600);
    await waitFor(() => status.state === 'vanished', 8000, 'vanished');
    await sleep(600);
    phase('vanished');
    R.vanishedVsRoom = meanDiff($('processed'), $('roomImg'));
    R.rawVsRoom = meanDiff($('raw'), $('roomImg'));

    toEngine('return');
    await waitFor(() => status.state === 'returning', 2000, 'returning');
    await sleep(1400);
    phase('return-mid');
    await sleep(600);
    await waitFor(() => status.state === 'live', 8000, 'live');
    await sleep(600);
    R.liveVsRoom = meanDiff($('processed'), $('roomImg'));

    // Person mask must survive the camera re-adjusting exposure and white
    // balance when you step back in: room 30% brighter and warmer + a person.
    {
      const gw = 160;
      const gh = 90;
      const room = new Uint8ClampedArray(gw * gh * 4);
      const cur = new Uint8ClampedArray(gw * gh * 4);
      let inside = 0;
      for (let y = 0; y < gh; y++)
        for (let x = 0; x < gw; x++) {
          const o = (y * gw + x) * 4;
          const v = 60 + ((x * 7 + y * 13) % 90) + Math.sin(x / 5) * 15;
          room[o] = v + 20;
          room[o + 1] = v;
          room[o + 2] = v - 10;
          const person = ((x - 80) / 30) ** 2 + ((y - 75) / 45) ** 2 < 1;
          inside += person;
          cur[o] = person ? 200 : room[o] * 1.35 + (x % 3);
          cur[o + 1] = person ? 150 : room[o + 1] * 1.3 + (y % 2);
          cur[o + 2] = person ? 120 : room[o + 2] * 1.2;
        }
      const mask = window.__thanosSnapEngine.debug.personMask(cur, room, gw, gh);
      let hit = 0;
      let falsePos = 0;
      for (let y = 0; y < gh; y++)
        for (let x = 0; x < gw; x++) {
          const person = ((x - 80) / 30) ** 2 + ((y - 75) / 45) ** 2 < 1;
          if (mask[y * gw + x]) person ? hit++ : falsePos++;
        }
      R.maskRecall = +(hit / inside).toFixed(3);
      R.maskFalsePositive = +(falsePos / (gw * gh - inside)).toFixed(3);
    }

    // Plain fade mode round trip.
    saveSettings({ thanos: false });
    toEngine('vanish');
    await waitFor(() => status.state === 'vanished', 4000, 'fade vanished');
    toEngine('return');
    await waitFor(() => status.state === 'live', 4000, 'fade live');
    R.fadeRoundTrip = true;

    // Snap detector on Chrome's fake mic (periodic beeps): must start and
    // must not fire.
    saveSettings({ snapEnabled: true });
    await waitFor(() => status.detector === 'on', 5000, 'detector on');
    snapCount = 0;
    await sleep(3500);
    R.detector = status.detector;
    R.falseSnaps = snapCount;
    saveSettings({ snapEnabled: false });
    await waitFor(() => status.detector === 'off', 3000, 'detector off');

    stopCamera();
    await waitFor(() => !status.camera, 3000, 'camera released');

    const dbg = window.__thanosSnapEngine.debug;
    R.frames = dbg.frames;
    R.errors = dbg.errors;
    R.lastError = dbg.lastError;
    R.pass =
      R.errors === 0 &&
      R.frames > 60 &&
      R.vanishedVsRoom < 6 &&
      R.rawVsRoom > R.vanishedVsRoom &&
      R.maskRecall > 0.95 &&
      R.maskFalsePositive < 0.05 &&
      R.falseSnaps === 0;
  } catch (err) {
    R.error = String(err);
    R.pass = false;
  }
  phase('done');
  window.__autotest = R;
  console.log('AUTOTEST', JSON.stringify(R));
}

(async () => {
  await localize();
  const stored = await store.get(['settings', 'room', 'calibration']);
  settings = { ...DEFAULTS, ...stored.settings };
  calibration = stored.calibration || null;
  setRoom(stored.room || null);
  toEngine('settings', settings);
  toEngine('room', { dataUrl: roomUrl });
  toEngine('calibration', { value: calibration });
  toEngine('hello');
  render();
  if (location.search.includes('autotest')) autotest();
})();
