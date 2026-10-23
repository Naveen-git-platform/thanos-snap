// Service worker: tracks which call tabs have a processed camera, keeps the
// toolbar badge in sync, and routes the Alt+Shift+V shortcut.
'use strict';

let queue = Promise.resolve();

// Serialised read-modify-write of the per-tab status map in session storage.
function withTabs(fn) {
  queue = queue
    .then(async () => {
      const { tabs = {} } = await chrome.storage.session.get('tabs');
      const result = fn(tabs);
      await chrome.storage.session.set({ tabs });
      return result;
    })
    .catch((err) => console.error(err));
  return queue;
}

function summarize(entry) {
  const frames = Object.values((entry && entry.frames) || {});
  const withCam = frames.filter((f) => f.camera);
  const main = withCam[0] || frames[0] || null;
  return {
    known: frames.length > 0,
    camera: withCam.length > 0,
    state: main ? main.state : 'live',
    hasRoom: frames.some((f) => f.hasRoom),
  };
}

async function updateBadge(tabId) {
  const { tabs = {} } = await chrome.storage.session.get('tabs');
  const s = summarize(tabs[tabId]);
  let text = '';
  let color = '#16a34a';
  if (s.camera && s.state !== 'live') {
    text = 'GONE';
    color = '#7c3aed';
  } else if (s.camera) {
    text = 'ON';
  }
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {}
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'status' || !sender.tab) return;
  const tabId = sender.tab.id;
  withTabs((tabs) => {
    // A fresh top-frame bridge means the page reloaded: forget old frames.
    if (msg.boot && sender.frameId === 0) delete tabs[tabId];
    const entry = (tabs[tabId] ||= { frames: {} });
    entry.frames[sender.frameId] = msg.status;
  }).then(() => updateBadge(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withTabs((tabs) => {
    delete tabs[tabId];
  });
});

async function pickTab(activeTab) {
  const { tabs = {}, selectedTabId } = await chrome.storage.session.get(['tabs', 'selectedTabId']);
  const hasCam = (id) => id != null && summarize(tabs[id]).camera;
  if (activeTab && hasCam(activeTab.id)) return activeTab.id;
  if (hasCam(selectedTabId)) return selectedTabId;
  const any = Object.keys(tabs).find((id) => hasCam(id));
  if (any) return Number(any);
  if (activeTab && tabs[activeTab.id]) return activeTab.id;
  return selectedTabId ?? null;
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-vanish') return;
  const tabId = await pickTab(tab);
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'command', command: 'toggle' }).catch(() => {});
});
