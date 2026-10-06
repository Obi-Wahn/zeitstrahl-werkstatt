/*
 * Zeitstrahl-Werkstatt · Gemeinsame Hilfen
 * Für die Lehrkraft-Ansicht, die Schülerseite und den Server (Dateinamen, Bildprüfung).
 * Was das Dokument braucht (Hinweise, Farben, Herunterladen), wird erst beim Aufruf benutzt.
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

  return { slug, str, validImage, toast, download, measure, clearMeasure, THEMES, setTheme, shownTheme, labelThemeIcon };
});
