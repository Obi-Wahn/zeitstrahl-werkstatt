/*
 * Zeitstrahl-Werkstatt · Parser
 *
 * Liest die Textzeilen eines Zeitstrahls und macht daraus Einträge.
 * Eine Zeile hat die Form:
 *
 *   Datum; Titel; Kategorie; Beschreibung
 *
 * Intern rechnet der Parser mit der "astronomischen" Jahreszählung:
 * 1 v. Chr. = 0, 2 v. Chr. = -1, 44 v. Chr. = -43 usw.
 * So lassen sich Abstände ohne Sonderfall berechnen, obwohl es
 * historisch kein Jahr 0 gibt.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZeitstrahlParser = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Tage vor dem jeweiligen Monatsbeginn (ohne Schaltjahre, für die Darstellung genau genug)
  const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

  const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const MONTH_ABBR = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];
  const MONTH_KEYS = {
    jan: 1, januar: 1, 'jän': 1, 'jänner': 1,
    feb: 2, februar: 2,
    'mär': 3, 'märz': 3, maerz: 3, mrz: 3,
    apr: 4, april: 4,
    mai: 5,
    jun: 6, juni: 6,
    jul: 7, juli: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    okt: 10, oktober: 10,
    nov: 11, november: 11,
    dez: 12, dezember: 12,
  };

  const RX_APPROX = /^(?:ca\.?\s*|circa\s+|um\s+|etwa\s+|ungefähr\s+)/i;
  const RX_BC = /\s*(?:v\.?\s?Chr\.?|vor\s+Christus|v\.?\s?u\.?\s?Z\.?)$/i;
  const RX_AD = /\s*(?:n\.?\s?Chr\.?|nach\s+Christus|n\.?\s?u\.?\s?Z\.?)$/i;

  // Kategorien mit fester Farbe (Index 1–8 entspricht --cat-1 … --cat-8 im CSS)
  const CATEGORY_RULES = [
    [1, /^(politik|krieg|staat|herrschaft|recht|diplomatie)/],
    [2, /^(religion|kirche|glaube|theologie|bibel|mission)/],
    [3, /^(kultur|kunst|literatur|musik|architektur|philosophie)/],
    [4, /^(technik|wissenschaft|erfindung|bildung|medien|forschung)/],
    [5, /^(wirtschaft|handel|arbeit|industrie)/],
    [6, /^(gesellschaft|alltag|sozial|bevölkerung)/],
    [7, /^(person|biografie|biographie|leben)/],
    [8, /^(epoche|zeitalter|phase|abschnitt)/],
  ];
  // Reihenfolge, in der eigene Kategorien freie Farben bekommen
  const FREE_ORDER = [4, 6, 3, 7, 5, 1, 2];
  // Bei einer Vorgabe reichen die Farben für alle acht Kategorien, dann auch das Grau der Epochen
  const PRESET_ORDER = [...FREE_ORDER, 8];

  /* ---------- Einzelnes Datum ---------- */

  // Liefert {y, m, d, bc, approx, today} oder null.
  // y ist die historische Jahreszahl (immer positiv), bc = vor Christus.
  function parseDate(raw, now) {
    let s = String(raw).trim().replace(/\s+/g, ' ');
    if (!s) return null;
    let approx = false;
    let bc = false;
    let m;

    if ((m = s.match(RX_APPROX))) {
      approx = true;
      s = s.slice(m[0].length).trim();
    }
    if (/^heute$/i.test(s)) {
      const d = now || new Date();
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), bc: false, approx: false, today: true };
    }
    if ((m = s.match(RX_BC))) {
      bc = true;
      s = s.slice(0, m.index).trim();
    } else if ((m = s.match(RX_AD))) {
      s = s.slice(0, m.index).trim();
    }

    let y = 0;
    let mo = 0;
    let day = 0;
    if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{1,5})$/))) {
      // 31.10.1517
      day = +m[1]; mo = +m[2]; y = +m[3];
      if (!mo || !day) return null;
    } else if ((m = s.match(/^(\d{1,2})\.(\d{3,5})$/))) {
      // 10.1517
      mo = +m[1]; y = +m[2];
      if (!mo) return null;
    } else if ((m = s.match(/^(?:(\d{1,2})\.?\s*)?([a-zäöü]+)\.?\s+(\d{1,5})$/i))) {
      // 9. November 1918 · Okt. 1517
      mo = MONTH_KEYS[m[2].toLowerCase()] || 0;
      if (!mo) return null;
      day = m[1] ? +m[1] : 0;
      y = +m[3];
    } else if ((m = s.match(/^(-?)(\d{1,5})$/))) {
      // 1517 · -44 (als Kurzform für 44 v. Chr.)
      y = +m[2];
      if (m[1]) bc = true;
    } else {
      return null;
    }
    if (y < 1 || mo > 12 || day > 31) return null;
    return { y, m: mo, d: day, bc, approx, today: false };
  }

  // Position auf der Zeitachse in (astronomischen) Jahren mit Nachkommastellen
  function toPos(p) {
    let t = p.bc ? 1 - p.y : p.y;
    if (p.m) t += (CUM[p.m - 1] + (p.d ? p.d - 1 : 0)) / 365;
    return t;
  }

  /* ---------- Datumsfeld (Zeitpunkt oder Zeitraum) ---------- */

  function splitRange(s) {
    const t = s.replace(/\s+bis\s+/i, ' – ');
    const m = t.match(/^(.+?)\s*[–—]\s*(.+)$/)
      || t.match(/^(.+?)\s+-\s+(.+)$/)
      || t.match(/^(.*[\d.])-(\S.*)$/);
    return m ? [m[1], m[2]] : null;
  }

  /* ---------- Jahrhunderte ---------- */

  // „15. Jh.“, „15. Jahrhundert“, „frühes 16. Jh.“, „Mitte 16. Jh.“, „spätes 5. Jh. v. Chr.“
  const RX_CENTURY = /^(?:(frühes|frühen|anfang des|anfang|beginn des|beginn|mitte des|mitte|mittleres|spätes|späten|ende des|ende)\s+)?(\d{1,2})\.?\s*(?:jh\.?|jhd\.?|jahrhundert)$/i;
  // Nur die Zahl, als Anfang eines Bereichs: „14.–16. Jh.“
  const RX_CENTURY_NR = /^(\d{1,2})\.?$/;

  const CENTURY_PART = {
    'frühes': 'früh', 'frühen': 'früh', 'anfang': 'früh', 'anfang des': 'früh', 'beginn': 'früh', 'beginn des': 'früh',
    'mitte': 'mitte', 'mitte des': 'mitte', 'mittleres': 'mitte',
    'spätes': 'spät', 'späten': 'spät', 'ende': 'spät', 'ende des': 'spät',
  };
  const PART_LABEL = { 'früh': 'frühes', mitte: 'Mitte des', 'spät': 'spätes' };

  // Liefert { n, part, bc } oder null. part ist '', 'früh', 'mitte' oder 'spät'.
  function parseCentury(raw) {
    let s = String(raw).trim().replace(/\s+/g, ' ');
    let bc = false;
    let m;
    if ((m = s.match(RX_BC))) {
      bc = true;
      s = s.slice(0, m.index).trim();
    } else if ((m = s.match(RX_AD))) {
      s = s.slice(0, m.index).trim();
    }
    const c = s.match(RX_CENTURY);
    if (!c) return null;
    const n = +c[2];
    if (n < 1 || n > 99) return null;
    return { n, part: c[1] ? CENTURY_PART[c[1].toLowerCase()] : '', bc };
  }

  // Jahre eines Jahrhunderts, bei „frühes“/„Mitte“/„spätes“ nur ein Drittel davon.
  // 15. Jh. = 1401–1500 · 5. Jh. v. Chr. = 500–401 v. Chr.
  function centuryYears(c) {
    const from = c.part === 'mitte' ? 34 : c.part === 'spät' ? 67 : 1;
    const to = c.part === 'früh' ? 33 : c.part === 'mitte' ? 66 : 100;
    const base = (c.n - 1) * 100;
    return c.bc
      ? { y1: c.n * 100 - from + 1, y2: c.n * 100 - to + 1 } // rückwärts gezählt
      : { y1: base + from, y2: base + to };
  }

  function centuryLabel(c, long) {
    const part = c.part ? PART_LABEL[c.part] + ' ' : '';
    return `${part}${c.n}. ${long ? 'Jahrhundert' : 'Jh.'}${c.bc ? ' v. Chr.' : ''}`;
  }

  // Ein Jahrhundert oder ein Bereich daraus wird zu einem Zeitraum (Balken).
  function centuryField(raw) {
    const s = String(raw).trim();
    const range = splitRange(s);
    let c1;
    let c2;
    if (range) {
      c2 = parseCentury(range[1]);
      if (!c2) return null;
      const nr = range[0].trim().match(RX_CENTURY_NR);
      c1 = nr ? { n: +nr[1], part: '', bc: c2.bc } : parseCentury(range[0]);
      if (!c1) return null;
      // „14.–16. Jh. v. Chr.“: Die Angabe am Ende gilt auch für den Anfang
      if (c2.bc && !RX_AD.test(range[0].trim())) c1.bc = true;
    } else {
      c1 = parseCentury(s);
      if (!c1) return null;
      c2 = c1;
    }
    const a = { y: centuryYears(c1).y1, m: 0, d: 0, bc: c1.bc, approx: true, today: false };
    const b = { y: centuryYears(c2).y2, m: 0, d: 0, bc: c2.bc, approx: true, today: false };
    const start = toPos(a);
    const end = toPos(b) + 1; // bis zum Ende des letzten Jahres
    if (end < start) return { error: `Das Ende (${range[1].trim()}) liegt vor dem Anfang (${range[0].trim()}).` };
    const label = c1 === c2 ? centuryLabel(c1) : `${c1.n}.–${centuryLabel(c2)}`;
    const longLabel = c1 === c2 ? centuryLabel(c1, true) : `${c1.n}. bis ${centuryLabel(c2, true)}`;
    return { kind: 'span', a, b, start, end, label, longLabel };
  }

  function dateError(s) {
    const t = String(s).trim();
    if (/^(?:ca\.?\s*|um\s+)?-?0+(?:\s|$)/i.test(t)) {
      return 'Ein Jahr 0 gibt es nicht: Auf 1 v. Chr. folgt direkt 1 n. Chr.';
    }
    return `Datum „${t}“ nicht erkannt. Möglich sind z. B. 1517, 31.10.1517, 9. November 1918, 44 v. Chr., 1618–1648 oder 15. Jh.`;
  }

  function parseDateField(raw, now) {
    const s = String(raw).trim();
    if (!s) return { error: 'Datum fehlt. Beispiel: 1517; Thesenanschlag; Religion' };
    const cent = centuryField(s);
    if (cent) return cent;
    const range = splitRange(s);
    if (!range) {
      const a = parseDate(s, now);
      if (!a) return { error: dateError(s) };
      const p = toPos(a);
      return { kind: 'point', a, start: p, end: p };
    }
    const a = parseDate(range[0], now);
    const b = parseDate(range[1], now);
    if (!a) return { error: dateError(range[0]) };
    if (!b) return { error: dateError(range[1]) };
    // "7–4 v. Chr.": Die Angabe "v. Chr." am Ende gilt auch für den Anfang
    if (b.bc && !a.bc && !RX_AD.test(range[0].trim())) a.bc = true;
    const start = toPos(a);
    const end = toPos(b);
    if (end < start) {
      return { error: `Das Ende (${range[1].trim()}) liegt vor dem Anfang (${range[0].trim()}).` };
    }
    return { kind: 'span', a, b, start, end };
  }

  /* ---------- Formatieren ---------- */

  function fmtYear(p) {
    return p.bc ? p.y + ' v. Chr.' : String(p.y);
  }

  function fmtShort(p) {
    if (p.today) return 'heute';
    let s = fmtYear(p);
    if (p.m && p.d) s = p.d + '.' + p.m + '.' + s;
    else if (p.m) s = MONTH_ABBR[p.m - 1] + ' ' + s;
    return (p.approx ? 'um ' : '') + s;
  }

  function fmtLong(p) {
    if (p.today) return 'heute';
    let s = fmtYear(p);
    if (p.m && p.d) s = p.d + '. ' + MONTH_NAMES[p.m - 1] + ' ' + s;
    else if (p.m) s = MONTH_NAMES[p.m - 1] + ' ' + s;
    return (p.approx ? 'um ' : '') + s;
  }

  function fmtRangeShort(a, b) {
    if (a.bc && b.bc && !a.m && !b.m) return (a.approx ? 'um ' : '') + a.y + '–' + b.y + ' v. Chr.';
    return fmtShort(a) + '–' + fmtShort(b);
  }

  const plural = (n, one, many) => (n === 1 ? one : many);

  function yearsBefore(p, now) {
    const ny = (now || new Date()).getFullYear();
    return ny - (p.bc ? 1 - p.y : p.y);
  }

  function relText(n, approx, word) {
    if (n > 0) return `${word ? word + ' ' : ''}vor ${approx}${n} ${plural(n, 'Jahr', 'Jahren')}`;
    if (n === 0) return `${word ? word + ' ' : ''}in diesem Jahr`;
    return `${word ? word + ' ' : ''}in ${-n} ${plural(-n, 'Jahr', 'Jahren')}`;
  }

  // "vor 509 Jahren", "seit 226 Jahren" …
  function agoText(it, now) {
    const n = yearsBefore(it.a, now);
    const approx = it.a.approx ? 'etwa ' : '';
    if (it.kind === 'span') {
      if (it.b.today) return n > 0 ? `seit ${approx}${n} ${plural(n, 'Jahr', 'Jahren')}` : 'seit diesem Jahr';
      return relText(n, approx, 'Beginn') + ' · ' + relText(yearsBefore(it.b, now), '', 'Ende');
    }
    if (it.a.today) return 'heute';
    return relText(n, approx, '');
  }

  function durationText(it) {
    if (it.kind !== 'span') return '';
    const d = it.end - it.start;
    if (!it.a.m && !it.b.m) {
      const n = Math.round(d);
      const pre = it.a.approx || it.b.approx ? 'etwa ' : '';
      return n === 0 ? 'weniger als ein Jahr' : pre + n + ' ' + plural(n, 'Jahr', 'Jahre');
    }
    if (d >= 2) return 'rund ' + Math.round(d) + ' Jahre';
    if (d >= 1 / 12) {
      const mo = Math.round(d * 12);
      return 'rund ' + mo + ' ' + plural(mo, 'Monat', 'Monate');
    }
    const days = Math.max(1, Math.round(d * 365));
    return days + ' ' + plural(days, 'Tag', 'Tage');
  }

  /* ---------- Kategorien ---------- */

  // Farben für die vorgegebenen Kategorien der Lehrkraft: Namen mit fester Farbe behalten sie,
  // die übrigen bekommen freie Farben in der Reihenfolge der Vorgabe. So sieht eine Kategorie
  // in jedem Gruppen-Zeitstrahl gleich aus, auch wenn eine Gruppe nicht alle benutzt.
  function presetColors(preset) {
    const map = new Map();
    const used = new Set();
    const rest = [];
    for (const name of preset || []) {
      const key = String(name).toLowerCase();
      const rule = CATEGORY_RULES.find((r) => r[1].test(key));
      if (rule && !used.has(rule[0])) { map.set(key, rule[0]); used.add(rule[0]); } else rest.push(key);
    }
    let k = 0;
    for (const key of rest) {
      let idx = PRESET_ORDER.find((i) => !used.has(i));
      if (idx === undefined) idx = PRESET_ORDER[k++ % PRESET_ORDER.length];
      map.set(key, idx);
      used.add(idx);
    }
    return map;
  }

  function assignCategories(items, preset) {
    const byKey = new Map();
    for (const it of items) {
      if (!byKey.has(it.catKey)) byKey.set(it.catKey, { key: it.catKey, name: it.cat, ci: 0, count: 0 });
      byKey.get(it.catKey).count++;
    }
    const fixed = presetColors(preset);
    const used = new Set(fixed.values());
    for (const c of byKey.values()) {
      if (fixed.has(c.key)) { c.ci = fixed.get(c.key); continue; }
      const rule = CATEGORY_RULES.find((r) => r[1].test(c.key));
      if (rule) { c.ci = rule[0]; used.add(rule[0]); }
    }
    let k = 0;
    for (const c of byKey.values()) {
      if (c.ci) continue;
      let idx = FREE_ORDER.find((i) => !used.has(i));
      if (idx === undefined) idx = FREE_ORDER[k++ % FREE_ORDER.length];
      c.ci = idx;
      used.add(idx);
    }
    for (const it of items) it.ci = byKey.get(it.catKey).ci;
    return [...byKey.values()];
  }

  /* ---------- Ganzer Text ---------- */

  // Zusatzangaben in geschweiften Klammern, z. B. {bild:b1k9} {von:Lena und Tom} {quelle:Wikimedia Commons}
  const RX_META = /\{(bild|von|quelle):([^{}]*)\}/gi;

  function extractMeta(line) {
    const meta = {};
    const rest = line.replace(RX_META, (m, key, val) => {
      meta[key.toLowerCase()] = val.trim();
      return '';
    });
    return { meta, rest: rest.trim() };
  }

  // Zerlegt eine Zeile in Datum, Titel, Kategorie und Beschreibung. Trenner ist das
  // Semikolon; nur die ersten drei trennen, weitere bleiben in der Beschreibung.
  function splitLine(line) {
    const parts = line.split(';');
    return parts.slice(0, 3).concat(parts.length > 3 ? [parts.slice(3).join(';')] : []).map((p) => p.trim());
  }

  // preset: vorgegebene Kategorien der Lehrkraft, sie bestimmen die Farben (siehe presetColors)
  function parseSource(src, now, preset) {
    const items = [];
    const problems = [];
    const lines = String(src).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw || raw.startsWith('#')) continue;
      const { meta, rest: line } = extractMeta(raw);
      const parts = splitLine(line);
      if (parts.length < 2 || !parts[1]) {
        problems.push({ line: i, msg: 'Titel fehlt. Schreibweise: Datum; Titel; Kategorie; Beschreibung' });
        continue;
      }
      const r = parseDateField(parts[0], now);
      if (r.error) {
        problems.push({ line: i, msg: r.error });
        continue;
      }
      const cat = parts[2] || 'Allgemein';
      const it = {
        id: 'L' + i,
        line: i,
        title: parts[1],
        cat,
        catKey: cat.toLowerCase(),
        desc: parts[3] || '',
        kind: r.kind,
        a: r.a,
        b: r.b || null,
        start: r.start,
        end: r.end,
        img: meta.bild || '',
        von: meta.von || '',
        quelle: meta.quelle || '',
      };
      if (it.kind === 'point') {
        it.shortDate = fmtShort(it.a);
        it.longDate = fmtLong(it.a);
      } else if (r.label) {
        it.shortDate = r.label;
        it.longDate = `${r.longLabel} (${fmtYear(it.a)}–${fmtYear(it.b)})`;
      } else {
        it.shortDate = fmtRangeShort(it.a, it.b);
        it.longDate = fmtLong(it.a) + ' bis ' + fmtLong(it.b);
      }
      items.push(it);
    }
    const cats = assignCategories(items, preset);
    return { items, problems, cats };
  }

  // Macht Text aus einem Formular zeilentauglich: keine Klammern oder Umbrüche
  function cleanField(s) {
    return String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/[{}]/g, '').replace(/\s{2,}/g, ' ').trim();
  }

  // Baut eine Zeile im Zeitstrahl-Format, z. B. aus einem Schülerbeitrag. In Datum, Titel
  // und Kategorie wird ein Semikolon zum Komma, in der Beschreibung darf es stehen bleiben.
  function buildLine(e) {
    const head = (s) => cleanField(s).replace(/;/g, ',');
    const fields = [head(e.datum), head(e.titel), head(e.kategorie) || 'Allgemein', cleanField(e.beschreibung)];
    if (!fields[3]) fields.pop();
    let line = fields.join('; ');
    if (e.von) line += ` {von:${cleanField(e.von)}}`;
    if (e.quelle) line += ` {quelle:${cleanField(e.quelle)}}`;
    if (e.bild) line += ` {bild:${cleanField(e.bild)}}`;
    return line;
  }

  /* ---------- Tabellen (.csv) aus Excel, Numbers oder LibreOffice ---------- */

  // Zerlegt CSV-Text in Zeilen und Zellen. Anführungszeichen schützen Trennzeichen
  // und Zeilenumbrüche, "" steht für ein einzelnes Anführungszeichen.
  function splitCsv(text, sep) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"' && cell.trim() === '') { quoted = true; cell = ''; }
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // Deutsches Excel trennt mit Semikolon, andere Programme mit Komma oder Tabulator
  function guessSeparator(text) {
    const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
    const count = (ch) => first.replace(/"[^"]*"/g, '').split(ch).length - 1;
    return [';', '\t', ','].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ';');
  }

  const HEADS = {
    datum: /^(datum|jahr|zeit|zeitraum|wann)/i,
    titel: /^(titel|ereignis|was|name)/i,
    kategorie: /^(kategorie|bereich|art)/i,
    beschreibung: /^(beschreibung|text|erkl|notiz|info|details)/i,
  };

  // Tabelle → Zeilen im Format „Datum; Titel; Kategorie; Beschreibung“.
  // Eine Kopfzeile wird erkannt, wenn in ihrer ersten Zelle keine Ziffer steht;
  // dann zählen die Spaltennamen, sonst gilt die Reihenfolge Datum, Titel, Kategorie, Beschreibung.
  function tableToSource(text) {
    const rows = splitCsv(text.replace(/^\uFEFF/, ''), guessSeparator(text))
      .map((r) => r.map((c) => c.trim()))
      .filter((r) => r.some(Boolean));
    const cols = { datum: 0, titel: 1, kategorie: 2, beschreibung: 3 };
    if (rows.length && !/\d/.test(rows[0][0] || '')) {
      const head = rows.shift();
      const found = {};
      head.forEach((h, i) => {
        for (const k of Object.keys(HEADS)) if (found[k] === undefined && HEADS[k].test(h)) found[k] = i;
      });
      if (found.datum !== undefined) {
        for (const k of Object.keys(cols)) cols[k] = found[k] === undefined ? -1 : found[k];
      }
    }
    const cell = (r, k) => (cols[k] >= 0 ? r[cols[k]] || '' : '');
    return rows
      .map((r) => buildLine({ datum: cell(r, 'datum'), titel: cell(r, 'titel'), kategorie: cell(r, 'kategorie'), beschreibung: cell(r, 'beschreibung') }))
      .join('\n') + '\n';
  }

  return {
    parseSource,
    presetColors,
    splitLine,
    buildLine,
    tableToSource,
    cleanField,
    parseDate,
    parseDateField,
    parseCentury,
    toPos,
    fmtShort,
    fmtLong,
    agoText,
    durationText,
    CUM,
    MONTH_ABBR,
    MONTH_NAMES,
  };
});
