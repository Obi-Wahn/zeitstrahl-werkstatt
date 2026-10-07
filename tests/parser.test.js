/*
 * Tests für den Parser. Ausführen mit:  node tests/parser.test.js
 * (Gut geeignet, um im Informatikunterricht über Testfälle zu sprechen.)
 */
'use strict';

const assert = require('node:assert/strict');
const P = require('../js/parser.js');

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
  const { items, problems } = P.parseSource('1555; Augsburger Religionsfrieden; Politik; Text mit | Strich', NOW);
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

test('„|“ ist kein Trenner, sondern ein normales Zeichen', () => {
  const { items } = P.parseSource('1521; Worms | Reichstag; Politik', NOW);
  assert.equal(items[0].title, 'Worms | Reichstag');
  assert.equal(items[0].cat, 'Politik');
});

test('buildLine macht aus Semikolons in Titel und Kategorie Kommas', () => {
  assert.equal(P.buildLine({ datum: '1517', titel: 'A; B', kategorie: 'X;Y', beschreibung: 'c; d' }), '1517; A, B; X,Y; c; d');
  assert.equal(P.buildLine({ datum: '1517', titel: 'A', kategorie: '', beschreibung: '' }), '1517; A; Allgemein');
});

test('Kommentare und Leerzeilen werden übersprungen', () => {
  const { items } = P.parseSource('# Notiz\n\n1517; Thesen', NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].line, 2);
});

test('fehlender Titel wird mit Zeilennummer gemeldet', () => {
  const { problems } = P.parseSource('1517; Thesen\n1521', NOW);
  assert.equal(problems[0].line, 1);
});

test('Zusatzangaben {bild:…} {von:…} {quelle:…}', () => {
  const { items } = P.parseSource('1648; Westfälischer Friede; Politik; Text {von:Lena} {quelle:Wikimedia} {bild:b12}', NOW);
  assert.equal(items[0].img, 'b12');
  assert.equal(items[0].von, 'Lena');
  assert.equal(items[0].quelle, 'Wikimedia');
  assert.equal(items[0].desc, 'Text');
});

test('buildLine macht Formulartext zeilentauglich', () => {
  const line = P.buildLine({ datum: '1517', titel: 'A | B', kategorie: '', beschreibung: 'Zeile 1\nZeile 2 {x}', von: 'Tom', bild: 'b1' });
  assert.equal(line, '1517; A | B; Allgemein; Zeile 1 Zeile 2 x {von:Tom} {bild:b1}');
  const back = P.parseSource(line, NOW).items[0];
  assert.equal(back.title, 'A | B');
  assert.equal(back.img, 'b1');
});

test('eigene Kategorien bekommen verschiedene Farben', () => {
  const { cats } = P.parseSource('1517; A; Mönche\n1518; B; Städte\n1519; C; Religion', NOW);
  const ci = cats.map((c) => c.ci);
  assert.equal(new Set(ci).size, 3);
  assert.equal(cats.find((c) => c.key === 'religion').ci, 2);
});

test('vorgegebene Kategorien haben in jedem Zeitstrahl dieselbe Farbe', () => {
  const vorgabe = ['Bauwerke', 'Politik', 'Sport', 'Krieg'];
  const farbe = (src, key) => P.parseSource(src, NOW, vorgabe).cats.find((c) => c.key === key).ci;
  // Eine Gruppe benutzt alle, die andere nur Sport: Sport bleibt gleich
  assert.equal(farbe('1517; A; Politik\n1600; B; Bauwerke\n1700; C; Sport', 'sport'), farbe('1700; C; Sport', 'sport'));
  assert.equal(farbe('1700; C; Politik', 'politik'), 1, 'feste Farbe bleibt');
  const map = P.presetColors(vorgabe);
  assert.equal(new Set(map.values()).size, 4, 'Krieg passt zu Politik, bekommt aber eine eigene Farbe');
  // Eigene Kategorie daneben nimmt keine Farbe der Vorgabe
  const { cats } = P.parseSource('1517; A; Mönche', NOW, vorgabe);
  assert.ok(![...map.values()].includes(cats[0].ci));
});

test('acht vorgegebene Kategorien bekommen acht Farben', () => {
  const map = P.presetColors(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.equal(new Set(map.values()).size, 8);
});

console.log('Texte');

test('vor … Jahren', () => {
  const it = P.parseSource('1517; Thesen', NOW).items[0];
  assert.equal(P.agoText(it, NOW), 'vor 509 Jahren');
  const bc = P.parseSource('44 v. Chr.; Caesar', NOW).items[0];
  assert.equal(P.agoText(bc, NOW), 'vor 2069 Jahren');
});

test('Dauer eines Zeitraums', () => {
  const it = P.parseSource('1618–1648; Krieg', NOW).items[0];
  assert.equal(P.durationText(it), '30 Jahre');
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

test('Spalten in anderer Reihenfolge, Senkrechtstrich bleibt', () => {
  const csv = 'Titel\tJahr\tNotiz\nAugsburger Religionsfriede\t1555\tcuius regio | eius religio\n';
  assert.equal(P.tableToSource(csv), '1555; Augsburger Religionsfriede; Allgemein; cuius regio | eius religio\n');
});

test('Zeilenumbruch in einer Zelle und leere Zeilen', () => {
  const csv = 'Datum;Titel\n;\n1530;"Confessio\nAugustana"\n\n';
  assert.equal(P.tableToSource(csv), '1530; Confessio Augustana; Allgemein\n');
  assert.equal(P.parseSource(P.tableToSource(csv), NOW).items.length, 1);
});

console.log(`\n${passed} Tests bestanden.`);
