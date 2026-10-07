/*
 * Zeitstrahl-Werkstatt · Gemeinsame Hilfen
 * Für die Lehrkraft-Ansicht, die Schülerseite und den Server (Dateinamen, Bildprüfung).
 * Was das Dokument braucht (Hinweise, Farben, Herunterladen, Drucken), wird erst beim Aufruf benutzt.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZeitstrahlGemeinsam = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Dateiname aus einem Titel: „Weimarer Republik“ → weimarer-republik
  function slug(name) {
    const s = String(name || '').toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return s || 'zeitstrahl';
  }

  // Text aus einer Datei oder Anfrage: nur Zeichenketten, gekürzt und ohne Leerraum am Rand
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max).trim() : '');

  // Bilder stecken als data:-URL in den Zeitstrahlen
  // Vorgegebene Kategorien der Lehrkraft: höchstens 8 (so viele Farben gibt es), ohne doppelte.
  // Semikolon und Klammern würden die Zeile zerlegen, Kommas trennen die Liste beim Eintippen.
  const MAX_KATEGORIEN = 8;
  function cleanKategorien(list) {
    const seen = new Set();
    const out = [];
    for (const v of Array.isArray(list) ? list : []) {
      const k = str(v, 40).replace(/[;,{}]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (!k || seen.has(k.toLowerCase())) continue;
      seen.add(k.toLowerCase());
      out.push(k);
      if (out.length === MAX_KATEGORIEN) break;
    }
    return out;
  }

  const validImage = (s) => typeof s === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s);

  /* ---------- Nur im Browser ---------- */

  // Kurzer Hinweis unten auf der Seite (Element mit id „toast“)
  let toastTimer = 0;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Fertige Seite (SVG) als PNG herunterladen. Sperrt der Browser das Umwandeln,
  // gibt es die Seite als SVG-Bild, das sich ebenso drucken lässt.
  function savePng(markup, w, h, name, okMsg) {
    const asSvg = () => download(name + '.svg', new Blob([markup], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      try {
        c.toBlob((blob) => {
          if (blob) { download(name + '.png', blob); toast(okMsg); } else asSvg();
        }, 'image/png');
      } catch (e) {
        asSvg();
        toast('Als SVG-Bild gesichert.');
      }
    };
    img.onerror = () => toast('Das Bild konnte nicht erzeugt werden.');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  }

  // Fertige Seite (SVG) drucken oder im Druckfenster als PDF sichern. Sie kommt kurz in das
  // Element mit id „print-area“; Querformat und Seitenrand stehen im Druck-Stil in css/style.css.
  function printSvg(markup) {
    const area = document.getElementById('print-area');
    area.innerHTML = markup;
    document.body.classList.add('printing');
    const done = () => {
      document.body.classList.remove('printing');
      area.textContent = '';
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1000); // Browser ohne afterprint (ältere Safari-Versionen)
  }

  // Textbreite in Pixeln, mit Zwischenspeicher, weil das Layout viel misst
  const mcache = new Map();
  let mctx = null;
  function measure(text, weight, size, fam) {
    const key = weight + '|' + size.toFixed(2) + '|' + fam + '|' + text;
    let w = mcache.get(key);
    if (w === undefined) {
      if (!mctx) mctx = document.createElement('canvas').getContext('2d');
      mctx.font = `${weight} ${size.toFixed(2)}px ${fam}`;
      w = mctx.measureText(text).width;
      if (mcache.size > 5000) mcache.clear();
      mcache.set(key, w);
    }
    return w;
  }
  // Nach dem Laden der Schriften stimmen gemessene Breiten nicht mehr
  const clearMeasure = () => mcache.clear();

  // Farben: automatisch (wie das Gerät), hell oder „Tafel“ (dunkel)
  const THEMES = { system: 'Farben: automatisch', light: 'Farben: hell', dark: 'Farben: Tafel' };
  // Setzt die Farben und liefert die gültige Wahl zurück
  function setTheme(t) {
    const theme = THEMES[t] ? t : 'system';
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    return theme;
  }
  // Was gerade zu sehen ist. Umschalten geht immer ins Gegenteil davon: „automatisch“ kann im
  // Dunkelmodus wie „Tafel“ aussehen, ein Schritt dorthin würde dann scheinbar nichts tun.
  const shownTheme = (theme) => (theme !== 'system' ? theme
    : window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  // Knopf, der nur ein Symbol zeigt: Name der Farben im Tooltip
  function labelThemeIcon(b, theme) {
    b.setAttribute('aria-label', THEMES[theme]);
    b.title = THEMES[theme] + ' (zum Umschalten klicken)';
  }

  return { slug, str, cleanKategorien, MAX_KATEGORIEN, validImage, toast, download, savePng, printSvg, measure, clearMeasure, THEMES, setTheme, shownTheme, labelThemeIcon };
});
