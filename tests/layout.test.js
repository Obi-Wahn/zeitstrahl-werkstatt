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
const opts = (extra) => Object.assign({ scale: 1, family: 'x', measure, blank: false }, extra);
const items = (src) => P.parseSource(src, NOW).items;
const PAINT = { ink: '#111', soft: '#666', grid: '#ddd', sheet: '#fff', accent: '#c00', cat: () => '#08f' };

// Fähnchen auf derselben Seite der Achse und in derselben Spur dürfen sich nicht überdecken
const box = (e) => (e.flip ? [e.x - e.w, e.x] : [e.x, e.x + e.w]);
function assertNoOverlap(g) {
  for (const a of g.evs) {
    for (const b of g.evs) {
      if (a === b || a.below !== b.below || a.lane !== b.lane) continue;
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
  const g = L.layout(items('1517 | Ein langer Titel A\n1518 | Ein langer Titel B\n1519 | Ein langer Titel C'), { v0: 1500, v1: 1540 }, 800, opts());
  assertNoOverlap(g);
});

test('dichte Ereignisse verteilen sich auf beide Seiten der Achse', () => {
  const src = Array.from({ length: 8 }, (_, i) => `${1517 + i * 3} | Ein recht langer Titel ${i}`).join('\n');
  const g = L.layout(items(src), { v0: 1450, v1: 1650 }, 1200, opts());
  assertNoOverlap(g);
  assert.ok(g.evs.some((e) => e.below) && g.evs.some((e) => !e.below));
  // Auf zwei Seiten reicht höchstens die Hälfte der Spuren
  const up = new Set(g.evs.filter((e) => !e.below).map((e) => e.lane)).size;
  const down = new Set(g.evs.filter((e) => e.below).map((e) => e.lane)).size;
  assert.ok(Math.max(up, down) <= 4);
});

test('Fähnchen am Rand ragen nicht aus dem Bild', () => {
  const g = L.layout(items('1449 | Ein langer Titel am Anfang\n1649 | Ein langer Titel am Ende'), { v0: 1448, v1: 1650 }, 800, opts());
  for (const e of g.evs) {
    const [l, r] = box(e);
    assert.ok(l >= 0 && r <= 800, e.it.title);
  }
});

test('viele zufällige Ereignisse: nichts überdeckt sich, nichts ragt hinaus', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = zufall(seed);
    const src = Array.from({ length: 60 }, (_, i) => `${1801 + Math.floor(r() * 198)} | ${'Titel '.repeat(1 + Math.floor(r() * 4))}${i}`).join('\n');
    const g = L.layout(items(src), { v0: 1800, v1: 2000 }, 1200, opts());
    assert.equal(g.evs.length, 60);
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
  const g = L.layout(items('1400 | Zu früh\n1520 | Drin\n1700 | Zu spät'), { v0: 1500, v1: 1540 }, 800, opts());
  assert.deepEqual(g.evs.map((e) => e.it.title), ['Drin']);
});

test('doppelter Maßstab ergibt ein doppelt so großes Bild', () => {
  const list = items('1517 | Thesenanschlag\n1521 | Reichstag zu Worms\n1524–1526 | Bauernkrieg');
  const g1 = L.layout(list, { v0: 1500, v1: 1540 }, 800, opts());
  const g2 = L.layout(list, { v0: 1500, v1: 1540 }, 1600, opts({ scale: 2 }));
  assert.ok(Math.abs(g2.H - 2 * g1.H) < 1, `${g1.H} und ${g2.H}`);
});

console.log('Zeiträume');

test('Zeiträume stehen abgetrennt unter den Ereignissen', () => {
  const g = L.layout(items('1517 | A\n1520 | B\n1524–1526 | Bauernkrieg'), { v0: 1500, v1: 1540 }, 800, opts());
  assert.ok(g.spansZone > g.axisY);
  for (const e of g.evs) assert.ok(e.y < g.spansZone);
  for (const sp of g.sps) assert.ok(sp.y > g.spansZone);
});

test('Zeiträume und ihre Beschriftungen überdecken sich nicht', () => {
  const g = L.layout(items([
    '1517–1555 | Reformation',
    '1524–1526 | Bauernkrieg',
    '1530–1531 | Augsburger Reichstag',
    '1546–1547 | Schmalkaldischer Krieg',
    '1538–1539 | Ein sehr langer Name für einen kurzen Zeitraum',
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
  const g = L.layout(items('1517 | A'), { v0: 1500, v1: 1540 }, 800, opts());
  assert.equal(g.spansZone, null);
  assert.equal(g.sps.length, 0);
});

console.log('SVG');

test('Titel werden im SVG sicher dargestellt', () => {
  const g = L.layout(items('1517 | <script>alert(1)</script> & "Luther"'), { v0: 1500, v1: 1540 }, 800, opts());
  const svg = L.svgBody(g, PAINT, { interactive: true });
  assert.ok(!svg.includes('<script'));
  assert.ok(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Luther&quot;'));
});

test('Lückenbild zeigt Daten, aber keine Titel', () => {
  const list = items('1517 | Thesenanschlag\n1524–1526 | Bauernkrieg');
  const g = L.layout(list, { v0: 1500, v1: 1540 }, 800, opts({ blank: true }));
  const svg = L.svgBody(g, PAINT, { blank: true });
  assert.ok(svg.includes('1517') && svg.includes('1524–1526'));
  assert.ok(!svg.includes('Thesenanschlag') && !svg.includes('Bauernkrieg'));
});

test('„heute“ erscheint nur, wenn es im Ausschnitt liegt', () => {
  const g = L.layout(items('2000 | A'), { v0: 1990, v1: 2030 }, 800, opts());
  assert.ok(L.svgBody(g, PAINT, { todayPos: 2026.75 }).includes('>heute<'));
  assert.ok(!L.svgBody(g, PAINT, { todayPos: 2050 }).includes('>heute<'));
});

console.log(`\n${passed} Tests bestanden.`);
