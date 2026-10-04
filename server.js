#!/usr/bin/env node
/*
 * Zeitstrahl-Werkstatt · Klassenserver
 *
 * Start:  node server.js        (oder Doppelklick auf „Server starten“)
 *         node server.js 9000   (anderer Port, nur für diesen Start)
 *
 *   Lehrkraft:  http://localhost:8080          nur an diesem Laptop
 *   iPads:      http://<IP des Laptops>:8080   öffnet die Schülerseite
 *
 * Der Port steht in einstellungen.txt (Zeile „port = 8080“).
 *
 * Ablauf: Die Lehrkraft gibt ein Thema vor (daten/aufgabe.json). Schülerinnen
 * und Schüler bauen dazu auf dem iPad je einen eigenen Zeitstrahl und speichern
 * ihn hier (daten/abgaben). Mit einem kurzen Code arbeiten sie später weiter.
 * Die Zeitstrahlen der Lehrkraft liegen zusätzlich in daten/sicherung.json.
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
const ABGABEN = path.join(DATA, 'abgaben');
const ARCHIVE = path.join(DATA, 'archiv');
const TASK = path.join(DATA, 'aufgabe.json');
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

const MAX_SUBMISSION = 80 * 1024 * 1024; // ein Schüler-Zeitstrahl mit Bildern
const MAX_BACKUP = 200 * 1024 * 1024;    // Sicherung aller Zeitstrahlen der Lehrkraft
const MAX_ENTRIES = 80;                  // Ereignisse pro Schüler-Zeitstrahl
const MAX_IMAGE = 6 * 1024 * 1024;       // ein Bild als data:-URL
const RATE_LIMIT = 30;                   // Speichervorgänge pro Minute und Gerät
const CODE_TRIES = 10;                   // falsche Codes pro Minute und Gerät

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
      // iPads landen immer auf der Schülerseite
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

/* ---------- Hilfen ---------- */

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max).trim() : '');
const validImage = (s) => typeof s === 'string' && s.length <= MAX_IMAGE && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s);
const time = () => new Date().toLocaleTimeString('de-DE');

async function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

// Zählt Anfragen je Gerät in der letzten Minute
function limiter(max) {
  const seen = new Map();
  return (req, count = true) => {
    const key = req.socket.remoteAddress || '?';
    const now = Date.now();
    const list = (seen.get(key) || []).filter((t) => now - t < 60000);
    if (count) list.push(now);
    seen.set(key, list);
    return list.length > max;
  };
}
const tooManySaves = limiter(RATE_LIMIT);
const tooManyWrongCodes = limiter(CODE_TRIES);

/* ---------- Aufgabe: das Thema der Lehrkraft ---------- */

async function readTask() {
  try {
    const d = JSON.parse(await fsp.readFile(TASK, 'utf8'));
    return { thema: str(d.thema, 140), auftrag: str(d.auftrag, 1000) };
  } catch (e) {
    return { thema: '', auftrag: '' };
  }
}

async function saveTask(req, res) {
  const d = await readJson(req, 64 * 1024);
  const task = { thema: str(d.thema, 140), auftrag: str(d.auftrag, 1000), aktualisiert: new Date().toISOString() };
  await fsp.mkdir(DATA, { recursive: true });
  await writeAtomic(TASK, JSON.stringify(task));
  console.log(`${time()}  Thema vorgegeben: „${task.thema || '(frei wählbar)'}“`);
  sendJson(res, 200, task);
}

/* ---------- Schüler-Zeitstrahlen ---------- */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne I, O, 0, 1: leicht zu verwechseln
const ID_RX = /^[a-f0-9]{16}$/;
const CODE_RX = /^[A-HJ-NP-Z2-9]{5}$/;
const newCode = () => [...crypto.randomBytes(5)].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

// Übersicht im Speicher, damit die Lehrkraft-Ansicht nicht ständig alle Bilder liest
const index = new Map();

function summary(a) {
  return {
    id: a.id,
    code: a.code,
    thema: a.thema,
    titel: a.titel,
    von: a.von,
    status: a.status,
    anzahl: a.eintraege.length,
    bilder: a.eintraege.filter((e) => e.bild).length,
    erstellt: a.erstellt,
    aktualisiert: a.aktualisiert,
  };
}

function loadIndex() {
  let files = [];
  try {
    files = fs.readdirSync(ABGABEN).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return; // noch keine Abgaben
  }
  for (const f of files) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(ABGABEN, f), 'utf8'));
      if (ID_RX.test(a.id) && Array.isArray(a.eintraege)) index.set(a.id, summary(a));
    } catch (e) { /* unlesbare Datei überspringen */ }
  }
}

function cleanEntries(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, MAX_ENTRIES)
    .filter((b) => b && typeof b === 'object')
    .map((b) => ({
      datum: str(b.datum, 80),
      titel: str(b.titel, 200),
      kategorie: str(b.kategorie, 60),
      beschreibung: str(b.beschreibung, 2000),
      bildquelle: str(b.bildquelle, 300),
      bild: validImage(b.bild) ? b.bild : '',
    }))
    .filter((e) => e.titel && e.datum);
}

// Neu anlegen oder – mit passendem Code – aktualisieren
async function saveAbgabe(req, res) {
  if (tooManySaves(req)) return sendJson(res, 429, { fehler: 'Zu viele Speichervorgänge. Bitte kurz warten.' });
  const d = await readJson(req, MAX_SUBMISSION);
  const von = str(d.von, 120);
  const eintraege = cleanEntries(d.eintraege);
  if (!von) return sendJson(res, 400, { fehler: 'Bitte bei „Erstellt von“ eure Vornamen eintragen.' });
  if (!eintraege.length) return sendJson(res, 400, { fehler: 'Der Zeitstrahl hat noch kein vollständiges Ereignis.' });

  let old = null;
  if (typeof d.id === 'string' && index.has(d.id)) {
    old = index.get(d.id);
    if (old.code !== d.code) return sendJson(res, 403, { fehler: 'Der Code passt nicht zu diesem Zeitstrahl.' });
  }
  const codes = new Set([...index.values()].map((x) => x.code));
  let code = old ? old.code : newCode();
  while (!old && codes.has(code)) code = newCode();
  const task = await readTask();
  const now = new Date().toISOString();
  const abgabe = {
    id: old ? old.id : crypto.randomBytes(8).toString('hex'),
    code,
    // Das Thema legt die Lehrkraft fest; nur ohne Vorgabe gilt das der Schüler
    thema: old ? old.thema : task.thema || str(d.thema, 140) || 'Ohne Thema',
    titel: str(d.titel, 140),
    von,
    status: d.status === 'abgegeben' ? 'abgegeben' : 'entwurf',
    erstellt: old ? old.erstellt : now,
    aktualisiert: now,
    eintraege,
  };
  await fsp.mkdir(ABGABEN, { recursive: true });
  await writeAtomic(path.join(ABGABEN, abgabe.id + '.json'), JSON.stringify(abgabe));
  index.set(abgabe.id, summary(abgabe));
  const what = abgabe.status === 'abgegeben' ? 'Abgegeben' : 'Zwischengespeichert';
  console.log(`${time()}  ${what}: „${abgabe.titel || abgabe.thema}“ von ${von} (${eintraege.length} Ereignisse, Code ${code})`);
  sendJson(res, 200, { id: abgabe.id, code, thema: abgabe.thema, status: abgabe.status, aktualisiert: now });
}

async function sendAbgabe(res, id) {
  try {
    send(res, 200, await fsp.readFile(path.join(ABGABEN, id + '.json'), 'utf8'), 'application/json; charset=utf-8');
  } catch (e) {
    sendJson(res, 404, { fehler: 'Diesen Zeitstrahl gibt es nicht mehr.' });
  }
}

// Schüler holen ihren Zeitstrahl mit dem Code zurück, um weiterzuarbeiten
async function loadByCode(req, res, raw) {
  if (tooManyWrongCodes(req, false)) return sendJson(res, 429, { fehler: 'Zu viele falsche Codes. Bitte eine Minute warten.' });
  const code = String(raw).toUpperCase();
  const hit = CODE_RX.test(code) ? [...index.values()].find((x) => x.code === code) : null;
  if (!hit) {
    tooManyWrongCodes(req);
    return sendJson(res, 404, { fehler: 'Zu diesem Code gibt es keinen Zeitstrahl. Bitte den Code prüfen.' });
  }
  return sendAbgabe(res, hit.id);
}

async function archiveAbgabe(res, id) {
  await fsp.mkdir(ARCHIVE, { recursive: true });
  try {
    await fsp.rename(path.join(ABGABEN, id + '.json'), path.join(ARCHIVE, id + '.json'));
  } catch (e) { /* schon entfernt */ }
  index.delete(id);
  sendJson(res, 200, { ok: true });
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

  let mm;

  // Für alle Geräte (Schülerseite)
  if (p === '/api/status' && m === 'GET') return sendJson(res, 200, { app: 'zeitstrahl-werkstatt', ok: true });
  if (p === '/api/aufgabe' && m === 'GET') return sendJson(res, 200, await readTask());
  if (p === '/api/abgaben' && m === 'POST') return saveAbgabe(req, res);
  if ((mm = p.match(/^\/api\/abgaben\/code\/([A-Za-z0-9]{1,10})$/)) && m === 'GET') return loadByCode(req, res, mm[1]);

  // Nur am Laptop der Lehrkraft
  if (p.startsWith('/api/')) {
    if (!teacherApi(req)) return sendJson(res, 403, { fehler: 'Nur am Laptop der Lehrkraft erlaubt.' });
    if (p === '/api/verbindung' && m === 'GET') return sendJson(res, 200, { port: server.address().port, adressen: lanAddresses() });
    if (p === '/api/aufgabe' && m === 'PUT') return saveTask(req, res);
    if (p === '/api/abgaben' && m === 'GET') {
      const list = [...index.values()].sort((a, b) => a.thema.localeCompare(b.thema, 'de') || a.erstellt.localeCompare(b.erstellt));
      return sendJson(res, 200, { abgaben: list });
    }
    if ((mm = p.match(/^\/api\/abgaben\/([a-f0-9]{16})$/))) {
      if (m === 'GET') return sendAbgabe(res, mm[1]);
      if (m === 'DELETE') return archiveAbgabe(res, mm[1]);
    }
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

loadIndex();
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
