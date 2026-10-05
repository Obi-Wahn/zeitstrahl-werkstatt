/*
 * Zeitstrahl-Werkstatt · Gespeicherten Stand beim Start wählen
 *
 * Mit Server gilt nur der Ordner daten auf dem Laptop. Ist er leer, etwa nach
 * einem frischen Clone, startet die Seite leer, auch wenn der Browser noch
 * Zeitstrahlen von früher kennt. Die lassen sich über „Datei → Öffnen“ holen.
 * Nur wenn der Server nicht antwortet, hilft am Laptop der Stand im Browser aus.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZeitstrahlStand = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // ladeServer liefert den Stand, null bei leerem Ordner und undefined, wenn der Server nicht antwortet
  async function waehlen({ serverAn, lehrerPc, ladeServer, ladeBrowser }) {
    if (serverAn) {
      const d = await ladeServer();
      if (d !== undefined || lehrerPc) return d || null;
    }
    return ladeBrowser();
  }

  return { waehlen };
});
