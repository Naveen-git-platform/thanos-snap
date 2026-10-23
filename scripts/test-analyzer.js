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

function run(buf, sensitivity = 0.5) {
  const a = new SnapAnalyzer(SR, sensitivity);
  let snaps = 0;
  for (let i = 0; i < buf.length; i += 1024) snaps += a.process(buf.subarray(i, i + 1024));
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
  const b = silence(3);
  addSnap(b, 1.0, 0.02);
  check('faint snap at low sensitivity', run(b, 0), 0);
}

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: got ${c.got}, want ${c.want}`);
}
process.exit(failed ? 1 : 0);
