// Isolated-world bridge between engine.js (page MAIN world) and the rest of
// the extension: pushes settings and the room snapshot in, relays status,
// levels and events out to the popup and service worker.
(() => {
  'use strict';

  const NS = '__thanosSnap';
  const frameKey = Math.random().toString(36).slice(2);
  const ports = new Set();
  let settings = null;
  let roomUrl = null;
  let calibration = null;
  let loaded = false;
  let status = null;
  let booted = false;

  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  function toEngine(type, payload) {
    window.postMessage({ [NS]: 'to-engine', type, payload }, '*');
  }

  function pushAll() {
    if (!loaded) return;
    toEngine('settings', settings);
    toEngine('room', { dataUrl: roomUrl });
    toEngine('calibration', { value: calibration });
    toEngine('hello');
  }

  function broadcast(type, payload) {
    for (const port of ports) {
      try {
        port.postMessage({ type, payload, frame: frameKey });
      } catch {
        ports.delete(port);
      }
    }
  }

  // Hand-gesture frames go to the offscreen recogniser page. Extension
  // messaging only carries JSON, so frames travel as small JPEGs.
  let encoder = null;
  async function recognize(bitmap) {
    try {
      if (!encoder || encoder.width !== bitmap.width || encoder.height !== bitmap.height) {
        encoder = new OffscreenCanvas(bitmap.width, bitmap.height);
      }
      encoder.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close();
      const blob = await encoder.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      const image = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await chrome.runtime.sendMessage({ type: 'recognize', image }).catch(() => null);
        if (res) return res;
        // No recogniser page yet (or it was closed while idle): start it.
        await chrome.runtime.sendMessage({ type: 'ensureOffscreen' }).catch(() => null);
      }
      return { error: 'recogniser unavailable' };
    } catch (err) {
      return { error: String(err) };
    }
  }

  chrome.storage.local.get(['settings', 'room', 'calibration']).then((r) => {
    settings = r.settings || {};
    roomUrl = r.room || null;
    calibration = r.calibration || null;
    loaded = true;
    pushAll();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = changes.settings.newValue || {};
      toEngine('settings', settings);
    }
    if (changes.room) {
      roomUrl = changes.room.newValue || null;
      toEngine('room', { dataUrl: roomUrl });
    }
    if (changes.calibration) {
      calibration = changes.calibration.newValue || null;
      toEngine('calibration', { value: calibration });
    }
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[NS] !== 'from-engine' || !alive()) return;
    switch (d.type) {
      case 'ready':
        pushAll();
        break;
      case 'status':
        // Start loading the gesture model as soon as a camera is on, so it
        // is ready by the time the user shows a gesture.
        if (d.payload.camera && !status?.camera && settings?.gestureEnabled !== false) {
          chrome.runtime.sendMessage({ type: 'ensureOffscreen' }).catch(() => {});
        }
        status = d.payload;
        chrome.runtime.sendMessage({ type: 'status', status, boot: !booted }).catch(() => {});
        booted = true;
        broadcast('status', status);
        break;
      case 'gestureFrame':
        recognize(d.payload.bitmap).then((res) => toEngine('gestureResult', { id: d.payload.id, ...res }));
        break;
      case 'calibrated':
        calibration = d.payload.value;
        chrome.storage.local.set({ calibration });
        break;
      case 'roomCaptured':
        roomUrl = d.payload.dataUrl;
        chrome.storage.local.set({ room: roomUrl });
        broadcast('roomCaptured', d.payload);
        break;
      default:
        broadcast(d.type, d.payload);
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'command') toEngine(msg.command, msg.payload);
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'thanos-popup') return;
    ports.add(port);
    port.onMessage.addListener((msg) => {
      if (msg && msg.type) toEngine(msg.type, msg.payload);
    });
    port.onDisconnect.addListener(() => ports.delete(port));
    if (status) port.postMessage({ type: 'status', payload: status, frame: frameKey });
    toEngine('hello');
  });
})();
