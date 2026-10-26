// Synthetic-signal tests for the snap detector: node scripts/test-analyzer.js
'use strict';
const SnapAnalyzer = require('../src/snap-analyzer.js');

const SR = 48000;
let seed = 1;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

function silence(sec, noise = 0.0005) {
  const out = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < out.length; i++) out[i] = rand() * noise;
  return out;
}

// Broadband burst: 0.3 ms rise, fast decay, optional reverb tail.
function addSnap(buf, atSec, amp = 0.3, tau = 0.006, reverb = 0) {
  const start = Math.round(atSec * SR);
  for (let i = 0; i < SR * 0.4 && start + i < buf.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.0003) * (Math.exp(-t / tau) + reverb * Math.exp(-t / 0.08));
    buf[start + i] += rand() * amp * env;
  }
}

// Voiced speech: 140 Hz harmonics up to 3 kHz, 4 Hz syllable envelope.
function addSpeech(buf, fromSec, sec, amp = 0.2) {
  const start = Math.round(fromSec * SR);
  for (let i = 0; i < sec * SR && start + i < buf.length; i++) {
    const t = i / SR;
    const env = Math.max(0, Math.sin(2 * Math.PI * 4 * t));
    let v = 0;
    for (let k = 1; k * 140 < 3000; k++) v += Math.sin(2 * Math.PI * 140 * k * t) / Math.pow(k, 1.5);
    buf[start + i] += v * amp * env * 0.5;
  }
}

// Chrome's fake-device style 1 kHz beeps.
function addBeep(buf, atSec, freq = 1000, sec = 0.1, amp = 0.3) {
  const start = Math.round(atSec * SR);
  for (let i = 0; i < sec * SR; i++) buf[start + i] += Math.sin((2 * Math.PI * freq * i) / SR) * amp;
}

// Real snaps have a low "thump" from the finger hitting the palm under the
// crack, and laptop mics pick them up fairly quietly.
function addRealSnap(buf, atSec, amp = 0.05) {
  addSnap(buf, atSec, amp, 0.005);
  const start = Math.round(atSec * SR);
  for (let i = 0; i < SR * 0.1; i++) {
    const t = i / SR;
    buf[start + i] += Math.sin(2 * Math.PI * 180 * t) * amp * 1.2 * Math.exp(-t / 0.012);
  }
}

function run(buf, sensitivity = 0.5, calibration = null, events = null) {
  const a = new SnapAnalyzer(SR, sensitivity, calibration);
  let snaps = 0;
  for (let i = 0; i < buf.length; i += 1024) {
    snaps += a.process(buf.subarray(i, i + 1024));
    if (events) events.push(...a.takeEvents());
  }
  return snaps;
}

const cases = [];
const check = (name, got, want) => cases.push({ name, got, want, ok: got === want });

{
  const b = silence(4);
  addSnap(b, 1.0);
  addSnap(b, 2.5);
  check('two clean snaps', run(b), 2);
}
{
  const b = silence(4);
  addSnap(b, 1.0, 0.15, 0.008, 0.05);
  check('quieter snap with reverb tail', run(b), 1);
}
{
  const b = silence(5);
  addSpeech(b, 0.5, 4);
  check('continuous speech', run(b), 0);
}
{
  const b = silence(5);
  for (let s = 0.5; s < 4.5; s += 1) addBeep(b, s);
  check('1 kHz beeps', run(b), 0);
}
{
  const b = silence(5);
  for (let s = 0.5; s < 4.5; s += 1) addBeep(b, s, 6000, 0.2, 0.2);
  check('6 kHz beeps (sustained high tone)', run(b), 0);
}
{
  const b = silence(5);
  for (let s = 0.5; s < 4.5; s += 0.13) addSnap(b, s, 0.03, 0.002);
  check('fast typing clicks', run(b), 0);
}
{
  const b = silence(4);
  addSpeech(b, 0.2, 3.5, 0.05);
  addSnap(b, 2.0, 0.4);
  check('loud snap over quiet speech', run(b), 1);
}
{
  const b = silence(3);
  addSnap(b, 1.0);
  addSnap(b, 1.4);
  check('double snap 0.4 s apart', run(b), 2);
}
{
  const b = silence(5, 0.001);
  addRealSnap(b, 1.0);
  addRealSnap(b, 2.5);
  addRealSnap(b, 4.0);
  check('realistic snaps (thump + crack) with fan noise', run(b), 3);
}
{
  const b = silence(4, 0.0003);
  addRealSnap(b, 1.0, 0.008);
  addRealSnap(b, 2.5, 0.008);
  check('realistic snaps on a quiet low-gain mic', run(b), 2);
}
{
  const b = silence(4, 0.0003);
  addRealSnap(b, 1.0, 0.004);
  addRealSnap(b, 2.5, 0.004);
  check('distant snaps (arm length from a laptop mic)', run(b), 2);
}
{
  const b = silence(3, 0.002);
  addSnap(b, 1.0, 0.004);
  check('faint click near the noise floor at low sensitivity', run(b, 0), 0);
}
{
  // Calibration: learn from three snaps, then the learned thresholds must
  // still catch snaps and still ignore speech.
  const learn = silence(4, 0.001);
  addRealSnap(learn, 0.8, 0.03);
  addRealSnap(learn, 1.8, 0.03);
  addRealSnap(learn, 2.8, 0.03);
  const events = [];
  run(learn, 0.5, null, events);
  const cal = SnapAnalyzer.calibrate(events);
  check('calibration learns from 3 snaps', cal ? 'ok' : 'null', 'ok');
  const b = silence(4, 0.001);
  addRealSnap(b, 1.0, 0.03);
  addRealSnap(b, 2.5, 0.03);
  check('calibrated: detects snaps', run(b, 0.5, cal), 2);
  const sp = silence(5, 0.001);
  addSpeech(sp, 0.5, 4);
  check('calibrated: ignores speech', run(sp, 0.5, cal), 0);
}

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: got ${c.got}, want ${c.want}`);
}
process.exit(failed ? 1 : 0);
