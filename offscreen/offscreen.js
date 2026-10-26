// Offscreen document: runs the hand-gesture model for all call tabs.
// Frames arrive from bridge.js as small JPEG data URLs.
import { createGestureRecognizer } from '../src/gesture.js';

const IDLE_CLOSE_MS = 2 * 60 * 1000;

let recognizer = null;
let lastUse = Date.now();

function getRecognizer() {
  recognizer ||= createGestureRecognizer().catch((err) => {
    recognizer = null;
    throw err;
  });
  return recognizer;
}

function dataUrlToBlob(url) {
  const [head, b64] = url.split(',');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'recognize') return;
  lastUse = Date.now();
  (async () => {
    try {
      const rec = await getRecognizer();
      const bitmap = await createImageBitmap(dataUrlToBlob(msg.image));
      const result = rec.recognize(bitmap);
      bitmap.close();
      sendResponse({ result, delegate: rec.delegate });
    } catch (err) {
      sendResponse({ error: String((err && err.message) || err) });
    }
  })();
  return true;
});

// Free the model's memory when no call is using it.
setInterval(() => {
  if (Date.now() - lastUse > IDLE_CLOSE_MS) chrome.runtime.sendMessage({ type: 'offscreenIdle' }).catch(() => {});
}, 30000);

getRecognizer().catch(() => {});
