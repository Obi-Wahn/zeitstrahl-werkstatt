/*
 * Tests für Layout und Zeichnen. Ausführen mit:  node tests/layout.test.js
 * Die Textbreite wird hier grob geschätzt (Zeichenzahl mal Schriftgröße),
 * damit die Tests ohne Browser laufen.
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

const measure = (text, weight, size) => text.length * size * 0.55;
const opts = (extra) => Object.assign({ scale: 1, family: 'x', measure }, extra);
const items = (src) => P.parseSource(src, NOW).items;
const PAINT = { ink: '#111', soft: '#666', grid: '#ddd', sheet: '#fff', accent: '#c00', cat: () => '#08f' };

// Fähnchen auf derselben Seite der Achse und in derselben Spur dürfen sich nicht überdecken
const box = (e) => (e.flip ? [e.x - e.w, e.x] : [e.x, e.x + e.w]);
function assertNoOverlap(g) {
  for (const a of g.evs) {
    for (const b of g.evs) {
      // Ein mehrzeiliges Fähnchen belegt die Spuren lane bis lane + n − 1
      if (a === b || a.below !== b.below || a.lane + a.n <= b.lane || b.lane + b.n <= a.lane) continue;
      const [al, ar] = box(a);
      const [bl, br] = box(b);
      assert.ok(ar <= bl || br <= al, `${a.it.title} überdeckt ${b.it.title}`);
    }
  }
}

// Immer gleiche „Zufallszahlen“, damit ein Fehler sich wiederholen lässt
function zufall(seed) {
  let x = seed;
  return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
}

console.log('Skala');

test('Skala kennt kein Jahr 0, zeigt aber Christi Geburt', () => {
  const view = { v0: -300, v1: 300 };
  const X = (t) => (t - view.v0) * 2;
  const ticks = L.makeTicks(view, 1200, X, L.metricsFor(1), measure, 'x');
  const labels = ticks.major.map((t) => t.label);
  assert.ok(labels.includes('Chr. Geb.'));
  assert.ok(labels.includes('100 v. Chr.'));
  assert.ok(!labels.includes('0'));
});

test('Jahreszahlen der Skala überdecken sich nicht', () => {
  for (const [v0, v1] of [[1500, 1540], [1450, 1650], [-3000, 2026], [1914, 1918]]) {
    const view = { v0, v1 };
    const X = (t) => (t - v0) * (1200 / (v1 - v0));
    const major = L.makeTicks(view, 1200, X, L.metricsFor(1), measure, 'x').major;
    for (let i = 1; i < major.length; i++) {
      const gap = major[i].x - major[i - 1].x;
      assert.ok(gap >= (major[i].w + major[i - 1].w) / 2, `${major[i - 1].label} und ${major[i].label} bei ${v0} bis ${v1}`);
    }
  }
});

test('Stark vergrößert zeigt die Skala Monate mit Jahreszahl', () => {
  const view = { v0: 1517.5, v1: 1518.5 };
  const X = (t) => (t - view.v0) * 1200;
  const labels = L.makeTicks(view, 1200, X, L.metricsFor(1), measure, 'x').major.map((t) => t.label);
  assert.ok(labels.includes('1518'), labels.join(', '));
  assert.ok(labels.some((l) => /^(Juli|Aug\.|Sep\.|Okt\.) 1517$/.test(l)), 'erste Marke ohne Jahr: ' + labels[0]);
});

console.log('Ereignisse');

test('Spuren verhindern Überlappungen', () => {
  const g = L.layout(items('1517; Ein langer Titel A\n1518; Ein langer Titel B\n1519; Ein langer Titel C'), { v0: 1500, v1: 1540 }, 800, opts());
  assertNoOverlap(g);
});

test('dichte Ereignisse verteilen sich auf beide Seiten der Achse', () => {
  const src = Array.from({ length: 8 }, (_, i) => `${1517 + i * 3}; Ein recht langer Titel ${i}`).join('\n');
  const g = L.layout(items(src), { v0: 1450, v1: 1650 }, 1200, opts());
  assertNoOverlap(g);
  assert.ok(g.evs.some((e) => e.below) && g.evs.some((e) => !e.below));
  // Auf zwei Seiten reicht höchstens die Hälfte der Spuren
  const up = new Set(g.evs.filter((e) => !e.below).map((e) => e.lane)).size;
  const down = new Set(g.evs.filter((e) => e.below).map((e) => e.lane)).size;
  assert.ok(Math.max(up, down) <= 4);
});

test('Fähnchen am Rand ragen nicht aus dem Bild', () => {
  const g = L.layout(items('1449; Ein langer Titel am Anfang\n1649; Ein langer Titel am Ende'), { v0: 1448, v1: 1650 }, 800, opts());
  for (const e of g.evs) {
    const [l, r] = box(e);
    assert.ok(l >= 0 && r <= 800, e.it.title);
  }
});

test('viele zufällige Ereignisse: nichts überdeckt sich, nichts ragt hinaus', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = zufall(seed);
    const src = Array.from({ length: 60 }, (_, i) => `${1801 + Math.floor(r() * 198)}; ${'Titel '.repeat(1 + Math.floor(r() * 4))}${i}`).join('\n');
    const g = L.layout(items(src), { v0: 1800, v1: 2000 }, 1200, opts());
    // Gleiche Jahre stehen gemeinsam in einem Fähnchen, verloren geht keines
    assert.equal(g.evs.reduce((n, e) => n + e.list.length, 0), 60);
    assertNoOverlap(g);
    for (const e of g.evs) {
      const [l, rr] = box(e);
      assert.ok(l >= 0 && rr <= 1200, `${e.it.title} (Durchlauf ${seed})`);
      // Fähnchen oberhalb liegen über der Achse, unterhalb darunter
      assert.ok(e.below ? e.y > g.axisY : e.y < g.axisY, e.it.title);
    }
  }
});

test('Ereignisse außerhalb des Ausschnitts fallen weg', () => {
  const g = L.layout(items('1400; Zu früh\n1520; Drin\n1700; Zu spät'), { v0: 1500, v1: 1540 }, 800, opts());
  assert.deepEqual(g.evs.map((e) => e.it.title), ['Drin']);
});

test('doppelter Maßstab ergibt ein doppelt so großes Bild', () => {
  const list = items('1517; Thesenanschlag\n1521; Reichstag zu Worms\n1524–1526; Bauernkrieg');
  const g1 = L.layout(list, { v0: 1500, v1: 1540 }, 800, opts());
  const g2 = L.layout(list, { v0: 1500, v1: 1540 }, 1600, opts({ scale: 2 }));
  assert.ok(Math.abs(g2.H - 2 * g1.H) < 1, `${g1.H} und ${g2.H}`);
});

console.log('Zeiträume');

test('Zeiträume stehen abgetrennt unter den Ereignissen', () => {
  const g = L.layout(items('1517; A\n1520; B\n1524–1526; Bauernkrieg'), { v0: 1500, v1: 1540 }, 800, opts());
  assert.ok(g.spansZone > g.axisY);
  for (const e of g.evs) assert.ok(e.y < g.spansZone);
  for (const sp of g.sps) assert.ok(sp.y > g.spansZone);
});

test('Zeiträume und ihre Beschriftungen überdecken sich nicht', () => {
  const g = L.layout(items([
    '1517–1555; Reformation',
    '1524–1526; Bauernkrieg',
    '1530–1531; Augsburger Reichstag',
    '1546–1547; Schmalkaldischer Krieg',
    '1538–1539; Ein sehr langer Name für einen kurzen Zeitraum',
  ].join('\n')), { v0: 1500, v1: 1560 }, 800, opts());
  assert.equal(g.sps.length, 5);
  const area = (sp) => [Math.min(sp.x0, sp.labelX), Math.max(sp.x1, sp.labelX + sp.tW + 7 + sp.dW)];
  for (const a of g.sps) {
    // Die Beschriftung bleibt im Bild
    assert.ok(a.labelX >= 0 && a.labelX + a.tW + 7 + a.dW <= 800, a.it.title);
    for (const b of g.sps) {
      if (a === b || a.lane !== b.lane) continue;
      const [al, ar] = area(a);
      const [bl, br] = area(b);
      assert.ok(ar <= bl || br <= al, `${a.it.title} überdeckt ${b.it.title}`);
    }
  }
});

test('ohne Zeiträume gibt es keinen Bereich dafür', () => {
  const g = L.layout(items('1517; A'), { v0: 1500, v1: 1540 }, 800, opts());
  assert.equal(g.spansZone, null);
  assert.equal(g.sps.length, 0);
});

console.log('Gleiches Datum');

test('Ereignisse mit gleichem Datum teilen sich ein Fähnchen', () => {
  const g = L.layout(items('9.11.1918; Thronverzicht\n9.11.1918; Ausrufung der Republik\n11.11.1918; Waffenstillstand\n1918; Nur das Jahr'), { v0: 1917, v1: 1920 }, 1200, opts());
  assert.equal(g.evs.length, 3);
  const pair = g.evs.find((e) => e.list.length === 2);
  assert.deepEqual(pair.list.map((it) => it.title), ['Thronverzicht', 'Ausrufung der Republik']);
  assert.ok(pair.h > g.M.pillH);
  // Das Datum steht einmal, beide Titel sind einzeln anklickbar
  const svg = L.svgBody(g, PAINT, { interactive: true });
  assert.equal(svg.split('>9.11.1918<').length - 1, 1);
  assert.ok(svg.includes(`data-id="${pair.list[0].id}"`) && svg.includes(`data-id="${pair.list[1].id}"`));
});

test('mehrzeilige Fähnchen überdecken keine anderen', () => {
  const src = [];
  for (let i = 0; i < 12; i++) src.push(`${1900 + (i % 4)}; Ereignis Nummer ${i}`);
  const g = L.layout(items(src.join('\n')), { v0: 1895, v1: 1910 }, 900, opts());
  assert.equal(g.evs.length, 4);
  assertNoOverlap(g);
});

console.log('Achsenbruch');

const DICHT = [
  '1871; Reichsgründung', '1890; Bismarck', '1904; Entente', '1914–1918; Krieg', '1917; USA', '1918; Revolution',
  '1919; Versailles', '1923; Krise', '1933; NS', '1984; Kohl und Mitterrand', '2015; Gallipoli',
].join('\n');

test('lange leere Zeiten werden gestaucht, der Rest bleibt maßstabsgetreu', () => {
  const list = items(DICHT);
  const w = L.makeWarp(list);
  assert.equal(w.breaks.length, 2);
  for (const t of [1871, 1900, 1918.5, 1950, 1990, 2015]) assert.ok(Math.abs(w.inv(w.f(t)) - t) < 1e-9, String(t));
  // Zwischen 1871 und 1933 kein Bruch: Abstände bleiben gleich
  assert.ok(Math.abs((w.f(1933) - w.f(1918)) - 15) < 1e-9);
  // 1933 bis 1984 schrumpft deutlich
  assert.ok(w.f(1984) - w.f(1933) < 25);
  assert.ok(!w.inBreak(1933) && !w.inBreak(1984) && w.inBreak(1960));
});

test('gleichmäßig verteilte Einträge bekommen keinen Bruch', () => {
  const src = [];
  for (let y = 0; y <= 2000; y += 150) src.push(`${y || 1}; Eintrag ${y}`);
  assert.equal(L.makeWarp(items(src.join('\n'))).breaks.length, 0);
  assert.equal(L.makeWarp(items('1517; A\n1918; B')).breaks.length, 0);
});

test('Skala und Zeichnung mit Achsenbruch', () => {
  const list = items(DICHT);
  const warp = L.makeWarp(list);
  const view = { v0: warp.f(1865), v1: warp.f(2020) };
  const g = L.layout(list, view, 1200, opts({ warp }));
  assert.equal(g.breaks.length, 2);
  // Keine Jahreszahl im gestauchten Bereich, die Zahlen überdecken sich nicht
  for (const t of g.ticks.major) assert.ok(!g.breaks.some((b) => t.x > b.x0 && t.x < b.x1), t.label);
  const major = g.ticks.major;
  for (let i = 1; i < major.length; i++) assert.ok(major[i].x - major[i - 1].x >= (major[i].w + major[i - 1].w) / 2, major[i].label);
  // Jedes Ereignis steht an seiner gestauchten Stelle
  const e = g.evs.find((x) => x.it.title === 'Kohl und Mitterrand');
  assert.ok(Math.abs(e.x - (warp.f(1984) - view.v0) * 1200 / (view.v1 - view.v0)) < 1e-6);
  assert.ok(L.svgBody(g, PAINT, {}).includes('<polygon'));
});

console.log('Lupe');

const LUPE_SRC = [
  '# Lupe: 1914–1918', '1871; Reichsgründung', '1890; Bismarck', '28.6.1914; Sarajevo', '1916; Verdun',
  '9.11.1918; Republik', '1914–1918; Erster Weltkrieg', '1919; Versailles', '1933; NS', '1879–1918; Zweibund',
].join('\n');

test('Lupe zeigt den Abschnitt vergrößert, oben bleiben nur Punkte', () => {
  const { items: list, lupe } = P.parseSource(LUPE_SRC, NOW);
  assert.deepEqual([lupe.start, lupe.end], [1914, 1919]); // 1918 gehört ganz dazu
  const g = L.layout(list, { v0: 1865, v1: 1940 }, 1200, opts({ lupe }));
  assert.ok(g.lupe);
  const oben = g.evs.flatMap((e) => e.list.map((it) => it.title));
  assert.deepEqual(oben.sort(), ['Bismarck', 'NS', 'Reichsgründung', 'Versailles']);
  assert.deepEqual(g.dots.map((d) => d.it.title), ['Sarajevo', 'Verdun', 'Republik']);
  // Der Weltkrieg passt ganz hinein, der Zweibund nicht
  assert.deepEqual(g.sps.map((sp) => sp.it.title), ['Zweibund']);
  assert.deepEqual(g.lupe.g.sps.map((sp) => sp.it.title), ['Erster Weltkrieg']);
  assert.equal(g.lupe.g.evs.length, 3);
  assert.ok(g.lupe.y > g.H0 && g.H > g.lupe.y + g.lupe.g.H);
  const svg = L.svgBody(g, PAINT, { interactive: true });
  assert.ok(svg.includes('>Sarajevo<') && svg.includes('data-id="L3"'));
});

test('Vorschlag für die Lupe: der dichteste Abschnitt', () => {
  const src = ['1871; A', '1890; B', '1914; C', '1915; D', '1916; E', '1917; F', '1918; G', '1933; H', '1984; I', '2015; J', '1914–1918; Krieg'].join('\n');
  const d = L.densest(items(src));
  assert.deepEqual([d.first.title, d.last.title, d.count], ['C', 'G', 5]);
  assert.equal(L.densest(items('1517; A\n1521; B\n1525; C')), null);
});

test('ohne Lupe, wenn hineingezoomt oder der Abschnitt nicht zu sehen ist', () => {
  const { items: list, lupe } = P.parseSource(LUPE_SRC, NOW);
  assert.equal(L.layout(list, { v0: 1913, v1: 1920 }, 1200, opts({ lupe })).lupe, null);
  assert.equal(L.layout(list, { v0: 1860, v1: 1900 }, 1200, opts({ lupe })).lupe, null);
});

test('fehlerhafte Lupe wird gemeldet', () => {
  const r = P.parseSource('# Lupe: irgendwann\n1517; A', NOW);
  assert.equal(r.lupe, null);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].line, 0);
});

console.log('SVG');

test('Titel werden im SVG sicher dargestellt', () => {
  const g = L.layout(items('1517; <script>alert(1)</script> & "Luther"'), { v0: 1500, v1: 1540 }, 800, opts());
  const svg = L.svgBody(g, PAINT, { interactive: true });
  assert.ok(!svg.includes('<script'));
  assert.ok(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Luther&quot;'));
});

test('Lückenbild zeigt Daten, aber keine Titel', () => {
  const list = items('1517; Thesenanschlag\n1524–1526; Bauernkrieg');
  const g = L.layout(list, { v0: 1500, v1: 1540 }, 800, opts());
  const svg = L.svgBody(g, PAINT, { blank: true });
  assert.ok(svg.includes('1517') && svg.includes('1524–1526'));
  assert.ok(!svg.includes('Thesenanschlag') && !svg.includes('Bauernkrieg'));
});

test('Lückenbild hat dieselbe Anordnung wie das Bild', () => {
  const list = items('1517; Thesenanschlag\n1521; Reichstag zu Worms\n1522; Wartburg\n1524–1526; Bauernkrieg\n1530; Augsburger Bekenntnis');
  const g = L.layout(list, { v0: 1510, v1: 1535 }, 500, opts());
  const rects = (svg) => svg.match(/<rect [^>]*>/g).join('\n');
  assert.equal(rects(L.svgBody(g, PAINT, { blank: true })), rects(L.svgBody(g, PAINT, {})));
});

test('„heute“ erscheint nur, wenn es im Ausschnitt liegt', () => {
  const g = L.layout(items('2000; A'), { v0: 1990, v1: 2030 }, 800, opts());
  assert.ok(L.svgBody(g, PAINT, { todayPos: 2026.75 }).includes('>heute<'));
  assert.ok(!L.svgBody(g, PAINT, { todayPos: 2050 }).includes('>heute<'));
});

test('Seite A4 quer: Titel, Verfasser, Zeitraum und Lückenbild', () => {
  const src = '1517; Thesenanschlag; Religion\n1521; Reichstag zu Worms; Politik';
  const { items: list, cats } = P.parseSource(src, NOW);
  const o = { title: 'Luthers <Weg>', von: 'Lena und Tom', measure, day: '7.10.2026' };
  const page = L.pageSvg(list, { v0: 1510, v1: 1530 }, cats, o);
  assert.equal(page.w, 2800);
  assert.ok(page.markup.includes('Luthers &lt;Weg&gt;'));
  assert.ok(page.markup.includes('Erstellt von Lena und Tom · 2 Einträge · 1517 bis 1521'));
  assert.ok(page.markup.includes('>Religion<') && page.markup.includes('>Politik<'));
  const blank = L.pageSvg(list, { v0: 1510, v1: 1530 }, cats, { ...o, blank: true }).markup;
  assert.ok(blank.includes('Name: ') && !blank.includes('Thesenanschlag'));
});

console.log(`\n${passed} Tests bestanden.`);
