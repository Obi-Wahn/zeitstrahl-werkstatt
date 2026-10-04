/*
 * Zeitstrahl-Werkstatt · Layout und Zeichnen
 *
 * layout()  berechnet aus Einträgen und sichtbarem Zeitraum die Positionen:
 *           Achse, Skalenstriche, Fähnchen (Ereignisse) und Balken (Zeiträume).
 *           Überlappende Beschriftungen werden auf "Spuren" verteilt.
 * svgBody() macht daraus SVG-Markup – für den Bildschirm und für den Bild-Export.
 *
 * Die Textbreiten misst eine von außen übergebene Funktion measure(),
 * damit dieses Modul auch ohne Browser testbar bleibt.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZeitstrahlLayout = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const MONTH_ABBR = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];

  const f = (n) => Math.round(n * 10) / 10;
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  function metricsFor(s) {
    return {
      s,
      laneH: 31 * s,
      pillH: 25 * s,
      labelFont: 15 * s,
      dateFont: 13 * s,
      axisFont: 13 * s,
      tick: 8 * s,
      barH: 27 * s,
      barGap: 7 * s,
      barFont: 14 * s,
      barDate: 12.5 * s,
      blankW: 110 * s,
    };
  }

  const ICON_W = 20; // Platz für das Bild-Symbol (bei Maßstab 1)

  function pointLabelW(it, M, measure, fam, blank) {
    const title = blank ? M.blankW : measure(it.title, 700, M.labelFont, fam);
    const icon = it.img && !blank ? ICON_W * M.s : 0;
    return 8 * M.s + measure(it.shortDate, 400, M.dateFont, fam) + 7 * M.s + title + icon + 9 * M.s;
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

  function spanLabelParts(it, M, measure, fam, blank) {
    return {
      tW: blank ? M.blankW : measure(it.title, 700, M.barFont, fam),
      dW: measure(it.shortDate, 400, M.barDate, fam),
    };
  }

  // Historische Jahreszahl h (negativ = v. Chr.) als Beschriftung
  function yearLabel(h, incBC) {
    if (h < 0) return -h + ' v. Chr.';
    return incBC && h <= 1000 ? h + ' n. Chr.' : String(h);
  }

  /* ---------- Skala ---------- */

  function makeTicks(view, W, X, M, measure, fam) {
    const span = view.v1 - view.v0;
    const ppy = W / span; // Pixel pro Jahr
    const font = M.axisFont;
    const incBC = view.v0 < 1;
    const major = [];
    const minor = [];
    const add = (a, label, special, extra) => {
      major.push(Object.assign({ x: X(a), label, special, w: measure(label, special ? 700 : 400, font, fam) }, extra));
    };

    // Stark vergrößert: Monate statt Jahre
    const monthGap = measure('Sep. 2000', 400, font, fam) + 22 * M.s;
    const ms = ppy / 12 >= monthGap ? 1 : ppy / 4 >= monthGap ? 3 : ppy / 2 >= monthGap ? 6 : 0;
    if (ms) {
      for (let y = Math.floor(view.v0); y <= Math.ceil(view.v1); y++) {
        const yl = yearLabel(y >= 1 ? y : y - 1, false);
        for (let mo = 0; mo < 12; mo++) {
          const a = y + CUM[mo] / 365;
          if (a < view.v0 - 0.1 || a > view.v1 + 0.1) continue;
          if (mo % ms === 0) add(a, mo === 0 ? yl : MONTH_ABBR[mo], mo === 0, { yl });
          else minor.push(X(a));
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
    const h0 = hOf(view.v0);
    const h1 = hOf(view.v1);
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
        if (h === 0 || h % step === 0) continue;
        minor.push(X(aOf(h)));
      }
    }
    return { major, minor };
  }

  /* ---------- Layout ---------- */

  // o: { scale, family, measure, blank }
  function layout(items, view, W, o) {
    const M = metricsFor(o.scale);
    const s = M.s;
    const fam = o.family;
    const measure = o.measure;
    const k = W / (view.v1 - view.v0);
    const X = (t) => (t - view.v0) * k;
    const top = 12 * s;

    // Eine Spur ist frei, wenn sich der Bereich [a, b] mit keinem belegten Bereich überschneidet
    const fits = (lane, a, b, gap) => lane.every(([l, r]) => b + gap <= l || a >= r + gap);
    const place = (lanes, a, b, gap) => {
      let i = lanes.findIndex((lane) => fits(lane, a, b, gap));
      if (i < 0) { i = lanes.length; lanes.push([]); }
      lanes[i].push([a, b]);
      return i;
    };

    // Ereignisse: Fähnchen oberhalb der Achse, Spur 0 liegt direkt über der Achse.
    // Am rechten Rand zeigt das Fähnchen nach links, damit nichts abgeschnitten wird.
    const evs = [];
    const eLanes = [];
    const points = items.filter((i) => i.kind === 'point').sort((a, b) => a.start - b.start || a.line - b.line);
    for (const it of points) {
      const x = X(it.start);
      const w = pointLabelW(it, M, measure, fam, o.blank);
      if (x + w < -20 || x > W + 20) continue;
      const flip = x + w > W && x - w >= 0;
      const lane = place(eLanes, flip ? x - w : x, flip ? x : x + w, 8 * s);
      evs.push({ it, x, w, flip, dW: measure(it.shortDate, 400, M.dateFont, fam), lane, y: 0 });
    }
    const nE = eLanes.length;
    const axisY = top + nE * M.laneH + (nE ? 14 * s : 6 * s);
    for (const e of evs) e.y = axisY - 14 * s - e.lane * M.laneH - M.laneH / 2;

    const ticks = makeTicks(view, W, X, M, measure, fam);

    // Zeiträume: Balken unterhalb der Achse
    const spansTop = axisY + M.tick + M.axisFont + 16 * s;
    const sps = [];
    const sLanes = [];
    const spans = items
      .filter((i) => i.kind === 'span')
      .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.line - b.line);
    for (const it of spans) {
      const x0 = X(it.start);
      const x1 = X(it.end);
      if (x1 < -2 || x0 > W + 2) continue;
      const { tW, dW } = spanLabelParts(it, M, measure, fam, o.blank);
      const lw = tW + 7 * s + dW;
      // Beschriftung im Balken, sonst rechts daneben, sonst links daneben
      let labelX;
      if (Math.min(x1, W) - Math.max(x0, 0) - 16 * s >= lw) labelX = Math.max(x0, 0) + 8 * s;
      else if (x1 + 6 * s + lw <= W) labelX = x1 + 6 * s;
      else if (x0 - 6 * s - lw >= 0) labelX = x0 - 6 * s - lw;
      else labelX = Math.max(0, Math.min(W - lw, Math.max(x0, 0) + 8 * s));
      const lane = place(sLanes, Math.min(x0, labelX), Math.max(x1, labelX + lw), 6 * s);
      sps.push({ it, x0, x1, tW, dW, labelX, lane, y: spansTop + lane * (M.barH + M.barGap) });
    }
    const nS = sLanes.length;
    const bottom = nS ? spansTop + nS * (M.barH + M.barGap) - M.barGap : axisY + M.tick + M.axisFont + 6 * s;

    return { M, X, W, evs, sps, ticks, axisY, H: bottom + 18 * s };
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
    const open = (it) => (o.interactive
      ? `<g class="item" data-id="${it.id}" tabindex="0" role="button" aria-label="${esc(it.shortDate + ': ' + it.title)}">`
      : '<g>');

    // Hilfslinien
    for (const t of g.ticks.major) {
      if (t.x < -1 || t.x > W + 1) continue;
      out.push(`<line x1="${f(t.x)}" y1="0" x2="${f(t.x)}" y2="${f(g.H)}" style="stroke:${paint.grid};stroke-width:1"/>`);
    }

    // Heute
    if (o.todayPos != null) {
      const tx = g.X(o.todayPos);
      if (tx >= 0 && tx <= W) {
        const right = tx + 44 * s < W;
        out.push(`<line x1="${f(tx)}" y1="0" x2="${f(tx)}" y2="${f(g.H - 16 * s)}" style="stroke:${paint.accent};stroke-width:${f(1.2 * s)};stroke-dasharray:${f(4 * s)} ${f(4 * s)}"/>`);
        out.push(`<text x="${f(right ? tx + 5 * s : tx - 5 * s)}" y="${f(g.H - 5 * s)}" text-anchor="${right ? 'start' : 'end'}" style="font-size:${f(11.5 * s)}px;font-weight:700;fill:${paint.accent}">heute</text>`);
      }
    }

    // Achse und Skala
    out.push(`<line x1="0" y1="${f(g.axisY)}" x2="${f(W)}" y2="${f(g.axisY)}" style="stroke:${paint.ink};stroke-width:${f(1.6 * s)}"/>`);
    for (const x of g.ticks.minor) {
      if (x < 0 || x > W) continue;
      out.push(`<line x1="${f(x)}" y1="${f(g.axisY)}" x2="${f(x)}" y2="${f(g.axisY + 4 * s)}" style="stroke:${paint.soft};stroke-width:1"/>`);
    }
    for (const t of g.ticks.major) {
      if (t.x < -1 || t.x > W + 1) continue;
      out.push(`<line x1="${f(t.x)}" y1="${f(g.axisY)}" x2="${f(t.x)}" y2="${f(g.axisY + M.tick)}" style="stroke:${paint.ink};stroke-width:${f(1.2 * s)}"/>`);
      if (t.x - t.w / 2 < 0 || t.x + t.w / 2 > W) continue;
      out.push(`<text x="${f(t.x)}" y="${f(g.axisY + M.tick + M.axisFont + 2 * s)}" text-anchor="middle" style="font-size:${f(M.axisFont)}px;fill:${t.special ? paint.ink : paint.soft};font-weight:${t.special ? 700 : 400}">${esc(t.label)}</text>`);
    }

    // Zeiträume
    for (const sp of g.sps) {
      const it = sp.it;
      const c = paint.cat(it.ci);
      const on = it.id === sel;
      const x0 = Math.max(sp.x0, -4);
      const x1 = Math.min(sp.x1, W + 4);
      const w = Math.max(x1 - x0, 3 * s);
      const ty = sp.y + M.barH / 2 + M.barFont * 0.36;
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
        + `<rect class="hit" x="${f(x0)}" y="${f(sp.y)}" width="${f(w)}" height="${f(M.barH)}" rx="${f(3 * s)}" style="fill:${c};fill-opacity:${on ? 0.34 : 0.17};stroke:${c};stroke-width:${f((on ? 2.2 : 1) * s)}"/>`
        + label + '</g>');
    }

    // Stiele der Fähnchen
    for (const e of g.evs) {
      const on = e.it.id === sel;
      out.push(`<line x1="${f(e.x)}" y1="${f(e.y + M.pillH / 2)}" x2="${f(e.x)}" y2="${f(g.axisY)}" style="stroke:${on ? paint.cat(e.it.ci) : paint.soft};stroke-width:${f((on ? 2 : 1) * s)}"/>`);
    }
    // Punkte auf der Achse
    for (const e of g.evs) {
      const on = e.it.id === sel;
      out.push(`<circle cx="${f(e.x)}" cy="${f(g.axisY)}" r="${f((on ? 6 : 4.5) * s)}" style="fill:${paint.cat(e.it.ci)};stroke:${paint.sheet};stroke-width:${f(2 * s)}"/>`);
    }
    // Fähnchen mit Datum und Titel
    for (const e of g.evs) {
      const it = e.it;
      const c = paint.cat(it.ci);
      const on = it.id === sel;
      const x = e.flip ? e.x - e.w + 0.75 * s : e.x - 0.75 * s;
      const y = e.y - M.pillH / 2;
      const tx = x + 8.75 * s;
      const ty = e.y + M.labelFont * 0.36;
      let text;
      if (o.blank) {
        const bx = tx + e.dW + 7 * s;
        text = `<text x="${f(tx)}" y="${f(ty)}" style="font-size:${f(M.dateFont)}px;fill:${paint.soft}">${esc(it.shortDate)}</text>`
          + `<line x1="${f(bx)}" y1="${f(ty + 2 * s)}" x2="${f(bx + M.blankW)}" y2="${f(ty + 2 * s)}" style="stroke:${paint.soft};stroke-width:1"/>`;
      } else {
        text = `<text x="${f(tx)}" y="${f(ty)}">`
          + `<tspan style="font-size:${f(M.dateFont)}px;fill:${paint.soft}">${esc(it.shortDate)}</tspan>`
          + `<tspan dx="${f(7 * s)}" style="font-size:${f(M.labelFont)}px;font-weight:700;fill:${paint.ink}">${esc(it.title)}</tspan></text>`;
      }
      const icon = it.img && !o.blank ? imageIcon(x + e.w - 22 * s, e.y, s, paint.soft) : '';
      out.push(open(it)
        + `<rect x="${f(x)}" y="${f(y)}" width="${f(e.w)}" height="${f(M.pillH)}" rx="${f(3 * s)}" style="fill:${paint.sheet}"/>`
        + `<rect class="hit" x="${f(x)}" y="${f(y)}" width="${f(e.w)}" height="${f(M.pillH)}" rx="${f(3 * s)}" style="fill:${c};fill-opacity:${on ? 0.3 : 0.14};stroke:${c};stroke-width:${f((on ? 2 : 0.8) * s)};stroke-opacity:${on ? 1 : 0.55}"/>`
        + text + icon + '</g>');
    }

    return out.join('');
  }

  return { metricsFor, pointLabelW, spanLabelParts, makeTicks, layout, svgBody, esc };
});
