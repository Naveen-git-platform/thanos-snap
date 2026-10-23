// End-to-end check of the engine in real Chrome with a fake camera and mic.
// Serves the repo, opens test/test.html?autotest headless, saves screenshots
// of each phase and prints the result. No dependencies (Node 22+).
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME) throw new Error('Chrome not found; set CHROME_PATH');
  fs.mkdirSync(shotDir, { recursive: true });
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/test/test.html?autotest`;
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
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const phase = await evaluate('document.body && document.body.dataset.phase');
    if (phase && ['vanish-mid', 'vanished', 'return-mid'].includes(phase) && !shots.has(phase)) {
      shots.add(phase);
      const { result: r } = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(shotDir, `${phase}.png`);
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
  console.log(JSON.stringify(result, null, 2));
  process.exit(result && result.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
