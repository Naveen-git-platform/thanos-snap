'use strict';

const CALL_URLS = [
  'https://meet.google.com/*',
  'https://teams.microsoft.com/*',
  'https://teams.live.com/*',
  'https://teams.cloud.microsoft/*',
  'https://*.zoom.us/*',
  'https://*.zoom.com/*',
];
const DEFAULTS = { thanos: true, snapEnabled: false, sensitivity: 0.5, doubleSnap: false };

const $ = (id) => document.getElementById(id);
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

let settings = { ...DEFAULTS };
let port = null;
let tabId = null;
let frames = {};
let gotStatus = false;
let noticeTimer = 0;
let flashTimer = 0;

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
document.documentElement.lang = chrome.i18n.getUILanguage();

function serviceName(url) {
  const host = new URL(url).hostname;
  if (host === 'meet.google.com') return 'Google Meet';
  if (host.includes('teams')) return 'Microsoft Teams';
  if (host.includes('zoom')) return 'Zoom';
  return host;
}

function aggregate() {
  const list = Object.values(frames);
  const cam = list.find((f) => f.camera);
  const main = cam || list[0] || null;
  return {
    known: list.length > 0,
    supported: list.length === 0 || list.some((f) => f.supported),
    camera: !!cam,
    state: main ? main.state : 'live',
    hasRoom: list.some((f) => f.hasRoom),
    detector: cam ? cam.detector : 'off',
    capture: (cam && cam.capture) || null,
  };
}

function showNotice(key) {
  const el = $('notice');
  el.textContent = t(key);
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el.hidden = true), 5000);
}

function render() {
  const s = aggregate();
  const callStatus = $('callStatus');
  callStatus.className = 'status';
  $('reloadBtn').hidden = true;
  if (!gotStatus) {
    callStatus.textContent = t('connecting');
  } else if (!s.known) {
    callStatus.textContent = t('notAttached');
    callStatus.classList.add('warn');
    $('reloadBtn').hidden = false;
  } else if (!s.supported) {
    callStatus.textContent = t('unsupported');
    callStatus.classList.add('warn');
  } else if (s.camera) {
    callStatus.textContent = t('camOn');
    callStatus.classList.add('ok');
  } else {
    callStatus.textContent = t('camOff');
    callStatus.classList.add('warn');
  }

  const badge = $('badge');
  badge.hidden = !s.camera;
  badge.className = 'pill ' + (s.state === 'live' ? 'on' : 'gone');
  badge.textContent = s.state === 'live' ? t('badgeLive') : t('badgeGone');

  const btn = $('vanishBtn');
  const label = {
    live: 'vanish',
    vanishing: 'vanishing',
    vanished: 'return',
    returning: 'returning',
  }[s.state];
  btn.textContent = t(label);
  btn.classList.toggle('return', s.state !== 'live');
  btn.disabled = !s.camera || !!s.capture || s.state === 'vanishing' || s.state === 'returning' ||
    (s.state === 'live' && !s.hasRoom);

  $('captureBtn').textContent = s.capture ? t('cancel') : t('captureBtn');
  $('captureBtn').disabled = !s.camera;
  $('captureOverlay').hidden = !s.capture;

  const mic = $('micState');
  mic.className = 'pill small' + (s.detector === 'on' ? ' on' : '');
  mic.textContent = settings.snapEnabled
    ? t(s.detector === 'on' ? 'micOn' : s.detector === 'off' ? 'micIdle' : 'micWaiting')
    : '';
  mic.hidden = !settings.snapEnabled;
}

function renderRoom(url) {
  $('roomImg').hidden = !url;
  $('roomEmpty').hidden = !!url;
  $('clearRoomBtn').hidden = !url;
  if (url) $('roomImg').src = url;
  else $('roomImg').removeAttribute('src');
}

function renderSettings() {
  $('snapToggle').checked = settings.snapEnabled;
  $('thanosToggle').checked = settings.thanos;
  $('doubleToggle').checked = settings.doubleSnap;
  $('sensitivity').value = Math.round(settings.sensitivity * 100);
  $('snapBox').hidden = !settings.snapEnabled;
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  chrome.storage.local.set({ settings });
  renderSettings();
  render();
}

function send(type, payload) {
  if (port) port.postMessage({ type, payload });
}

function onPortMessage(msg) {
  switch (msg.type) {
    case 'status':
      gotStatus = true;
      frames[msg.frame] = msg.payload;
      render();
      break;
    case 'capture': {
      const msgEl = $('captureMsg');
      if (msg.payload.phase === 'done') {
        msgEl.textContent = t('captureDone');
        $('captureCount').textContent = '';
      } else {
        const key = msg.payload.phase === 'leave' ? 'captureLeave' : 'captureHold';
        msgEl.textContent = t(key, [String(msg.payload.seconds)]);
        $('captureCount').textContent = msg.payload.seconds;
      }
      break;
    }
    case 'roomCaptured':
      renderRoom(msg.payload.dataUrl);
      break;
    case 'level':
      $('meterFill').style.width = Math.min(100, (msg.payload.value / 1.5) * 100) + '%';
      break;
    case 'snap': {
      const f = $('snapFlash');
      f.classList.add('on');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => f.classList.remove('on'), 120);
      break;
    }
    case 'notice':
      showNotice(msg.payload.key);
      break;
  }
}

function connect(id) {
  if (port) port.disconnect();
  tabId = id;
  frames = {};
  gotStatus = false;
  render();
  chrome.storage.session.set({ selectedTabId: id });
  port = chrome.tabs.connect(id, { name: 'thanos-popup' });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    gotStatus = true;
    render();
  });
  // No bridge in the tab (opened before install) -> no status ever arrives.
  setTimeout(() => {
    if (!gotStatus && tabId === id) {
      gotStatus = true;
      render();
    }
  }, 800);
}

async function init() {
  const stored = await chrome.storage.local.get(['settings', 'room']);
  settings = { ...DEFAULTS, ...stored.settings };
  renderSettings();
  renderRoom(stored.room || null);

  const commands = await chrome.commands.getAll();
  const key = commands.find((c) => c.name === 'toggle-vanish')?.shortcut || 'Alt+Shift+V';
  $('shortcut').textContent = t('shortcut', [key]);

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const callTabs = await chrome.tabs.query({ url: CALL_URLS });
  if (!callTabs.length) {
    $('noCalls').hidden = false;
    return;
  }
  $('main').hidden = false;

  const { tabs: known = {}, selectedTabId } = await chrome.storage.session.get(['tabs', 'selectedTabId']);
  const hasCam = (id) => Object.values(known[id]?.frames || {}).some((f) => f.camera);
  const select = $('callSelect');
  for (const tab of callTabs) {
    const opt = document.createElement('option');
    opt.value = tab.id;
    opt.textContent = `${hasCam(tab.id) ? '● ' : ''}${serviceName(tab.url)} — ${tab.title || tab.url}`;
    select.append(opt);
  }
  const ids = callTabs.map((tb) => tb.id);
  const pick =
    (active && ids.includes(active.id) && active.id) ||
    (ids.includes(selectedTabId) && selectedTabId) ||
    ids.find(hasCam) ||
    ids[0];
  select.value = String(pick);
  select.addEventListener('change', () => connect(Number(select.value)));
  connect(pick);
}

$('vanishBtn').addEventListener('click', () => send('toggle'));
$('captureBtn').addEventListener('click', () => {
  if (aggregate().capture) send('cancelCapture');
  else {
    $('captureMsg').textContent = '';
    send('captureRoom', {});
  }
});
$('clearRoomBtn').addEventListener('click', () => {
  chrome.storage.local.remove('room');
  renderRoom(null);
});
$('reloadBtn').addEventListener('click', () => {
  if (tabId != null) chrome.tabs.reload(tabId);
  window.close();
});
$('snapToggle').addEventListener('change', (e) => saveSettings({ snapEnabled: e.target.checked }));
$('thanosToggle').addEventListener('change', (e) => saveSettings({ thanos: e.target.checked }));
$('doubleToggle').addEventListener('change', (e) => saveSettings({ doubleSnap: e.target.checked }));
$('sensitivity').addEventListener('input', (e) => saveSettings({ sensitivity: e.target.value / 100 }));
$('testLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('test/test.html') });
});

init();
