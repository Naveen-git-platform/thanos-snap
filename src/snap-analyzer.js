// Finger-snap detector. Pure JS so it can run in the page (fed by a
// ScriptProcessorNode) and in Node for tests.
//
// A snap is a short, bright, isolated transient:
//   - high-band energy (> ~2.5 kHz) jumps far above the adaptive noise floor
//   - a large share of the energy is in the high band (voice is bass-heavy)
//   - the preceding ~250 ms was clearly quieter (rejects speech and typing runs)
//   - 30-150 ms later both bands stay low (rejects "s", "t" + vowel, music,
//     and the first key of a typing burst)
(function (root) {
  'use strict';

  class SnapAnalyzer {
    constructor(sampleRate, sensitivity = 0.5) {
      this.sr = sampleRate;
      this.block = Math.max(64, Math.round(sampleRate / 375)); // ~2.7 ms
      const blockSec = this.block / sampleRate;
      this.histLen = Math.round(0.25 / blockSec);
      this.hist = new Float32Array(this.histLen);
      this.lateStart = Math.round(0.03 / blockSec);
      this.lateEnd = Math.round(0.15 / blockSec);
      this.cooldown = Math.round(0.25 / blockSec);

      // RBJ biquad high-pass, 2.5 kHz, Q = 0.707
      const w0 = (2 * Math.PI * 2500) / sampleRate;
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
      this.setSensitivity(sensitivity);
    }

    setSensitivity(s) {
      s = Math.min(1, Math.max(0, Number(s) || 0));
      this.k = 100 * Math.pow(10, -1.5 * s); // 20 dB .. 5 dB above floor
      this.ratio = 0.3 - 0.2 * s; // min high-band share of total energy
      this.decay = 0.1 + 0.16 * s; // max late/peak energy
      this.absMin = 5e-5 * Math.pow(10, -1.5 * (s - 0.5));
    }

    // Feed mono samples; returns the number of snaps detected in them.
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

    // Loudest high-band level since the last call, relative to the trigger
    // threshold (1 = would trigger).
    takeLevel() {
      const l = this.level;
      this.level = 0;
      return l;
    }

    _block(eh, ef) {
      const i = this.idx++;
      let snap = 0;
      if (this.nf === 0) this.nf = Math.max(eh, 1e-10);
      const thr = Math.max(this.nf * this.k, this.absMin);
      this.level = Math.max(this.level, eh / thr);

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
          if (p.lateH < p.peakH * this.decay && p.lateF < p.peakF * 0.3) {
            snap = 1;
            this.cooldownUntil = i + this.cooldown;
          }
          this.pending = null;
        }
      } else if (i >= this.cooldownUntil && eh > thr && eh > ef * this.ratio) {
        let preMax = 0;
        for (let j = 3; j < this.histLen; j++) {
          const v = this.hist[(i - j + this.histLen * 4) % this.histLen];
          if (v > preMax) preMax = v;
        }
        if (preMax * 4 < eh) {
          this.pending = { n: 0, peakH: eh, peakF: ef, lateH: 0, lateF: 0 };
        }
      }

      if (!this.pending) {
        const rate = eh < this.nf * 4 ? 0.01 : 0.0005;
        this.nf = Math.max(this.nf + (eh - this.nf) * rate, 1e-10);
      }
      this.hist[i % this.histLen] = eh;
      return snap;
    }
  }

  root.ThanosSnapAnalyzer = SnapAnalyzer;
  if (typeof module === 'object' && module.exports) module.exports = SnapAnalyzer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
