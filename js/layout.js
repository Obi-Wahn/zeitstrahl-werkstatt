/*
 * Zeitstrahl-Werkstatt · Layout und Zeichnen
 *
 * layout()  berechnet aus Einträgen und sichtbarem Zeitraum die Positionen:
 *           Achse, Skalenstriche, Fähnchen (Ereignisse) und Balken (Zeiträume).
 *           Fähnchen stehen ober- oder unterhalb der Achse und zeigen nach rechts
 *           oder links, je nachdem, wo Platz ist. Überlappende Beschriftungen
 *           werden auf "Spuren" verteilt. Die Zeiträume stehen abgetrennt darunter.
 *           Ereignisse mit gleichem Datum teilen sich ein Fähnchen mit mehreren Zeilen.
 * makeWarp() staucht lange Zeiten ohne Einträge zu einem Achsenbruch.
 *           Eine Lupe zeigt einen dichten Abschnitt vergrößert unter dem Zeitstrahl.
 * svgBody() macht daraus SVG-Markup – für den Bildschirm und für den Bild-Export.
 * pageSvg() setzt den Zeitstrahl auf eine Seite A4 quer (Bild sichern und Drucken).
 *
 * Die Textbreiten misst eine von außen übergebene Funktion measure(),
 * damit dieses Modul auch ohne Browser testbar bleibt.
 */
(function (root, factory) {
  // Monatslisten kommen aus dem Parser (im Browser vorher geladen)
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./parser.js'));
  else root.ZeitstrahlLayout = factory(root.ZeitstrahlParser);
})(typeof self !== 'undefined' ? self : this, (Parser) => {
  'use strict';

  const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const { CUM, MONTH_ABBR } = Parser;

  const f = (n) => Math.round(n * 10) / 10;
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  function metricsFor(s) {
    return {
      s,
      laneH: 31 * s,
      pillH: 25 * s,
      rowH: 20 * s, // Zeilenabstand in einem Fähnchen mit mehreren Ereignissen
      labelFont: 15 * s,
      dateFont: 13 * s,
      axisFont: 13 * s,
      tick: 8 * s,
      barH: 10 * s,
      barRow: 33 * s,
      barGap: 6 * s,
      barFont: 14 * s,
      barDate: 12.5 * s,
    };
  }

  const ICON_W = 20; // Platz für das Bild-Symbol (bei Maßstab 1)

  // Die Breiten hängen nie davon ab, ob ein Lückenbild entsteht: Lückenbild und Bild haben
  // dieselbe Anordnung, im Lückenbild steht nur eine Linie an der Stelle des Titels.
  function pointLabelW(it, M, measure, fam) {
    const title = measure(it.title, 700, M.labelFont, fam);
    const icon = it.img ? ICON_W * M.s : 0;
    return 8 * M.s + measure(it.shortDate, 400, M.dateFont, fam) + 7 * M.s + title + icon + 9 * M.s;
  }

  // Breite eines Fähnchens mit mehreren Ereignissen: das Datum steht nur einmal, darunter
  // beginnen die Titel bündig mit dem ersten
  function groupLabelW(list, M, measure, fam) {
    let title = 0;
    for (const it of list) title = Math.max(title, measure(it.title, 700, M.labelFont, fam) + (it.img ? ICON_W * M.s : 0));
    return 8 * M.s + measure(list[0].shortDate, 400, M.dateFont, fam) + 7 * M.s + title + 9 * M.s;
  }

  // Kleines Bild-Symbol (Rahmen mit Berg und Sonne)
  function imageIcon(x, cy, s, color) {
    const w = 13 * s;
    const h = 10 * s;
    const y = cy - h / 2;
    return `<g aria-hidden="true" style="fill:none;stroke:${color};stroke-width:${f(1.2 * s)};stroke-linejoin:round">`
      + `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(1.5 * s)}"/>`
      + `<path d="M${f(x + 1.5 * s)} ${f(y + h - 1.5 * s)} L${f(x + 5 * s)} ${f(y + 4.5 * s)} L${f(x + 8 * s)} ${f(y + 7 * s)} L${f(x + 9.5 * s)} ${f(y + 5.5 * s)} L${f(x + w - 1.5 * s)} ${f(y + h - 1.5 * s)}"/>`
      + `<circle cx="${f(x + 9.5 * s)}" cy="${f(y + 3 * s)}" r="${f(1.1 * s)}" style="fill:${color};stroke:none"/></g>`;
  }

  function spanLabelParts(it, M, measure, fam) {
    return { tW: measure(it.title, 700, M.barFont, fam), dW: measure(it.shortDate, 400, M.barDate, fam) };
  }

  // Historische Jahreszahl h (negativ = v. Chr.) als Beschriftung
  function yearLabel(h, incBC) {
    if (h < 0) return -h + ' v. Chr.';
    return incBC && h <= 1000 ? h + ' n. Chr.' : String(h);
  }

  /* ---------- Achsenbruch ---------- */

  // Lange Zeiten ohne Einträge werden gestaucht. Zwischen zwei Zeitpunkten, an denen etwas
  // geschieht, beginnt oder endet, bleibt links und rechts ein Rand in echtem Maßstab,
  // der Rest schrumpft auf eine schmale Bruchstelle. Gezeichnet wird dann in gestauchten
  // Jahren u statt in echten Jahren t: Vor dem ersten Bruch ist u = t, danach fehlen die
  // gestauchten Jahre. Auch die Ansicht (v0, v1) wird in u angegeben.
  // Alle Anteile beziehen sich auf die Spanne vom ersten bis zum letzten Zeitpunkt.
  const BREAK_MIN = 0.15; // ab dieser Lücke wird gestaucht
  const BREAK_GAIN = 0.2; // nur wenn das insgesamt so viel Platz bringt
  const BREAK_EDGE = 0.02; // Rand in echtem Maßstab neben den Einträgen
  const BREAK_W = 0.015; // so breit bleibt die Bruchstelle

  const NO_WARP = { f: (t) => t, inv: (u) => u, breaks: [], inBreak: () => false };

  function makeWarp(items) {
    const pts = [...new Set(items.flatMap((i) => (i.kind === 'span' ? [i.start, i.end] : [i.start])))].sort((a, b) => a - b);
    if (pts.length < 4) return NO_WARP;
    const R = pts[pts.length - 1] - pts[0];
    const breaks = [];
    let cut = 0;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i] - pts[i - 1] < BREAK_MIN * R) continue;
      const a = pts[i - 1] + BREAK_EDGE * R;
      const b = pts[i] - BREAK_EDGE * R;
      const ua = a - cut;
      cut += b - a - BREAK_W * R;
      breaks.push({ a, b, ua, ub: b - cut });
    }
    // Bei gleichmäßig verteilten Einträgen lohnt sich kein Bruch, er würde nur den Maßstab verzerren
    if (!breaks.length || cut < BREAK_GAIN * R) return NO_WARP;
    const f = (t) => {
      let d = 0;
      for (const k of breaks) {
        if (t >= k.b) d = k.b - k.ub;
        else if (t > k.a) return k.ua + (t - k.a) * (k.ub - k.ua) / (k.b - k.a);
        else break;
      }
      return t - d;
    };
    const inv = (u) => {
      let d = 0;
      for (const k of breaks) {
        if (u >= k.ub) d = k.b - k.ub;
        else if (u > k.ua) return k.a + (u - k.ua) * (k.b - k.a) / (k.ub - k.ua);
        else break;
      }
      return u + d;
    };
    return { f, inv, breaks, inBreak: (t) => breaks.some((k) => t > k.a && t < k.b) };
  }

  /* ---------- Skala ---------- */

  // view in gestauchten Jahren, X rechnet echte Jahre in Pixel um
  function makeTicks(view, W, X, M, measure, fam, warp = NO_WARP) {
    const span = view.v1 - view.v0;
    const ppy = W / span; // Pixel pro Jahr
    const font = M.axisFont;
    const incBC = view.v0 < 1;
    const major = [];
    const minor = [];
    const add = (a, label, special, extra) => {
      if (warp.inBreak(a)) return;
      major.push(Object.assign({ x: X(a), label, special, w: measure(label, special ? 700 : 400, font, fam) }, extra));
    };
    const t0 = warp.inv(view.v0);
    const t1 = warp.inv(view.v1);

    // Stark vergrößert: Monate statt Jahre
    const monthGap = measure('Sep. 2000', 400, font, fam) + 22 * M.s;
    const ms = ppy / 12 >= monthGap ? 1 : ppy / 4 >= monthGap ? 3 : ppy / 2 >= monthGap ? 6 : 0;
    if (ms) {
      for (let y = Math.floor(t0); y <= Math.ceil(t1); y++) {
        const yl = yearLabel(y >= 1 ? y : y - 1, false);
        for (let mo = 0; mo < 12; mo++) {
          const a = y + CUM[mo] / 365;
          if (a < t0 - 0.1 || a > t1 + 0.1) continue;
          if (mo % ms === 0) add(a, mo === 0 ? yl : MONTH_ABBR[mo], mo === 0, { yl });
          else if (!warp.inBreak(a)) minor.push(X(a));
        }
      }
      // Damit das Jahr immer erkennbar ist, bekommt die erste Monatsmarke die Jahreszahl
      const first = major.find((t) => t.x >= 0);
      if (first && !first.special) {
        first.label += ' ' + first.yl;
        first.w = measure(first.label, 400, font, fam);
      }
      return { major, minor };
    }

    const gap = measure(incBC ? '1000 v. Chr.' : '2000', 400, font, fam) + 26 * M.s;
    let step = STEPS[STEPS.length - 1];
    for (const st of STEPS) {
      if (st * ppy >= gap) { step = st; break; }
    }
    const lead = Number(String(step)[0]);
    const mstep = step / (lead === 2 ? 4 : 5);

    // Skalenwerte werden in historischen Jahren gewählt (…, 100 v. Chr., Chr. Geb., 100, …),
    // damit runde Zahlen auch vor Christus rund bleiben.
    const hOf = (a) => (a >= 1 ? a : a - 1);
    const aOf = (h) => (h > 0 ? h : h + 1);
    const h0 = hOf(t0);
    const h1 = hOf(t1);
    for (let k = Math.floor(h0 / step) - 1; k <= Math.ceil(h1 / step) + 1; k++) {
      const h = k * step;
      if (h === 0) {
        if (step > 1) add(1, 'Chr. Geb.', true);
        continue;
      }
      add(aOf(h), yearLabel(h, incBC), false);
    }
    if (mstep >= 1 && mstep * ppy >= 7) {
      for (let k = Math.floor(h0 / mstep) - 1; k <= Math.ceil(h1 / mstep) + 1; k++) {
        const h = k * mstep;
        if (h === 0 || h % step === 0 || warp.inBreak(aOf(h))) continue;
        minor.push(X(aOf(h)));
      }
    }
    // Zwischen zwei Brüchen ohne eigene Jahreszahl steht die Jahreszahl aus der Mitte
    const edges = [t0, ...warp.breaks.flatMap((k) => [k.a, k.b]), t1];
    for (let i = 0; i + 1 < edges.length; i += 2) {
      const a = Math.max(edges[i], t0);
      const b = Math.min(edges[i + 1], t1);
      if (b <= a || (i === 0 && !warp.breaks.length)) continue;
      if (major.some((t) => t.x >= X(a) - 1 && t.x <= X(b) + 1)) continue;
      // möglichst runde Jahreszahl, die in den Abschnitt fällt
      const mid = hOf((a + b) / 2);
      let h = Math.round(mid);
      for (const st of STEPS.slice().reverse()) {
        const c = Math.round(mid / st) * st;
        if (c >= hOf(a) && c <= hOf(b)) { h = c; break; }
      }
      const label = yearLabel(h, incBC);
      const x = X(aOf(h));
      const w = measure(label, 400, font, fam);
      if (h !== 0 && major.every((t) => Math.abs(t.x - x) >= (t.w + w) / 2 + 6 * M.s)) add(aOf(h), label, false);
    }
    major.sort((p, q) => p.x - q.x);
    return { major, minor };
  }

  /* ---------- Layout ---------- */

  /* ---------- Lupe ---------- */

  // o.lupe = { start, end } aus der Zeile "# Lupe: …". Die Lupe erscheint, wenn der Abschnitt
  // im Bild liegt und höchstens halb so breit ist wie das Bild – ist er größer, hat man
  // ohnehin hineingezoomt. Ereignisse im Abschnitt stehen dann oben nur als Punkt auf der
  // Achse und unten in der Lupe mit Fähnchen, ebenso Zeiträume, die ganz hineinpassen.
  const LUPE_MAX = 0.5;

  function layout(items, view, W, o) {
    const L = o.lupe;
    if (L && L.end > L.start) {
      const warp = o.warp || NO_WARP;
      const k = W / (view.v1 - view.v0);
      const x0 = (warp.f(L.start) - view.v0) * k;
      const x1 = (warp.f(L.end) - view.v0) * k;
      const inside = (it) => (it.kind === 'point' ? it.start >= L.start && it.start < L.end : it.start >= L.start && it.end <= L.end);
      const zoomed = items.filter(inside);
      if (zoomed.length && x1 > 0 && x0 < W && x1 - x0 <= W * LUPE_MAX) {
        const rest = items.filter((it) => !inside(it));
        const g = layoutCore(rest, view, W, { ...o, dots: zoomed.filter((it) => it.kind === 'point') });
        const pad = (L.end - L.start) * 0.03;
        const sub = layoutCore(zoomed, { v0: L.start - pad, v1: L.end + pad }, W, { ...o, warp: null });
        const s = g.M.s;
        const y = g.H + 22 * s;
        g.lupe = { g: sub, y, x0: Math.max(x0, 0), x1: Math.min(x1, W) };
        g.H0 = g.H;
        g.H = y + sub.H + 6 * s;
        return g;
      }
    }
    return layoutCore(items, view, W, o);
  }

  // o: { scale, family, measure, warp, dots (Ereignisse, die nur als Punkt erscheinen) }
  function layoutCore(items, view, W, o) {
    const M = metricsFor(o.scale);
    const s = M.s;
    const fam = o.family;
    const measure = o.measure;
    const warp = o.warp || NO_WARP;
    const k = W / (view.v1 - view.v0);
    const X = (t) => (warp.f(t) - view.v0) * k;
    const top = 12 * s;

    // Eine Spur ist frei, wenn sich der Bereich [a, b] mit keinem belegten Bereich überschneidet
    // Ein Fähnchen mit mehreren Zeilen braucht n übereinanderliegende freie Spuren.
    const fits = (lane, a, b, gap) => !lane || lane.every(([l, r]) => b + gap <= l || a >= r + gap);
    const place = (lanes, a, b, gap, n = 1) => {
      let i = 0;
      while (![...Array(n).keys()].every((j) => fits(lanes[i + j], a, b, gap))) i++;
      for (let j = 0; j < n; j++) {
        if (!lanes[i + j]) lanes[i + j] = [];
        lanes[i + j].push([a, b]);
      }
      return i;
    };

    // Ereignisse: Fähnchen ober- oder unterhalb der Achse, Spur 0 liegt jeweils direkt an der Achse.
    // Ein Fähnchen zeigt nach rechts oder links; am Rand immer nach innen, damit nichts abgeschnitten wird.
    // Ereignisse mit genau gleichem Datum stehen gemeinsam in einem Fähnchen.
    const evs = [];
    const points = items.filter((i) => i.kind === 'point').sort((a, b) => a.start - b.start || a.line - b.line);
    const groups = [];
    for (const it of points) {
      const last = groups[groups.length - 1];
      if (last && last[0].start === it.start && last[0].shortDate === it.shortDate) last.push(it);
      else groups.push([it]);
    }
    for (const list of groups) {
      const it = list[0];
      const x = X(it.start);
      const w = list.length > 1 ? groupLabelW(list, M, measure, fam) : pointLabelW(it, M, measure, fam);
      if (x + w < -20 || x > W + 20) continue;
      const canFlip = x - w >= 0 && x + w <= W;
      const h = M.pillH + (list.length - 1) * M.rowH;
      const n = Math.ceil((h + M.laneH - M.pillH) / M.laneH - 1e-9);
      evs.push({ it, list, x, w, h, n, flip: x + w > W && x - w >= 0, canFlip, below: false, dW: measure(it.shortDate, 400, M.dateFont, fam), lane: 0, y: 0, top: 0 });
    }

    // Verteilt die Fähnchen mit festgelegter Seite auf Spuren. Bewertet wird vor allem die
    // höhere der beiden Seiten, danach die Summe der Spuren (niedrige Fähnchen, kurze Stiele).
    // Bei Gleichstand gewinnt oben: dort stehen die Fähnchen, wenn Platz genug ist.
    const assign = () => {
      const up = [];
      const down = [];
      let sum = 0;
      for (const e of evs) {
        e.lane = place(e.below ? down : up, e.flip ? e.x - e.w : e.x, e.flip ? e.x : e.x + e.w, 8 * s, e.n);
        sum += e.lane + (e.below ? 0.5 : 0);
      }
      return { up, down, cost: Math.max(up.length, down.length + 0.5) * 1000 + sum };
    };
    // Schrittweise verbessern: Fähnchen auf die andere Seite drehen oder unter die Achse setzen,
    // solange das Bild dadurch niedriger wird.
    let best = assign();
    if (evs.length <= 150) {
      for (let round = 0; round < 8; round++) {
        let better = false;
        for (const e of evs) {
          for (const key of ['flip', 'below']) {
            if (key === 'flip' && !e.canFlip) continue;
            e[key] = !e[key];
            const r = assign();
            if (r.cost < best.cost) { best = r; better = true; } else e[key] = !e[key];
          }
        }
        if (!better) break;
      }
    }
    best = assign();

    const nUp = best.up.length;
    const nDown = best.down.length;
    const axisY = top + nUp * M.laneH + (nUp ? 14 * s : 6 * s);
    const downTop = axisY + M.tick + M.axisFont + 14 * s;
    // Mehrzeilige Fähnchen wachsen von der Achse weg
    const inset = (M.laneH - M.pillH) / 2;
    for (const e of evs) {
      e.top = e.below
        ? downTop + e.lane * M.laneH + inset
        : axisY - 14 * s - e.lane * M.laneH - inset - e.h;
      e.y = e.top + e.h / 2;
    }
    const eventsBottom = nDown ? downTop + nDown * M.laneH : axisY + M.tick + M.axisFont + 6 * s;

    const ticks = makeTicks(view, W, X, M, measure, fam, warp);

    // Zeiträume: abgetrennter Bereich unter den Ereignissen. Die Beschriftung steht über dem Balken,
    // bündig mit seinem Anfang (am rechten Rand bündig mit dem Ende).
    const sps = [];
    const sLanes = [];
    const spans = items
      .filter((i) => i.kind === 'span')
      .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.line - b.line);
    for (const it of spans) {
      const x0 = X(it.start);
      const x1 = X(it.end);
      if (x1 < -2 || x0 > W + 2) continue;
      const { tW, dW } = spanLabelParts(it, M, measure, fam);
      const lw = tW + 7 * s + dW;
      let labelX = Math.max(x0, 0);
      if (labelX + lw > W) labelX = Math.max(0, Math.min(x1, W) - lw);
      const lane = place(sLanes, Math.min(x0, labelX), Math.max(x1, labelX + lw), 10 * s);
      sps.push({ it, x0, x1, tW, dW, labelX, lane, y: 0 });
    }
    const nS = sLanes.length;
    const spansZone = nS ? eventsBottom + 6 * s : null;
    const spansTop = nS ? spansZone + 14 * s : 0;
    for (const sp of sps) sp.y = spansTop + sp.lane * (M.barRow + M.barGap);
    const bottom = nS ? spansTop + nS * (M.barRow + M.barGap) - M.barGap : eventsBottom;

    // Bruchstellen in Pixeln, nur die sichtbaren
    const breaks = warp.breaks
      .map((b) => ({ x0: (b.ua - view.v0) * k, x1: (b.ub - view.v0) * k }))
      .filter((b) => b.x1 > 0 && b.x0 < W);

    const dots = (o.dots || []).map((it) => ({ it, x: X(it.start) })).filter((d) => d.x >= -6 && d.x <= W + 6);

    return { M, X, W, evs, sps, dots, ticks, axisY, spansZone, breaks, lupe: null, H: bottom + 18 * s };
  }

  /* ---------- SVG ---------- */

  // paint: { ink, soft, grid, sheet, accent, cat(i) }
  // o: { selectedId, interactive, blank, todayPos }
  function svgBody(g, paint, o) {
    const M = g.M;
    const s = M.s;
    const W = g.W;
    const sel = o.selectedId;
    const out = [];
    const H0 = g.H0 || g.H; // Höhe ohne Lupe
    const open = (it) => (o.interactive
      ? `<g class="item" data-id="${it.id}" tabindex="0" role="button" aria-label="${esc(it.shortDate + ': ' + it.title)}">`
      : '<g>');

    // Lupe: zwei Hilfslinien vom Abschnitt auf der Achse zu den Ecken der Lupe, ganz hinten
    const lu = g.lupe;
    if (lu) {
      out.push(`<path d="M${f(lu.x0)} ${f(g.axisY)} L0 ${f(lu.y)} M${f(lu.x1)} ${f(g.axisY)} L${f(W)} ${f(lu.y)}" style="fill:none;stroke:${paint.accent};stroke-width:${f(1.2 * s)};stroke-opacity:0.45;stroke-dasharray:${f(5 * s)} ${f(4 * s)}"/>`);
    }

    // Hilfslinien
    for (const t of g.ticks.major) {
      if (t.x < -1 || t.x > W + 1) continue;
      out.push(`<line x1="${f(t.x)}" y1="0" x2="${f(t.x)}" y2="${f(H0)}" style="stroke:${paint.grid};stroke-width:1"/>`);
    }

    // Heute
    if (o.todayPos != null) {
      const tx = g.X(o.todayPos);
      if (tx >= 0 && tx <= W) {
        const right = tx + 44 * s < W;
        out.push(`<line x1="${f(tx)}" y1="0" x2="${f(tx)}" y2="${f(H0 - 16 * s)}" style="stroke:${paint.accent};stroke-width:${f(1.2 * s)};stroke-dasharray:${f(4 * s)} ${f(4 * s)}"/>`);
        out.push(`<text x="${f(right ? tx + 5 * s : tx - 5 * s)}" y="${f(H0 - 5 * s)}" text-anchor="${right ? 'start' : 'end'}" style="font-size:${f(11.5 * s)}px;font-weight:700;fill:${paint.accent}">heute</text>`);
      }
    }

    // Bereich der Zeiträume, durch Fläche und Linie von den Ereignissen getrennt
    if (g.spansZone != null) {
      out.push(`<rect x="0" y="${f(g.spansZone)}" width="${f(W)}" height="${f(H0 - g.spansZone)}" style="fill:${paint.ink};fill-opacity:0.045"/>`);
      out.push(`<line x1="0" y1="${f(g.spansZone)}" x2="${f(W)}" y2="${f(g.spansZone)}" style="stroke:${paint.soft};stroke-width:1;stroke-opacity:0.5;stroke-dasharray:${f(5 * s)} ${f(4 * s)}"/>`);
    }

    // Bruchstellen: ein Streifen in Papierfarbe verdeckt die Hilfslinien
    const breaks = g.breaks || [];
    for (const b of breaks) {
      out.push(`<rect x="${f(b.x0)}" y="0" width="${f(b.x1 - b.x0)}" height="${f(H0)}" style="fill:${paint.sheet}"/>`);
    }
    // Zeichen für den Bruch: zwei schräge Striche, dazwischen ist die Linie unterbrochen
    const cut = (x, y, half) => {
      const d = half * 0.45;
      const gap = 3.5 * s;
      return `<polygon points="${f(x - gap - d)},${f(y + half)} ${f(x - gap + d)},${f(y - half)} ${f(x + gap + d)},${f(y - half)} ${f(x + gap - d)},${f(y + half)}" style="fill:${paint.sheet}"/>`
        + `<path d="M${f(x - gap - d)} ${f(y + half)} L${f(x - gap + d)} ${f(y - half)} M${f(x + gap - d)} ${f(y + half)} L${f(x + gap + d)} ${f(y - half)}" style="fill:none;stroke:${paint.soft};stroke-width:${f(1.3 * s)}"/>`;
    };

    // Achse und Skala
    out.push(`<line x1="0" y1="${f(g.axisY)}" x2="${f(W)}" y2="${f(g.axisY)}" style="stroke:${paint.ink};stroke-width:${f(1.6 * s)}"/>`);
    for (const b of breaks) out.push(cut((b.x0 + b.x1) / 2, g.axisY, 7 * s));
    for (const x of g.ticks.minor) {
      if (x < 0 || x > W) continue;
      out.push(`<line x1="${f(x)}" y1="${f(g.axisY)}" x2="${f(x)}" y2="${f(g.axisY + 4 * s)}" style="stroke:${paint.soft};stroke-width:1"/>`);
    }
    for (const t of g.ticks.major) {
      if (t.x < -1 || t.x > W + 1) continue;
      out.push(`<line x1="${f(t.x)}" y1="${f(g.axisY)}" x2="${f(t.x)}" y2="${f(g.axisY + M.tick)}" style="stroke:${paint.ink};stroke-width:${f(1.2 * s)}"/>`);
    }

    // Zeiträume
    for (const sp of g.sps) {
      const it = sp.it;
      const c = paint.cat(it.ci);
      const on = it.id === sel;
      const x0 = Math.max(sp.x0, -4);
      const x1 = Math.min(sp.x1, W + 4);
      const w = Math.max(x1 - x0, 3 * s);
      const ty = sp.y + M.barFont * 0.9;
      const by = sp.y + M.barRow - M.barH;
      let label;
      if (o.blank) {
        label = `<line x1="${f(sp.labelX)}" y1="${f(ty + 2 * s)}" x2="${f(sp.labelX + sp.tW)}" y2="${f(ty + 2 * s)}" style="stroke:${paint.soft};stroke-width:1"/>`
          + `<text x="${f(sp.labelX + sp.tW + 7 * s)}" y="${f(ty)}" style="font-size:${f(M.barDate)}px;fill:${paint.soft}">${esc(it.shortDate)}</text>`;
      } else {
        label = `<text x="${f(sp.labelX)}" y="${f(ty)}">`
          + `<tspan style="font-size:${f(M.barFont)}px;font-weight:700;fill:${paint.ink}">${esc(it.title)}</tspan>`
          + `<tspan dx="${f(7 * s)}" style="font-size:${f(M.barDate)}px;fill:${paint.soft}">${esc(it.shortDate)}</tspan></text>`;
      }
      out.push(open(it)
        + `<rect class="hit" x="${f(Math.min(x0, sp.labelX))}" y="${f(sp.y)}" width="${f(Math.max(x1, sp.labelX + sp.tW + 7 * s + sp.dW) - Math.min(x0, sp.labelX))}" height="${f(M.barRow)}" style="fill:transparent"/>`
        + `<rect x="${f(x0)}" y="${f(by)}" width="${f(w)}" height="${f(M.barH)}" rx="${f(M.barH / 2)}" style="fill:${c};fill-opacity:${on ? 0.9 : 0.6};stroke:${c};stroke-width:${f((on ? 2.2 : 1) * s)}"/>`
        + label + '</g>');
      // Läuft der Balken durch eine Bruchstelle, ist er dort ebenfalls unterbrochen
      for (const b of breaks) {
        const xc = (b.x0 + b.x1) / 2;
        if (xc > x0 + 6 * s && xc < x1 - 6 * s) out.push(cut(xc, by + M.barH / 2, M.barH * 0.9));
      }
    }

    // Stiele der Fähnchen
    for (const e of g.evs) {
      const on = e.list.some((it) => it.id === sel);
      out.push(`<line x1="${f(e.x)}" y1="${f(e.below ? e.top : e.top + e.h)}" x2="${f(e.x)}" y2="${f(g.axisY)}" style="stroke:${on ? paint.cat(e.it.ci) : paint.soft};stroke-width:${f((on ? 2 : 1) * s)}"/>`);
    }
    // Jahreszahlen nach den Stielen, mit Rand in Papierfarbe, damit Stiele unter die Achse
    // die Zahlen nicht durchstreichen
    for (const t of g.ticks.major) {
      if (t.x - t.w / 2 < 0 || t.x + t.w / 2 > W) continue;
      out.push(`<text x="${f(t.x)}" y="${f(g.axisY + M.tick + M.axisFont + 2 * s)}" text-anchor="middle" style="font-size:${f(M.axisFont)}px;fill:${t.special ? paint.ink : paint.soft};font-weight:${t.special ? 700 : 400};stroke:${paint.sheet};stroke-width:${f(4 * s)};stroke-linejoin:round;paint-order:stroke">${esc(t.label)}</text>`);
    }
    // Abschnitt der Lupe auf der Achse, darin die Ereignisse nur als Punkt
    if (lu) {
      out.push(`<rect x="${f(lu.x0)}" y="${f(g.axisY - 8 * s)}" width="${f(lu.x1 - lu.x0)}" height="${f(16 * s)}" rx="${f(4 * s)}" style="fill:${paint.accent};fill-opacity:0.12;stroke:${paint.accent};stroke-width:${f(1.2 * s)}"/>`);
    }
    for (const d of g.dots) {
      const on = d.it.id === sel;
      out.push(open(d.it) + `<circle cx="${f(d.x)}" cy="${f(g.axisY)}" r="${f((on ? 5 : 3.5) * s)}" style="fill:${paint.cat(d.it.ci)};stroke:${paint.sheet};stroke-width:${f(1.5 * s)}"/></g>`);
    }
    // Punkte auf der Achse
    for (const e of g.evs) {
      const on = e.list.some((it) => it.id === sel);
      out.push(`<circle cx="${f(e.x)}" cy="${f(g.axisY)}" r="${f((on ? 6 : 4.5) * s)}" style="fill:${paint.cat(e.it.ci)};stroke:${paint.sheet};stroke-width:${f(2 * s)}"/>`);
    }
    // Fähnchen mit Datum und Titel. Bei mehreren Ereignissen am selben Tag steht das Datum
    // nur in der ersten Zeile, jede Zeile hat die Farbe ihrer Kategorie und ist einzeln anklickbar.
    for (const e of g.evs) {
      const x = e.flip ? e.x - e.w + 0.75 * s : e.x - 0.75 * s;
      const tx = x + 8.75 * s;
      const n = e.list.length;
      const pad = (M.pillH - M.rowH) / 2;
      const one = new Set(e.list.map((it) => it.ci)).size === 1;
      if (n > 1) {
        out.push(`<rect x="${f(x)}" y="${f(e.top)}" width="${f(e.w)}" height="${f(e.h)}" rx="${f(3 * s)}" style="fill:${paint.sheet};stroke:${one ? paint.cat(e.it.ci) : paint.soft};stroke-width:${f(0.8 * s)};stroke-opacity:0.55"/>`);
      }
      e.list.forEach((it, r) => {
        const c = paint.cat(it.ci);
        const on = it.id === sel;
        // Zeile r: die erste und letzte reichen bis an den Rand des Fähnchens
        const y0 = r === 0 ? e.top : e.top + pad + r * M.rowH;
        const y1 = r === n - 1 ? e.top + e.h : e.top + pad + (r + 1) * M.rowH;
        const cy = e.top + pad + (r + 0.5) * M.rowH;
        const ty = cy + M.labelFont * 0.36;
        const titleX = tx + e.dW + 7 * s;
        let text;
        if (o.blank) {
          text = (r === 0 ? `<text x="${f(tx)}" y="${f(ty)}" style="font-size:${f(M.dateFont)}px;fill:${paint.soft}">${esc(it.shortDate)}</text>` : '')
            + `<line x1="${f(titleX)}" y1="${f(ty + 2 * s)}" x2="${f(x + e.w - 9 * s)}" y2="${f(ty + 2 * s)}" style="stroke:${paint.soft};stroke-width:1"/>`;
        } else if (r === 0) {
          text = `<text x="${f(tx)}" y="${f(ty)}">`
            + `<tspan style="font-size:${f(M.dateFont)}px;fill:${paint.soft}">${esc(it.shortDate)}</tspan>`
            + `<tspan dx="${f(7 * s)}" style="font-size:${f(M.labelFont)}px;font-weight:700;fill:${paint.ink}">${esc(it.title)}</tspan></text>`;
        } else {
          text = `<text x="${f(titleX)}" y="${f(ty)}" style="font-size:${f(M.labelFont)}px;font-weight:700;fill:${paint.ink}">${esc(it.title)}</text>`;
        }
        const icon = it.img && !o.blank ? imageIcon(x + e.w - 22 * s, cy, s, paint.soft) : '';
        // Einzelnes Fähnchen: Rand in Kategoriefarbe. Im mehrzeiligen nur dann, wenn die Zeile gewählt ist.
        const stroke = n === 1 || on
          ? `stroke:${c};stroke-width:${f((on ? 2 : 0.8) * s)};stroke-opacity:${on ? 1 : 0.55}`
          : 'stroke:none';
        out.push(open(it)
          + (n === 1 ? `<rect x="${f(x)}" y="${f(y0)}" width="${f(e.w)}" height="${f(y1 - y0)}" rx="${f(3 * s)}" style="fill:${paint.sheet}"/>` : '')
          + `<rect class="hit" x="${f(x)}" y="${f(y0)}" width="${f(e.w)}" height="${f(y1 - y0)}" rx="${f(3 * s)}" style="fill:${c};fill-opacity:${on ? 0.3 : 0.14};${stroke}"/>`
          + text + icon + '</g>');
      });
    }

    // Die Lupe selbst: gerahmt unter dem Zeitstrahl
    if (lu) {
      out.push(`<rect x="${f(0.75 * s)}" y="${f(lu.y)}" width="${f(W - 1.5 * s)}" height="${f(lu.g.H)}" rx="${f(8 * s)}" style="fill:${paint.sheet};stroke:${paint.accent};stroke-width:${f(1.2 * s)};stroke-opacity:0.6"/>`);
      out.push(`<g transform="translate(0 ${f(lu.y)})">${svgBody(lu.g, paint, o)}</g>`);
    }

    return out.join('');
  }

  /* ---------- Seite A4 quer für Bild und Druck ---------- */

  // Feste Farben für Bild und Druck: Papier ist immer weiß, egal welche Farben der Bildschirm zeigt
  const FAM_EXPORT = 'Arial, Helvetica, sans-serif';
  const CAT_LIGHT = ['#B23A30', '#6A47A6', '#9A6608', '#2760A8', '#86552A', '#A3356E', '#157A80', '#6B7671'];
  const EXPORT_PAINT = {
    ink: '#1C2420', soft: '#56635D', grid: '#E3E8E5', sheet: '#FFFFFF', accent: '#2C5A4B',
    cat: (i) => CAT_LIGHT[i - 1],
  };

  // Seite im Format A4 quer (273 × 186 mm Innenfläche): Kopf mit Titel
  // und Rahmen, Fußzeile mit Kategorien. Der Zeitstrahl wird so groß wie möglich gesetzt.
  // Das Bild entsteht in doppelter Auflösung, damit es auch gedruckt scharf bleibt.
  // o: title, blank (Lückenbild), hidden (ausgeblendete Kategorien), von (wer ihn erstellt hat), measure, day,
  //    warp (Achsenbruch wie auf dem Bildschirm), lupe
  function pageSvg(items, view, cats, o) {
    const W = 1400;
    const H = Math.round(W * 186 / 273);
    const pad = 36;
    const P = EXPORT_PAINT;
    const measure = o.measure;
    const hidden = o.hidden || new Set();
    const inner = W - pad * 2 - 40; // Zeitstrahl mit etwas Abstand zum Rahmen
    const top = 132;
    const bottom = H - 92;
    const room = bottom - top - 40;

    // Größten Maßstab suchen, bei dem alles auf die Seite passt
    const draw = (sc) => layout(items, view, inner, { scale: sc, family: FAM_EXPORT, measure, warp: o.warp, lupe: o.lupe });
    let lo = 0.8;
    let hi = 1.7;
    let g = draw(lo);
    // Mit Lupe kann es eng werden: dann etwas kleiner, bis alles auf die Seite passt
    for (let i = 0; i < 4 && g.H > room && lo > 0.55; i++) {
      lo = Math.max(0.55, lo * Math.sqrt(room / g.H));
      g = draw(lo);
    }
    if (g.H <= room) {
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        const t = draw(mid);
        if (t.H <= room) { lo = mid; g = t; } else hi = mid;
      }
    }
    const gy = top + 20 + Math.max(0, (room - g.H) / 2);

    // Zeitraum und Anzahl für die Unterzeile
    const yr = (x) => (x < 1 ? `${Math.round(1 - x)} v. Chr.` : String(Math.floor(x)));
    const first = Math.min(...items.map((i) => i.start));
    const last = Math.max(...items.map((i) => i.end));
    const n = items.length;
    const sub = (o.von ? `Erstellt von ${o.von} · ` : '')
      + `${n} ${n === 1 ? 'Eintrag' : 'Einträge'} · ${first === last ? yr(first) : `${yr(first)} bis ${yr(last)}`}`;

    const legend = [];
    let lx = pad;
    for (const c of cats) {
      if (hidden.has(c.key)) continue;
      const tw = measure(c.name, 400, 15, FAM_EXPORT);
      if (lx + 22 + tw > W - pad - 260) break; // rechts steht die Fußzeile
      legend.push(`<rect x="${lx}" y="${H - 50}" width="13" height="13" rx="3" style="fill:${P.cat(c.ci)}"/>`
        + `<text x="${lx + 20}" y="${H - 39}" style="font-size:15px;fill:${P.soft}">${esc(c.name)}</text>`);
      lx += 20 + tw + 24;
    }
    const right = o.blank
      ? `<text x="${W - pad}" y="58" text-anchor="end" style="font-size:16px;fill:${P.soft}">Name: ____________________</text>`
        + `<text x="${W - pad}" y="92" text-anchor="end" style="font-size:16px;fill:${P.soft}">Datum: _____________</text>`
      : '';
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}" style="font-family:${FAM_EXPORT}">`
      + `<rect width="${W}" height="${H}" style="fill:#FFFFFF"/>`
      + `<text x="${pad}" y="62" style="font-size:34px;font-weight:700;fill:${P.ink}">${esc(o.title)}</text>`
      + `<text x="${pad}" y="94" style="font-size:16px;fill:${P.soft}">${esc(o.blank ? 'Ergänze die fehlenden Ereignisse.' : sub)}</text>`
      + right
      + `<line x1="${pad}" y1="${top - 14}" x2="${W - pad}" y2="${top - 14}" style="stroke:${P.accent};stroke-width:3"/>`
      + `<rect x="${pad}" y="${top}" width="${W - pad * 2}" height="${bottom - top}" rx="10" style="fill:none;stroke:${P.grid};stroke-width:1.5"/>`
      + `<g transform="translate(${pad + 20} ${gy.toFixed(1)})">${svgBody(g, P, { selectedId: null, interactive: false, blank: o.blank })}</g>`
      + legend.join('')
      + `<text x="${W - pad}" y="${H - 39}" text-anchor="end" style="font-size:13px;fill:${P.soft}">Zeitstrahl-Werkstatt · ${esc(o.day || '')}</text>`
      + '</svg>';
    return { markup, w: W * 2, h: H * 2 };
  }

  return { metricsFor, pointLabelW, spanLabelParts, makeWarp, makeTicks, layout, svgBody, pageSvg, esc };
});
