// Hand-gesture recognition with MediaPipe, entirely local. Used by the
// offscreen document (for call tabs) and directly by the test page.
import { GestureRecognizer } from '../vendor/mediapipe/vision_bundle.mjs';

export const GESTURES = ['Victory', 'ILoveYou', 'Thumb_Up', 'Open_Palm', 'Pointing_Up', 'Closed_Fist'];

const asset = (path) => new URL(`../vendor/mediapipe/${path}`, import.meta.url).href;

// Resolves to { delegate, recognize(image) }. recognize() returns
// { hands: [{ gesture, score }] } for the hands in the image, best first.
export async function createGestureRecognizer() {
  const fileset = {
    wasmLoaderPath: asset('wasm/vision_wasm_internal.js'),
    wasmBinaryPath: asset('wasm/vision_wasm_internal.wasm'),
  };
  let recognizer = null;
  let delegate = null;
  let lastError = null;
  // GPU is several times faster; fall back to CPU where WebGL isn't usable.
  for (const d of ['GPU', 'CPU']) {
    try {
      recognizer = await GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: asset('gesture_recognizer.task'), delegate: d },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      delegate = d;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!recognizer) throw lastError;

  let lastTs = 0;
  return {
    delegate,
    recognize(image) {
      // VIDEO mode tracks hands between frames; timestamps must increase.
      const ts = Math.max(performance.now(), lastTs + 1);
      lastTs = ts;
      const result = recognizer.recognizeForVideo(image, ts);
      const hands = (result.gestures || [])
        .map((cats) => (cats && cats[0] ? { gesture: cats[0].categoryName, score: cats[0].score } : null))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
      return { hands };
    },
    close() {
      recognizer.close();
    },
  };
}
