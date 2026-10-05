/*
 * Tests für die Wahl des gespeicherten Stands beim Start. Ausführen mit:  node tests/stand.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const Stand = require('../js/stand.js');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('FEHLER ' + name);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

const tl = (name) => ({ activeId: 'a', timelines: [{ id: 'a', name, source: '', images: {} }] });
const browser = tl('Erster Weltkrieg'); // alter Stand aus früheren Tests
const ordner = tl('Weimarer Republik');

(async () => {
  await test('Mit Server und leerem Ordner daten: leer starten, alter Browserstand zählt nicht', async () => {
    const d = await Stand.waehlen({ serverAn: true, lehrerPc: false, ladeServer: async () => null, ladeBrowser: async () => browser });
    assert.equal(d, null);
  });

  await test('Mit Server gilt der Ordner daten', async () => {
    const d = await Stand.waehlen({ serverAn: true, lehrerPc: false, ladeServer: async () => ordner, ladeBrowser: async () => browser });
    assert.equal(d, ordner);
  });

  await test('Antwortet der Server nicht, hilft am Laptop der Browser aus', async () => {
    const d = await Stand.waehlen({ serverAn: true, lehrerPc: false, ladeServer: async () => undefined, ladeBrowser: async () => browser });
    assert.equal(d, browser);
  });

  await test('Am Lehrer-PC nie den Browserstand nehmen', async () => {
    const d = await Stand.waehlen({ serverAn: true, lehrerPc: true, ladeServer: async () => undefined, ladeBrowser: async () => browser });
    assert.equal(d, null);
  });

  await test('Ohne Server gilt der Browser', async () => {
    let gefragt = false;
    const d = await Stand.waehlen({ serverAn: false, lehrerPc: false, ladeServer: async () => { gefragt = true; return ordner; }, ladeBrowser: async () => browser });
    assert.equal(d, browser);
    assert.equal(gefragt, false);
  });

  console.log(`\n${passed} Tests bestanden.`);
})();
