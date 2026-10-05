/*
 * Zeitstrahl-Werkstatt · ZIP-Dateien
 *
 * Packt mehrere Dateien in eine ZIP-Datei und liest sie wieder aus, ganz ohne
 * Zusatzbibliothek. Beim Packen werden die Dateien nur gesammelt, nicht
 * verkleinert (Bilder sind ohnehin schon verkleinert). Beim Lesen werden auch
 * ZIP-Dateien verstanden, die Windows oder macOS selbst gepackt haben.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZeitstrahlZip = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Prüfsumme, die jede Datei in einer ZIP-Datei braucht
  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Datum und Uhrzeit im Format von MS-DOS, wie ZIP es verlangt
  function dosTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  // files: [{ name: 'ordner/datei.json', data: Uint8Array }]
  function erstellen(files, when) {
    const enc = new TextEncoder();
    const { time, date } = dosTime(when || new Date());
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034B50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // Dateinamen in UTF-8 (Umlaute)
      local.setUint16(8, 0, true);      // nicht verkleinert
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      parts.push(new Uint8Array(local.buffer), name, f.data);

      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014B50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, time, true);
      c.setUint16(14, date, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, size, true);
      c.setUint32(24, size, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + size;
    }
    const centralSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of all) { out.set(p, pos); pos += p.length; }
    return out;
  }

  async function entpacken(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Dieser Browser kann gepackte ZIP-Dateien nicht öffnen.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Liefert alle Dateien einer ZIP-Datei: [{ name, data: Uint8Array }]
  async function lesen(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054B50) { end = i; break; }
    }
    if (end < 0) throw new Error('Keine gültige ZIP-Datei.');
    const count = view.getUint16(end + 10, true);
    let p = view.getUint32(end + 16, true);
    const utf8 = new TextDecoder('utf-8');
    const latin = new TextDecoder('windows-1252');
    const out = [];
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014B50) throw new Error('Die ZIP-Datei ist beschädigt.');
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const packed = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localAt = view.getUint32(p + 42, true);
      const rawName = bytes.subarray(p + 46, p + 46 + nameLen);
      const name = (flags & 0x0800 ? utf8 : latin).decode(rawName);
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue; // Ordner
      const start = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
      const raw = bytes.subarray(start, start + packed);
      if (method === 0) out.push({ name, data: raw });
      else if (method === 8) out.push({ name, data: await entpacken(raw) });
      // andere Verfahren kommen bei Windows und macOS nicht vor
    }
    return out;
  }

  return { erstellen, lesen, crc32 };
});
