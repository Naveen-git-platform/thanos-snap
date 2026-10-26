// Finger-snap detector. Pure JS so it can run in the page (fed by a
// ScriptProcessorNode) and in Node for tests.
//
// Every sharp sound (a "transient": high-band energy jumping above the noise
// floor after a quieter moment) is measured, then judged against thresholds:
//   snr     high-band peak over the adaptive noise floor   -> loud enough
//   ratio   high-band share of the total energy at the peak -> bright, not a thud/voice
//   decayH  high-band energy 30-150 ms later vs the peak    -> short, not "sss" or music
//   decayF  full-band energy 30-150 ms later vs the peak    -> not a "t" followed by a vowel
// Thresholds come from defaults or from calibration (learned from the user's
// own snaps), scaled by the sensitivity slider.
(function (root) {
  'use strict';

  const DEFAULTS = { k: 10, ratio: 0.1, decayH: 0.25, decayF: 0.4 };
  const CANDIDATE_SNR = 3;

  class SnapAnalyzer {
    constructor(sampleRate, sensitivity = 0.5, calibration = null) {
      this.sr = sampleRate;
      this.block = Math.max(64, Math.round(sampleRate / 375)); // ~2.7 ms
      const blockSec = this.block / sampleRate;
      this.histLen = Math.round(0.25 / blockSec);
      this.hist = new Float32Array(this.histLen);
      this.lateStart = Math.round(0.03 / blockSec);
      this.lateEnd = Math.round(0.15 / blockSec);
      this.cooldown = Math.round(0.2 / blockSec);

      // RBJ biquad high-pass, 1.5 kHz, Q = 0.707
      const w0 = (2 * Math.PI * 1500) / sampleRate;
      const cos = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * 0.707);
      const a0 = 1 + alpha;
      this.b0 = (1 + cos) / 2 / a0;
      this.b1 = -(1 + cos) / a0;
      this.b2 = (1 + cos) / 2 / a0;
      this.a1 = (-2 * cos) / a0;
      this.a2 = (1 - alpha) / a0;
      this.x1 = this.x2 = this.y1 = this.y2 = 0;

      this.accH = 0;
      this.accF = 0;
      this.count = 0;
      this.idx = 0;
      this.nf = 0;
      this.pending = null;
      this.cooldownUntil = 0;
      this.level = 0;
      this.events = [];
      this.sensitivity = 0.5;
      this.calibration = null;
      this.configure(sensitivity, calibration);
    }

    configure(sensitivity, calibration) {
      if (sensitivity != null) this.sensitivity = Math.min(1, Math.max(0, Number(sensitivity) || 0));
      if (calibration !== undefined) this.calibration = calibration || null;
      const base = { ...DEFAULTS, ...(this.calibration || {}) };
      // Slider in the middle = base thresholds; each end is 4x looser/stricter.
      const f = Math.pow(4, (this.sensitivity - 0.5) * 2);
      this.k = Math.max(2, base.k / f);
      this.ratio = base.ratio / Math.sqrt(f);
      this.decayH = Math.min(0.9, base.decayH * Math.sqrt(f));
      this.decayF = Math.min(0.95, base.decayF * Math.pow(f, 0.3));
    }

    setSensitivity(s) {
      this.configure(s);
    }

    // Feed mono samples; returns the number of snaps detected in them.
    // Details of every transient are appended to this.events.
    process(samples) {
      let snaps = 0;
      const { b0, b1, b2, a1, a2, block } = this;
      let { x1, x2, y1, y2, accH, accF, count } = this;
      for (let n = 0; n < samples.length; n++) {
        const x = samples[n];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2 + 1e-20;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        accH += y * y;
        accF += x * x;
        if (++count === block) {
          snaps += this._block(accH / block, accF / block);
          accH = accF = 0;
          count = 0;
        }
      }
      Object.assign(this, { x1, x2, y1, y2, accH, accF, count });
      return snaps;
    }

    takeEvents() {
      const e = this.events;
      this.events = [];
      return e;
    }

    // Loudest high-band level since the last call, relative to the trigger
    // threshold (1 = loud enough to count as a snap).
    takeLevel() {
      const l = this.level;
      this.level = 0;
      return l;
    }

    judge(f) {
      if (f.snr < this.k) return 'quiet';
      if (f.ratio < this.ratio) return 'dull';
      if (f.decayH > this.decayH || f.decayF > this.decayF) return 'long';
      return 'snap';
    }

    _block(eh, ef) {
      const i = this.idx++;
      let snap = 0;
      if (this.nf === 0) this.nf = Math.max(eh, 1e-10);
      this.level = Math.max(this.level, eh / (this.nf * this.k));

      const p = this.pending;
      if (p) {
        p.n++;
        if (p.n <= 3) {
          p.peakH = Math.max(p.peakH, eh);
          p.peakF = Math.max(p.peakF, ef);
        } else if (p.n >= this.lateStart) {
          p.lateH = Math.max(p.lateH, eh);
          p.lateF = Math.max(p.lateF, ef);
        }
        if (p.n >= this.lateEnd) {
          this.pending = null;
          const f = {
            snr: p.peakH / p.nf,
            ratio: p.peakH / Math.max(p.peakF, 1e-20),
            decayH: p.lateH / p.peakH,
            decayF: p.lateF / Math.max(p.peakF, 1e-20),
          };
          f.verdict = this.judge(f);
          this.events.push(f);
          if (f.verdict === 'snap') {
            snap = 1;
            this.cooldownUntil = i + this.cooldown;
          }
        }
      } else if (i >= this.cooldownUntil && eh > this.nf * CANDIDATE_SNR && eh > 1e-9) {
        let preMax = 0;
        for (let j = 3; j < this.histLen; j++) {
          const v = this.hist[(i - j + this.histLen * 4) % this.histLen];
          if (v > preMax) preMax = v;
        }
        if (preMax * 3 < eh) {
          this.pending = { n: 0, nf: this.nf, peakH: eh, peakF: ef, lateH: 0, lateF: 0 };
        }
      }

      if (!this.pending) {
        const rate = eh < this.nf * 4 ? 0.01 : 0.0005;
        this.nf = Math.max(this.nf + (eh - this.nf) * rate, 1e-10);
      }
      this.hist[i % this.histLen] = eh;
      return snap;
    }

    // Thresholds that accept all of the given transients (the user's own
    // snaps) with some margin. Returns null if they don't look like snaps.
    static calibrate(samples) {
      const good = samples.filter((s) => s.snr >= 4);
      if (good.length < 2) return null;
      const min = (key) => Math.min(...good.map((s) => s[key]));
      const max = (key) => Math.max(...good.map((s) => s[key]));
      return {
        k: Math.max(3, min('snr') / 3),
        ratio: Math.max(0.01, min('ratio') * 0.5),
        decayH: Math.min(0.8, Math.max(0.12, max('decayH') * 2)),
        decayF: Math.min(0.9, Math.max(0.25, max('decayF') * 2)),
      };
    }
  }

  root.ThanosSnapAnalyzer = SnapAnalyzer;
  if (typeof module === 'object' && module.exports) module.exports = SnapAnalyzer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
