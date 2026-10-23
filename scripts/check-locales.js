// Verifies every message key the extension uses exists in every locale.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const used = new Set();
const add = (re, text) => {
  for (const m of text.matchAll(re)) used.add(m[1]);
};
add(/__MSG_(\w+)__/g, read('manifest.json'));
for (const f of ['popup/popup.html', 'test/test.html']) add(/data-i18n="(\w+)"/g, read(f));
for (const f of ['popup/popup.js', 'test/test.js']) add(/\bt\('(\w+)'/g, read(f));
add(/notice\('(\w+)'\)/g, read('src/engine.js'));
// Keys picked dynamically from the engine's state names.
['vanish', 'vanishing', 'return', 'returning', 'captureLeave', 'captureHold', 'micOn', 'micIdle', 'micWaiting',
  'badgeLive', 'badgeGone', 'testStart', 'testStop'].forEach((k) => used.add(k));

let bad = 0;
for (const loc of fs.readdirSync(path.join(root, '_locales'))) {
  const msgs = JSON.parse(read(`_locales/${loc}/messages.json`));
  for (const k of used) {
    if (!msgs[k]) {
      console.log(`missing ${loc}: ${k}`);
      bad++;
    }
  }
}
console.log(`${used.size} keys checked${bad ? `, ${bad} missing` : ', all present'}`);
process.exit(bad ? 1 : 0);
