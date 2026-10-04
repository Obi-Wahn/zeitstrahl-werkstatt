/*
 * Tests für den Parser. Ausführen mit:  node tests/parser.test.js
 * (Gut geeignet, um im Informatikunterricht über Testfälle zu sprechen.)
 */
'use strict';

const assert = require('node:assert/strict');
const P = require('../js/parser.js');
const L = require('../js/layout.js');

const NOW = new Date(2026, 9, 4); // 4. Oktober 2026
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('FEHLER ' + name);
    console.error(err.message);
    process.exitCode = 1;
  }
}

console.log('Datumsangaben');

test('Jahr', () => {
  const r = P.parseDateField('1517', NOW);
  assert.equal(r.kind, 'point');
  assert.equal(r.start, 1517);
});

test('Tag.Monat.Jahr', () => {
  const r = P.parseDateField('31.10.1517', NOW);
  assert.equal(P.fmtLong(r.a), '31. Oktober 1517');
  assert.ok(r.start > 1517.8 && r.start < 1517.9);
});

test('Monat ausgeschrieben', () => {
  const r = P.parseDateField('9. November 1918', NOW);
  assert.equal(r.a.d, 9);
  assert.equal(r.a.m, 11);
  assert.equal(P.parseDateField('September 1522', NOW).a.m, 9);
  assert.equal(P.parseDateField('Okt. 1517', NOW).a.m, 10);
});

test('vor Christus (ohne Jahr 0)', () => {
  const r = P.parseDateField('44 v. Chr.', NOW);
  assert.equal(r.a.bc, true);
  assert.equal(r.start, -43);
  assert.equal(P.fmtShort(r.a), '44 v. Chr.');
  assert.equal(P.parseDateField('-44', NOW).start, -43);
});

test('Jahr 0 wird abgelehnt', () => {
  const r = P.parseDateField('0', NOW);
  assert.match(r.error, /Jahr 0/);
});

test('ungefähre Angabe', () => {
  const r = P.parseDateField('um 1450', NOW);
  assert.equal(r.a.approx, true);
  assert.equal(P.fmtShort(r.a), 'um 1450');
  assert.equal(P.parseDateField('ca. 30', NOW).a.approx, true);
});

test('Zeiträume in allen Schreibweisen', () => {
  for (const s of ['1618–1648', '1618-1648', '1618 - 1648', '1618 bis 1648']) {
    const r = P.parseDateField(s, NOW);
    assert.equal(r.kind, 'span', s);
    assert.equal(r.end - r.start, 30, s);
  }
});

test('Zeitraum über Christi Geburt hinweg', () => {
  const r = P.parseDateField('44 v. Chr. – 14 n. Chr.', NOW);
  assert.equal(r.end - r.start, 57);
});

test('„v. Chr.“ am Ende gilt für beide Jahre', () => {
  const r = P.parseDateField('7–4 v. Chr.', NOW);
  assert.equal(r.a.bc, true);
  assert.equal(r.end - r.start, 3);
});

test('bis heute', () => {
  const r = P.parseDateField('1800–heute', NOW);
  assert.equal(r.b.today, true);
  assert.equal(P.fmtShort(r.b), 'heute');
});

test('Ende vor Anfang wird gemeldet', () => {
  assert.match(P.parseDateField('1648–1618', NOW).error, /vor dem Anfang/);
});

test('Unsinn wird gemeldet', () => {
  assert.match(P.parseDateField('irgendwann', NOW).error, /nicht erkannt/);
});

console.log('Zeilen');

test('ganze Zeile mit Kategorie und Beschreibung', () => {
  const { items, problems } = P.parseSource('1555 | Augsburger Religionsfrieden | Politik | Text mit | Strich', NOW);
  assert.equal(problems.length, 0);
  assert.equal(items[0].title, 'Augsburger Religionsfrieden');
  assert.equal(items[0].ci, 1);
  assert.equal(items[0].desc, 'Text mit | Strich');
});

test('Kommentare und Leerzeilen werden übersprungen', () => {
  const { items } = P.parseSource('# Notiz\n\n1517 | Thesen', NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].line, 2);
});

test('fehlender Titel wird mit Zeilennummer gemeldet', () => {
  const { problems } = P.parseSource('1517 | Thesen\n1521', NOW);
  assert.equal(problems[0].line, 1);
});

test('Zusatzangaben {bild:…} {von:…} {quelle:…}', () => {
  const { items } = P.parseSource('1648 | Westfälischer Friede | Politik | Text {von:Lena} {quelle:Wikimedia} {bild:b12}', NOW);
  assert.equal(items[0].img, 'b12');
  assert.equal(items[0].von, 'Lena');
  assert.equal(items[0].quelle, 'Wikimedia');
  assert.equal(items[0].desc, 'Text');
});

test('buildLine macht Formulartext zeilentauglich', () => {
  const line = P.buildLine({ datum: '1517', titel: 'A | B', kategorie: '', beschreibung: 'Zeile 1\nZeile 2 {x}', von: 'Tom', bild: 'b1' });
  assert.equal(line, '1517 | A / B | Allgemein | Zeile 1 Zeile 2 x {von:Tom} {bild:b1}');
  const back = P.parseSource(line, NOW).items[0];
  assert.equal(back.title, 'A / B');
  assert.equal(back.img, 'b1');
});

test('eigene Kategorien bekommen verschiedene Farben', () => {
  const { cats } = P.parseSource('1517 | A | Mönche\n1518 | B | Städte\n1519 | C | Religion', NOW);
  const ci = cats.map((c) => c.ci);
  assert.equal(new Set(ci).size, 3);
  assert.equal(cats.find((c) => c.key === 'religion').ci, 2);
});

console.log('Texte');

test('vor … Jahren', () => {
  const it = P.parseSource('1517 | Thesen', NOW).items[0];
  assert.equal(P.agoText(it, NOW), 'vor 509 Jahren');
  const bc = P.parseSource('44 v. Chr. | Caesar', NOW).items[0];
  assert.equal(P.agoText(bc, NOW), 'vor 2069 Jahren');
});

test('Dauer eines Zeitraums', () => {
  const it = P.parseSource('1618–1648 | Krieg', NOW).items[0];
  assert.equal(P.durationText(it), '30 Jahre');
});

console.log('Skala');

const measure = (text, weight, size) => text.length * size * 0.55;

test('Skala kennt kein Jahr 0, zeigt aber Christi Geburt', () => {
  const view = { v0: -300, v1: 300 };
  const X = (t) => (t - view.v0) * 2;
  const ticks = L.makeTicks(view, 1200, X, L.metricsFor(1), measure, 'x');
  const labels = ticks.major.map((t) => t.label);
  assert.ok(labels.includes('Chr. Geb.'));
  assert.ok(labels.includes('100 v. Chr.'));
  assert.ok(!labels.includes('0'));
});

test('Spuren verhindern Überlappungen', () => {
  const { items } = P.parseSource('1517 | Ein langer Titel A\n1518 | Ein langer Titel B\n1519 | Ein langer Titel C', NOW);
  const g = L.layout(items, { v0: 1500, v1: 1540 }, 800, { scale: 1, family: 'x', measure, blank: false });
  const lanes = new Set(g.evs.map((e) => e.lane));
  assert.equal(lanes.size, 3);
});

console.log(`\n${passed} Tests bestanden.`);
