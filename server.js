#!/usr/bin/env node
/*
 * Zeitstrahl-Werkstatt · Klassenserver
 *
 * Start:  node server.js        (oder Doppelklick auf „Server starten“)
 *         node server.js 9000   (anderer Port, nur für diesen Start)
 *
 *   Lehrkraft:  http://localhost:8080          nur an diesem Laptop
 *   iPads:      http://<IP des Laptops>:8080   öffnet die Beitragsseite
 *
 * Der Port steht in einstellungen.txt (Zeile „port = 8080“).
 *
 * Beiträge der Schülerinnen und Schüler landen im Ordner daten/eingang,
 * die Zeitstrahlen der Lehrkraft zusätzlich in daten/sicherung.json.
 * Nichts verlässt diesen Laptop. Es werden keine Zusatzpakete benötigt.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'daten');
const INBOX = path.join(DATA, 'eingang');
const ARCHIVE = path.join(DATA, 'archiv');
const BACKUP = path.join(DATA, 'sicherung.json');
const SETTINGS_FILE = path.join(ROOT, 'einstellungen.txt');

const args = process.argv.slice(2);
const OPEN_BROWSER = !args.includes('--kein-browser');

// einstellungen.txt lesen: Zeilen wie „port = 8080“, # leitet Kommentare ein
function readSettings() {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    return out; // ohne Datei gelten die Standardwerte
  }
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.replace(/#.*$/, '').trim().match(/^([a-zäöü_-]+)\s*[=:]\s*(.+)$/i);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

// Vorrang: Startparameter (node server.js 9000) > Umgebungsvariable PORT > einstellungen.txt > 8080
function choosePort() {
  const raw = args.find((a) => /^\d+$/.test(a)) || process.env.PORT || readSettings().port || '8080';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`\nDer Port „${raw}“ ist ungültig. Bitte in einstellungen.txt eine Zahl zwischen 1024 und 65535 eintragen, z. B.:  port = 8080\n`);
    process.exit(1);
  }
  return port;
}
const PORT = choosePort();
const withPort = (host) => (PORT === 80 ? host : `${host}:${PORT}`);

const MAX_SUBMISSION = 25 * 1024 * 1024; // eine Einsendung (mehrere Beiträge mit Bildern)
const MAX_BACKUP = 200 * 1024 * 1024;    // Sicherung aller Zeitstrahlen
const MAX_ENTRIES = 20;                  // Beiträge pro Einsendung
const MAX_IMAGE = 6 * 1024 * 1024;       // ein Bild als data:-URL
const RATE_LIMIT = 20;                   // Einsendungen pro Minute und Gerät

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/* ---------- Wer fragt? ---------- */

// Lehrkraft = Anfrage vom Laptop selbst, über localhost aufgerufen
function isTeacher(req) {
  const addr = req.socket.remoteAddress || '';
  const fromHere = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return fromHere && (host === 'localhost' || host === '127.0.0.1' || host === '::1');
}

// Schutz vor fremden Webseiten, die im Browser der Lehrkraft Anfragen auslösen könnten:
// Der eigene Kopf erzwingt beim Browser eine Rückfrage, die dieser Server nie erlaubt.
const teacherApi = (req) => isTeacher(req) && req.headers['x-zeitstrahl'] === 'lehrkraft';

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  // Private Heim- und Schulnetze zuerst
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

/* ---------- Antworten ---------- */

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Die Daten sind zu groß.'), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const text = await readBody(req, limit);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw Object.assign(new Error('Die Daten sind beschädigt.'), { status: 400 });
  }
}

/* ---------- Dateien ausliefern ---------- */

const PUBLIC_DIRS = new Set(['css', 'js', 'fonts']);

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch (e) {
    return send(res, 400, 'Ungültige Adresse');
  }
  const teacher = isTeacher(req);
  if (rel === '' || rel === 'index.html') {
    if (!teacher) {
      // iPads landen immer auf der Beitragsseite
      res.writeHead(302, { Location: '/beitrag.html' });
      return res.end();
    }
    rel = 'index.html';
  }
  const parts = rel.split('/');
  const allowed = rel === 'index.html' || rel === 'beitrag.html' || (parts.length >= 2 && PUBLIC_DIRS.has(parts[0]));
  const file = path.resolve(ROOT, rel);
  if (!allowed || !file.startsWith(ROOT + path.sep) || !TYPES[path.extname(file)]) {
    return send(res, 404, 'Nicht gefunden');
  }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  } catch (e) {
    send(res, 404, 'Nicht gefunden');
  }
}

/* ---------- Beiträge ---------- */

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max).trim() : '');
const validImage = (s) => typeof s === 'string' && s.length <= MAX_IMAGE && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s);

function cleanEntry(b, top) {
  return {
    thema: str(top.thema, 140),
    von: str(top.von, 120),
    datum: str(b.datum, 80),
    titel: str(b.titel, 200),
    kategorie: str(b.kategorie, 60),
    beschreibung: str(b.beschreibung, 2000),
    bildquelle: str(b.bildquelle, 300),
    bild: validImage(b.bild) ? b.bild : '',
  };
}

const recent = new Map(); // Gerät → Zeitpunkte der letzten Einsendungen
function tooMany(req) {
  const key = req.socket.remoteAddress || '?';
  const now = Date.now();
  const list = (recent.get(key) || []).filter((t) => now - t < 60000);
  list.push(now);
  recent.set(key, list);
  return list.length > RATE_LIMIT;
}

async function receive(req, res) {
  if (tooMany(req)) return sendJson(res, 429, { fehler: 'Zu viele Einsendungen. Bitte kurz warten.' });
  const data = await readJson(req, MAX_SUBMISSION);
  const list = data && Array.isArray(data.beitraege) ? data.beitraege.slice(0, MAX_ENTRIES) : [];
  const entries = list
    .filter((b) => b && typeof b === 'object')
    .map((b) => cleanEntry(b, data))
    .filter((e) => e.titel && e.datum);
  if (!entries.length) return sendJson(res, 400, { fehler: 'Es wurde kein vollständiger Beitrag gesendet.' });

  await fsp.mkdir(INBOX, { recursive: true });
  const stamp = new Date();
  for (const e of entries) {
    const id = stamp.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + crypto.randomBytes(4).toString('hex');
    await fsp.writeFile(path.join(INBOX, id + '.json'), JSON.stringify({ id, empfangen: stamp.toISOString(), ...e }));
  }
  const names = entries.map((e) => `„${e.titel}“`).join(', ');
  console.log(`${stamp.toLocaleTimeString('de-DE')}  Neu: ${names}${entries[0].von ? ' (von ' + entries[0].von + ')' : ''}`);
  sendJson(res, 200, { ok: true, anzahl: entries.length });
}

async function inbox(res) {
  let files = [];
  try {
    files = (await fsp.readdir(INBOX)).filter((f) => f.endsWith('.json')).sort();
  } catch (e) { /* noch kein Eingang */ }
  const beitraege = [];
  for (const f of files) {
    try {
      beitraege.push(JSON.parse(await fsp.readFile(path.join(INBOX, f), 'utf8')));
    } catch (e) { /* unlesbare Datei überspringen */ }
  }
  sendJson(res, 200, { beitraege });
}

async function markDone(req, res) {
  const data = await readJson(req, 64 * 1024);
  const ids = Array.isArray(data.ids) ? data.ids.filter((id) => typeof id === 'string' && /^[0-9a-f-]{10,40}$/.test(id)) : [];
  await fsp.mkdir(ARCHIVE, { recursive: true });
  let moved = 0;
  for (const id of ids) {
    try {
      await fsp.rename(path.join(INBOX, id + '.json'), path.join(ARCHIVE, id + '.json'));
      moved++;
    } catch (e) { /* schon erledigt */ }
  }
  sendJson(res, 200, { ok: true, erledigt: moved });
}

/* ---------- Sicherung der Zeitstrahlen ---------- */

async function saveBackup(req, res) {
  const text = await readBody(req, MAX_BACKUP);
  try {
    const d = JSON.parse(text);
    if (!d || !Array.isArray(d.timelines)) throw new Error();
  } catch (e) {
    return sendJson(res, 400, { fehler: 'Ungültige Sicherung.' });
  }
  await fsp.mkdir(DATA, { recursive: true });
  const tmp = BACKUP + '.tmp';
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, BACKUP);
  sendJson(res, 200, { ok: true });
}

async function loadBackup(res) {
  try {
    send(res, 200, await fsp.readFile(BACKUP, 'utf8'), 'application/json; charset=utf-8');
  } catch (e) {
    sendJson(res, 200, { leer: true }); // noch keine Sicherung vorhanden
  }
}

/* ---------- Anfragen verteilen ---------- */

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/status' && m === 'GET') return sendJson(res, 200, { app: 'zeitstrahl-werkstatt', ok: true });
  if (p === '/api/beitraege' && m === 'POST') return receive(req, res);

  if (p.startsWith('/api/')) {
    if (!teacherApi(req)) return sendJson(res, 403, { fehler: 'Nur am Laptop der Lehrkraft erlaubt.' });
    if (p === '/api/verbindung' && m === 'GET') return sendJson(res, 200, { port: server.address().port, adressen: lanAddresses() });
    if (p === '/api/eingang' && m === 'GET') return inbox(res);
    if (p === '/api/eingang/erledigt' && m === 'POST') return markDone(req, res);
    if (p === '/api/sicherung' && m === 'GET') return loadBackup(res);
    if (p === '/api/sicherung' && m === 'PUT') return saveBackup(req, res);
    return sendJson(res, 404, { fehler: 'Unbekannte Anfrage.' });
  }

  if (m !== 'GET' && m !== 'HEAD') return send(res, 405, 'Nicht erlaubt');
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  return serveStatic(req, res, p);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) sendJson(res, err.status || 500, { fehler: err.status ? err.message : 'Interner Fehler.' });
    if (!err.status) console.error(err);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} ist schon belegt. Läuft der Server vielleicht schon in einem anderen Fenster?`);
    console.error(`Dann einfach dort weiterarbeiten: http://${withPort('localhost')}`);
    console.error('Belegt ein anderes Programm den Port, in einstellungen.txt einen anderen eintragen, z. B.:  port = 8090\n');
  } else if (err.code === 'EACCES') {
    console.error(`\nPort ${PORT} darf auf diesem Laptop nur mit Administratorrechten genutzt werden.`);
    console.error('Bitte in einstellungen.txt einen Port ab 1024 eintragen, z. B.:  port = 8080\n');
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const local = `http://${withPort('localhost')}`;
  const lan = lanAddresses();
  console.log('\n  Zeitstrahl-Werkstatt läuft.\n');
  console.log(`  Lehrkraft (dieser Laptop):  ${local}`);
  if (lan.length) {
    console.log(`  iPads der Klasse:           http://${withPort(lan[0])}`);
    for (const ip of lan.slice(1)) console.log(`                              http://${withPort(ip)}`);
  } else {
    console.log('  Keine Netzwerkverbindung gefunden. Ist der Laptop im WLAN?');
  }
  console.log(`\n  Port ${PORT} (änderbar in einstellungen.txt)`);
  console.log('  Zum Beenden dieses Fenster schließen oder Strg+C drücken.\n');
  if (OPEN_BROWSER) {
    const cmd = process.platform === 'win32' ? `start "" "${local}"` : process.platform === 'darwin' ? `open "${local}"` : `xdg-open "${local}"`;
    exec(cmd, () => {});
  }
});
