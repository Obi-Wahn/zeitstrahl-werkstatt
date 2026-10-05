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

test('Jahrhundert wird zum Zeitraum', () => {
  const r = P.parseDateField('15. Jh.', NOW);
  assert.equal(r.kind, 'span');
  assert.equal(r.start, 1401);
  assert.equal(r.end, 1501);
  assert.equal(r.label, '15. Jh.');
});

test('Jahrhundert ausgeschrieben und mit n. Chr.', () => {
  assert.equal(P.parseDateField('15. Jahrhundert', NOW).start, 1401);
  assert.equal(P.parseDateField('13. Jh. n. Chr.', NOW).end, 1301);
});

test('frühes, Mitte und spätes Jahrhundert', () => {
  assert.equal(P.parseDateField('frühes 16. Jh.', NOW).end, 1534);
  assert.equal(P.parseDateField('Mitte 16. Jh.', NOW).start, 1534);
  assert.equal(P.parseDateField('spätes 16. Jh.', NOW).start, 1567);
});

test('Jahrhundert vor Christus zählt rückwärts', () => {
  const r = P.parseDateField('5. Jh. v. Chr.', NOW);
  assert.equal(r.a.y, 500);
  assert.equal(r.b.y, 401);
  assert.equal(r.a.bc, true);
  assert.equal(r.end - r.start, 100);
});

test('Bereich über mehrere Jahrhunderte', () => {
  const r = P.parseDateField('14.–16. Jh.', NOW);
  assert.equal(r.start, 1301);
  assert.equal(r.end, 1601);
  assert.equal(r.label, '14.–16. Jh.');
});

test('Jahrhundert im Zeitstrahl bekommt sein Label', () => {
  const it = P.parseSource('15. Jh.; Buchdruck; Technik', NOW).items[0];
  assert.equal(it.kind, 'span');
  assert.equal(it.shortDate, '15. Jh.');
  assert.match(it.longDate, /15\. Jahrhundert \(1401–1500\)/);
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

test('Semikolon als Trenner, weitere Semikolons bleiben in der Beschreibung', () => {
  const { items, problems } = P.parseSource('1555; Augsburger Religionsfrieden; Politik; Erst Streit; dann Frieden', NOW);
  assert.equal(problems.length, 0);
  assert.equal(items[0].title, 'Augsburger Religionsfrieden');
  assert.equal(items[0].cat, 'Politik');
  assert.equal(items[0].desc, 'Erst Streit; dann Frieden');
});

test('alte Zeilen mit „|“ und Semikolon im Text gelten weiter', () => {
  const { items } = P.parseSource('1517 | Thesen; Anschlag | Religion | A; B\n1521; Worms | Reichstag; Politik', NOW);
  assert.equal(items[0].title, 'Thesen; Anschlag');
  assert.equal(items[0].desc, 'A; B');
  assert.equal(items[1].title, 'Worms | Reichstag');
  assert.equal(items[1].cat, 'Politik');
});

test('buildLine macht aus Semikolons in Titel und Kategorie Kommas', () => {
  assert.equal(P.buildLine({ datum: '1517', titel: 'A; B', kategorie: 'X;Y', beschreibung: 'c; d' }), '1517; A, B; X,Y; c; d');
  assert.equal(P.buildLine({ datum: '1517', titel: 'A', kategorie: '', beschreibung: '' }), '1517; A; Allgemein');
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
  assert.equal(line, '1517; A / B; Allgemein; Zeile 1 Zeile 2 x {von:Tom} {bild:b1}');
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

// Fähnchen auf derselben Seite der Achse und in derselben Spur dürfen sich nicht überdecken
function assertNoOverlap(g) {
  const box = (e) => (e.flip ? [e.x - e.w, e.x] : [e.x, e.x + e.w]);
  for (const a of g.evs) {
    for (const b of g.evs) {
      if (a === b || a.below !== b.below || a.lane !== b.lane) continue;
      const [al, ar] = box(a);
      const [bl, br] = box(b);
      assert.ok(ar <= bl || br <= al, `${a.it.title} überdeckt ${b.it.title}`);
    }
  }
}

test('Spuren verhindern Überlappungen', () => {
  const { items } = P.parseSource('1517 | Ein langer Titel A\n1518 | Ein langer Titel B\n1519 | Ein langer Titel C', NOW);
  const g = L.layout(items, { v0: 1500, v1: 1540 }, 800, { scale: 1, family: 'x', measure, blank: false });
  assertNoOverlap(g);
});

test('dichte Ereignisse verteilen sich auf beide Seiten der Achse', () => {
  const src = Array.from({ length: 8 }, (_, i) => `${1517 + i * 3} | Ein recht langer Titel ${i}`).join('\n');
  const { items } = P.parseSource(src, NOW);
  const g = L.layout(items, { v0: 1450, v1: 1650 }, 1200, { scale: 1, family: 'x', measure, blank: false });
  assertNoOverlap(g);
  assert.ok(g.evs.some((e) => e.below) && g.evs.some((e) => !e.below));
  // Auf zwei Seiten reicht höchstens die Hälfte der Spuren
  const up = new Set(g.evs.filter((e) => !e.below).map((e) => e.lane)).size;
  const down = new Set(g.evs.filter((e) => e.below).map((e) => e.lane)).size;
  assert.ok(Math.max(up, down) <= 4);
});

test('Fähnchen am Rand ragen nicht aus dem Bild', () => {
  const { items } = P.parseSource('1449 | Ein langer Titel am Anfang\n1649 | Ein langer Titel am Ende', NOW);
  const g = L.layout(items, { v0: 1448, v1: 1650 }, 800, { scale: 1, family: 'x', measure, blank: false });
  for (const e of g.evs) {
    const [l, r] = e.flip ? [e.x - e.w, e.x] : [e.x, e.x + e.w];
    assert.ok(l >= 0 && r <= 800, e.it.title);
  }
});

test('Zeiträume stehen abgetrennt unter den Ereignissen', () => {
  const { items } = P.parseSource('1517 | A\n1520 | B\n1524–1526 | Bauernkrieg', NOW);
  const g = L.layout(items, { v0: 1500, v1: 1540 }, 800, { scale: 1, family: 'x', measure, blank: false });
  assert.ok(g.spansZone > g.axisY);
  for (const e of g.evs) assert.ok(e.y < g.spansZone);
  for (const sp of g.sps) assert.ok(sp.y > g.spansZone);
});

console.log('\nTabellen (.csv)');

test('Excel mit Semikolon und Kopfzeile', () => {
  const csv = 'Datum;Ereignis;Kategorie;Beschreibung\r\n1517;Thesenanschlag;Religion;Luther in Wittenberg\r\n1618–1648;Dreißigjähriger Krieg;Politik;\r\n';
  assert.equal(P.tableToSource(csv), '1517; Thesenanschlag; Religion; Luther in Wittenberg\n1618–1648; Dreißigjähriger Krieg; Politik\n');
});

test('Komma, Anführungszeichen und ohne Kopfzeile', () => {
  const csv = '1521,"Reichstag zu Worms",Politik,"Luther widerruft nicht, sagt ""Hier stehe ich"""\n';
  assert.equal(P.tableToSource(csv), '1521; Reichstag zu Worms; Politik; Luther widerruft nicht, sagt "Hier stehe ich"\n');
});

test('Spalten in anderer Reihenfolge, Senkrechtstrich wird ersetzt', () => {
  const csv = 'Titel\tJahr\tNotiz\nAugsburger Religionsfriede\t1555\tcuius regio | eius religio\n';
  assert.equal(P.tableToSource(csv), '1555; Augsburger Religionsfriede; Allgemein; cuius regio / eius religio\n');
});

test('Zeilenumbruch in einer Zelle und leere Zeilen', () => {
  const csv = 'Datum;Titel\n;\n1530;"Confessio\nAugustana"\n\n';
  assert.equal(P.tableToSource(csv), '1530; Confessio Augustana; Allgemein\n');
  assert.equal(P.parseSource(P.tableToSource(csv), NOW).items.length, 1);
});

console.log(`\n${passed} Tests bestanden.`);
