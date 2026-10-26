// End-to-end check of the engine in real Chrome with a fake camera and mic.
// Serves the repo (with the extension pages' CSP), opens
// test/test.html?autotest headless, saves screenshots of each phase and
// prints the result. Hand-gesture photos come from MediaPipe's public test
// assets and are cached in the temp folder. No dependencies (Node 22+).
//
//   node scripts/e2e.js [screenshot-dir]
//   CHROME_PATH=/path/to/chrome node scripts/e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const shotDir = process.argv[2] || path.join(os.tmpdir(), 'thanos-snap-e2e');
const CHROME =
  process.env.CHROME_PATH ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p));

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};
// Same policy as manifest.json's extension_pages, so CSP problems show up here.
const CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
const fixtureDir = path.join(os.tmpdir(), 'thanos-snap-fixtures');
const FIXTURES = ['victory', 'thumb_up'];

async function fetchFixtures() {
  fs.mkdirSync(fixtureDir, { recursive: true });
  for (const name of FIXTURES) {
    const file = path.join(fixtureDir, name + '.jpg');
    if (fs.existsSync(file)) continue;
    const res = await fetch(`https://storage.googleapis.com/mediapipe-assets/${name}.jpg`);
    if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
}

// strict: extension-page CSP, which blocks blob: workers -> the engine's
// inline compositor fallback. open: no CSP -> the Worker compositor.
function serve(strict) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const base = rel.startsWith('/fixtures/') ? fixtureDir : root;
    const file = path.join(base, rel.startsWith('/fixtures/') ? rel.slice(10) : rel);
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      ...(strict ? { 'content-security-policy': CSP } : {}),
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME) throw new Error('Chrome not found; set CHROME_PATH');
  fs.mkdirSync(shotDir, { recursive: true });
  let fixtures = '';
  try {
    await fetchFixtures();
    fixtures = '&fixtures=/fixtures/';
  } catch (err) {
    console.log('  (skipping hand-gesture check: ' + err.message + ')');
  }
  let ok = true;
  for (const strict of [true, false]) {
    console.log(strict ? 'Pass 1: extension CSP (inline compositor)' : 'Pass 2: no CSP (Worker compositor)');
    let result = await run(strict, fixtures);
    // Headless Chrome's fake camera occasionally never starts, even without
    // the extension. Retry once in that case.
    if (result && /camera frames|waiting for camera/.test(result.error || '')) {
      console.log('  fake camera did not start, retrying');
      result = await run(strict, fixtures);
    }
    console.log(JSON.stringify(result, null, 2));
    ok &&= !!(result && result.pass && (strict ? result.inline > 0 : result.workers > 0));
  }
  process.exit(ok ? 0 : 1);
}

async function run(strict, fixtures) {
  const server = await serve(strict);
  const url = `http://127.0.0.1:${server.address().port}/test/test.html?autotest${fixtures}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'thanos-snap-profile-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1200,1000',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);

  let output = '';
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not start:\n' + output)), 20000);
    chrome.stderr.on('data', (d) => {
      output += d;
      const m = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });

  const port = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((tg) => tg.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      console.log('  [page]', msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      console.log('  [page error]', msg.params.exceptionDetails.exception?.description);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });

  const shots = new Set();
  let result = null;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const phase = await evaluate('document.body && document.body.dataset.phase');
    if (phase && ['vanish-mid', 'vanished', 'return-mid', 'gesture'].includes(phase) && !shots.has(phase)) {
      shots.add(phase);
      const { result: r } = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(shotDir, `${strict ? 'strict' : 'worker'}-${phase}.png`);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log('  screenshot', file);
    }
    if (phase === 'done') {
      result = await evaluate('window.__autotest');
      break;
    }
    await sleep(100);
  }

  ws.close();
  chrome.kill();
  server.close();
  return result;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
