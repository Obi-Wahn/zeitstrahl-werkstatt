/*
 * Tests für die ZIP-Dateien. Ausführen mit:  node tests/zip.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const Z = require('../js/zip.js');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('FEHLER ' + name);
    console.error(err.message);
    process.exitCode = 1;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

(async () => {
  console.log('ZIP-Dateien');

  await test('Prüfsumme', () => {
    assert.equal(Z.crc32(enc.encode('123456789')), 0xCBF43926);
  });

  await test('Packen und wieder lesen, mit Umlauten im Namen', async () => {
    const files = [
      { name: 'weimarer-republik.json', data: enc.encode('{"a":1}') },
      { name: 'kirchengeschichte-im-überblick.json', data: enc.encode('x'.repeat(5000)) },
    ];
    const back = await Z.lesen(Z.erstellen(files, new Date(2026, 9, 5, 8, 30)));
    assert.deepEqual(back.map((f) => f.name), files.map((f) => f.name));
    assert.equal(dec.decode(back[0].data), '{"a":1}');
    assert.equal(back[1].data.length, 5000);
  });

  await test('Gepackte Datei (wie von Windows oder macOS) lesen', async () => {
    // Von Hand gebaute ZIP-Datei mit einem verkleinerten Eintrag
    const data = enc.encode('{"timelines":[]}'.repeat(50));
    const packed = zlib.deflateRawSync(data);
    const zip = Z.erstellen([{ name: 'ordner/sicherung.json', data: packed }]);
    // Verfahren auf „deflate“ (8) und Originalgröße setzen
    const v = new DataView(zip.buffer);
    const central = zip.length - 22 - (46 + 'ordner/sicherung.json'.length);
    v.setUint16(8, 8, true);
    v.setUint16(central + 10, 8, true);
    v.setUint32(central + 24, data.length, true);
    const back = await Z.lesen(zip);
    assert.equal(back[0].name, 'ordner/sicherung.json');
    assert.equal(dec.decode(back[0].data), dec.decode(data));
  });

  await test('Keine ZIP-Datei', async () => {
    await assert.rejects(Z.lesen(enc.encode('Hallo')), /Keine gültige ZIP-Datei/);
  });

  console.log(`\n${passed} Tests bestanden.`);
})();
