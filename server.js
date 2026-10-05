#!/usr/bin/env node
/*
 * Zeitstrahl-Werkstatt · Klassenserver
 *
 * Start:  node server.js        (oder npm start, oder Doppelklick auf starten-windows.bat,
 *                               starten-mac.command bzw. starten-linux.sh)
 *         node server.js 9000   (anderer Port, nur für diesen Start)
 *
 *   Lehrkraft:  http://localhost:8080          an diesem Laptop
 *   Lehrer-PC:  http://<IP des Laptops>:8080/lehrkraft   mit Passwort, siehe unten
 *
 *         node server.js --passwort   Passwort für andere Geräte festlegen oder ändern
 *   iPads:      http://<IP des Laptops>:8080   öffnet die Schülerseite
 *
 * Port und Passwort stehen in einstellungen.txt. Die Datei legt der Server beim
 * ersten Start an, sie gehört nicht ins Repository.
 *
 * Ablauf: Die Lehrkraft gibt ein Thema vor (daten/aufgabe.json). Schülerinnen
 * und Schüler bauen dazu auf dem iPad je einen eigenen Zeitstrahl und speichern
 * ihn hier (daten/abgaben). Mit einem kurzen Code arbeiten sie später weiter.
 * Die Zeitstrahlen der Lehrkraft liegen zusätzlich je als eigene Datei in
 * daten/zeitstrahlen, dazu je Tag eine Kopie in daten/sicherungen (die letzten 14 bleiben).
 * Beim ersten Start fragt das Server-Fenster nach einem Passwort. Mit ihm kommt die
 * Lehrkraft auch von einem anderen Gerät im Netz in die Lehrkraft-Ansicht, z. B. vom
 * Lehrer-PC am Beamer oder wenn der Server ohne Bildschirm läuft. Gespeichert wird
 * nur ein Hash in einstellungen.txt.
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
const TIMELINES = path.join(DATA, 'zeitstrahlen');
const DELETED = path.join(TIMELINES, 'geloescht');
const ORDER_FILE = '_reihenfolge.json';    // Reihenfolge und zuletzt gezeigter Zeitstrahl
const OLD_BACKUP = path.join(DATA, 'sicherung.json'); // frühere Sicherung in einer Datei
const BACKUP_DAYS = path.join(DATA, 'sicherungen');
const KEEP_DAYS = 14;                    // so viele Tagessicherungen bleiben liegen
const SETTINGS_FILE = path.join(ROOT, 'einstellungen.txt'); // Port und Passwort-Hash

const args = process.argv.slice(2);
const OPEN_BROWSER = !args.includes('--kein-browser');
const ASK_PASSWORD = args.includes('--passwort');

// So sieht einstellungen.txt beim ersten Start aus. Die Zeile „passwort“
// ergänzt der Server, sobald das Passwort festgelegt ist.
const SETTINGS_TEMPLATE = `# Einstellungen für den Klassenserver der Zeitstrahl-Werkstatt
# Nach einer Änderung das Server-Fenster schließen und neu starten.

# Port, unter dem die Werkstatt erreichbar ist.
# Üblich sind Werte ab 1024, z. B. 8080 oder 8090.
# Die iPads öffnen dann z. B. 192.168.178.23:8080
port = 8080

# Passwort für die Lehrkraft-Ansicht an anderen Geräten, z. B. am Lehrer-PC.
# Hier steht nur ein Hash, nicht das Passwort selbst. „aus“ heißt: nur an diesem Laptop.
# Festlegen oder ändern: node server.js --passwort
`;

function ensureSettingsFile() {
  if (fs.existsSync(SETTINGS_FILE)) return;
  try {
    fs.writeFileSync(SETTINGS_FILE, SETTINGS_TEMPLATE);
  } catch (e) {
    console.error(`einstellungen.txt ließ sich nicht anlegen: ${e.message}`);
  }
}

// Eine Einstellung setzen. Andere Zeilen und Kommentare bleiben, wie sie sind.
function writeSetting(key, value) {
  let text = SETTINGS_TEMPLATE;
  try {
    text = fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) { /* Vorlage nehmen */ }
  const line = `${key} = ${value}`;
  const rx = new RegExp(`^\\s*${key}\\s*[=:].*$`, 'im');
  text = rx.test(text) ? text.replace(rx, line) : text.replace(/\s*$/, '\n') + line + '\n';
  fs.writeFileSync(SETTINGS_FILE, text);
}

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

ensureSettingsFile();

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
const LOGIN_TRIES = 10;                  // falsche Passwörter pro Minute und Gerät
const MIN_PASSWORD = 6;                  // Mindestlänge des Passworts
const SESSION_HOURS = 12;                // so lange bleibt ein anderes Gerät angemeldet
const COOKIE = 'zeitstrahl-lehrkraft';

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

// Anfrage vom Laptop selbst, über localhost aufgerufen
function isLocal(req) {
  const addr = req.socket.remoteAddress || '';
  const fromHere = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return fromHere && (host === 'localhost' || host === '127.0.0.1' || host === '::1');
}

// Lehrkraft = am Laptop selbst oder an einem anderen Gerät mit Passwort angemeldet
const isTeacher = (req) => isLocal(req) || hasSession(req);

// Schutz vor fremden Webseiten, die im Browser der Lehrkraft Anfragen auslösen könnten:
// Der eigene Kopf erzwingt beim Browser eine Rückfrage, die dieser Server nie erlaubt.
const teacherApi = (req) => isTeacher(req) && req.headers['x-zeitstrahl'] === 'lehrkraft';
const localApi = (req) => isLocal(req) && req.headers['x-zeitstrahl'] === 'lehrkraft';

/* ---------- Zugang von anderen Geräten (Lehrer-PC) ---------- */

// Angemeldete Geräte: Schlüssel im Cookie → Zeitpunkt der Anmeldung. Nach einem
// Neustart des Servers oder einem neuen Passwort melden sich alle Geräte neu an.
const sessions = new Map();

function cookieValue(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// Abgelaufene Anmeldungen entfernen, damit sie nicht mehr mitgezählt werden
function dropExpiredSessions() {
  for (const [token, since] of sessions) {
    if (Date.now() - since > SESSION_HOURS * 3600000) sessions.delete(token);
  }
}

function hasSession(req) {
  const token = cookieValue(req, COOKIE);
  const since = token && sessions.get(token);
  if (!since) return false;
  if (Date.now() - since > SESSION_HOURS * 3600000) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Zeile „passwort“ in einstellungen.txt: „scrypt:<salt>:<hash>“, oder „aus“, wenn
// beim ersten Start bewusst kein Passwort gewählt wurde. Fehlt sie, fragt der Start.
const passwordDecided = () => 'passwort' in readSettings();

function readAccess() {
  const m = /^scrypt:([0-9a-f]{32}):([0-9a-f]{64})$/.exec(readSettings().passwort || '');
  return m ? { salt: m[1], hash: m[2] } : null;
}

const hashPassword = (pw, salt) => crypto.scryptSync(String(pw).normalize('NFC'), salt, 32).toString('hex');

function checkPassword(pw) {
  const a = readAccess();
  if (!a || typeof pw !== 'string' || !pw) return false;
  return crypto.timingSafeEqual(Buffer.from(hashPassword(pw, a.salt), 'hex'), Buffer.from(a.hash, 'hex'));
}

function accessInfo() {
  dropExpiredSessions();
  return { passwort: !!readAccess(), angemeldet: sessions.size };
}

function loginPage(res, hinweis) {
  let html;
  try {
    html = fs.readFileSync(path.join(ROOT, 'anmelden.html'), 'utf8');
  } catch (e) {
    return send(res, 500, 'anmelden.html fehlt');
  }
  const text = !readAccess()
    ? 'Es ist noch kein Passwort festgelegt. Dafür den Server einmal mit „node server.js --passwort“ starten.'
    : hinweis === 'falsch' ? 'Das Passwort stimmt nicht.'
      : hinweis === 'gesperrt' ? 'Zu viele falsche Versuche. Bitte eine Minute warten.'
        : hinweis === 'abgemeldet' ? 'Abgemeldet.' : '';
  html = html.replace('<!--hinweis-->', text ? `<p class="login-msg" role="alert">${escHtml(text)}</p>` : '');
  send(res, 200, html, TYPES['.html']);
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function login(req, res) {
  const back = (hinweis) => {
    res.writeHead(303, { Location: '/lehrkraft' + (hinweis ? '?hinweis=' + hinweis : ''), 'Cache-Control': 'no-store' });
    res.end();
  };
  if (tooManyWrongLogins(req, false)) return back('gesperrt');
  const pw = new URLSearchParams(await readBody(req, 4096)).get('passwort');
  if (!checkPassword(pw)) {
    tooManyWrongLogins(req);
    console.log(`${time()}  Falsches Passwort für die Lehrkraft-Ansicht, von ${req.socket.remoteAddress}`);
    return back('falsch');
  }
  dropExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  console.log(`${time()}  Lehrkraft-Ansicht geöffnet von ${req.socket.remoteAddress}`);
  res.writeHead(303, {
    Location: '/lehrkraft',
    'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
    'Cache-Control': 'no-store',
  });
  res.end();
}

function logout(req, res) {
  sessions.delete(cookieValue(req, COOKIE));
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    'Cache-Control': 'no-store',
  });
  res.end('{"ok":true}');
}

// Virtuelle Adapter (VirtualBox, VMware, Hyper-V/WSL, Docker, VPN, Bluetooth) und der
// Windows-Hotspot („LAN-Verbindung* 10“, 192.168.137.x) sind für die iPads nicht gedacht.
const VIRTUAL_ADAPTER = /virtualbox|vbox|vmware|vmnet|vethernet|hyper-v|wsl|docker|^br-|virbr|^veth|bluetooth|tailscale|zerotier|wireguard|^utun|^tun|^tap|^awdl|^llw|^bridge|\*\s*\d+$/i;
// Windows nennt manche virtuellen Adapter nur „Ethernet 2“, sie sind dann an der
// Hardware-Adresse erkennbar: VirtualBox 0a:00:27/08:00:27, VMware 00:50:56/00:0c:29, Hyper-V 00:15:5d.
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:15:5d|02:42)/i;
const isRealAdapter = (a) => !VIRTUAL_ADAPTER.test(a.name) && !VIRTUAL_MAC.test(a.mac || '') && !/^192\.168\.137\./.test(a.ip);

function lanAddresses() {
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) all.push({ name, ip: a.address, mac: a.mac });
    }
  }
  // Nur echte WLAN- und LAN-Adapter. Bleibt keiner übrig, lieber alle zeigen als keine.
  const real = all.filter(isRealAdapter);
  const out = (real.length ? real : all).map((a) => a.ip);
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
  if (rel === '' || rel === 'index.html') {
    if (!isLocal(req)) {
      // iPads landen immer auf der Schülerseite, angemeldete Geräte in der Lehrkraft-Ansicht
      res.writeHead(302, { Location: hasSession(req) ? '/lehrkraft' : '/beitrag.html' });
      return res.end();
    }
    rel = 'index.html';
  }
  // Erst den Pfad auflösen, dann prüfen: „css/../server.js“ ist server.js
  const file = path.resolve(ROOT, rel);
  const parts = path.relative(ROOT, file).split(path.sep);
  const allowed = (parts.length === 1 && (parts[0] === 'index.html' || parts[0] === 'beitrag.html'))
    || (parts.length >= 2 && PUBLIC_DIRS.has(parts[0]));
  if (!allowed || !file.startsWith(ROOT + path.sep) || !TYPES[path.extname(file)]) {
    return send(res, 404, 'Nicht gefunden');
  }
  return sendFile(res, file);
}

async function sendFile(res, file) {
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

// Erst in eine eigene Zwischendatei schreiben, dann umbenennen. So liegt immer eine
// vollständige Datei da, auch wenn zwei Anfragen gleichzeitig dieselbe Datei schreiben.
async function writeAtomic(file, text) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, text);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

// Zwischendateien, die bei einem Absturz mitten im Schreiben liegen geblieben sind
function removeTmp(dir) {
  try {
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) fs.unlinkSync(path.join(dir, f));
  } catch (e) { /* Ordner gibt es noch nicht */ }
}

// Arbeitsschritte mit demselben Schlüssel nacheinander ausführen. Sonst liest z. B.
// die Rückmeldung der Lehrkraft einen Zeitstrahl, während die Gruppe ihn gerade
// speichert, und schreibt danach den alten Stand zurück.
const queues = new Map();
function oneAfterAnother(key, fn) {
  const job = (queues.get(key) || Promise.resolve()).then(fn);
  const tail = job.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return job;
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
const tooManyWrongLogins = limiter(LOGIN_TRIES);

/* ---------- Aufgabe: das Thema der Lehrkraft ---------- */

async function readTask() {
  try {
    const d = JSON.parse(await fsp.readFile(TASK, 'utf8'));
    return { thema: str(d.thema, 140), auftrag: str(d.auftrag, 1000), gesperrt: d.gesperrt === true };
  } catch (e) {
    return { thema: '', auftrag: '', gesperrt: false };
  }
}

async function saveTask(req, res) {
  const d = await readJson(req, 64 * 1024);
  const alt = await readTask();
  // Nur das Schloss umlegen: Thema und Auftrag bleiben, wie sie sind
  const nurSperre = d.thema === undefined && d.auftrag === undefined;
  const task = {
    thema: nurSperre ? alt.thema : str(d.thema, 140),
    auftrag: nurSperre ? alt.auftrag : str(d.auftrag, 1000),
    gesperrt: d.gesperrt === true,
    aktualisiert: new Date().toISOString(),
  };
  await fsp.mkdir(DATA, { recursive: true });
  await writeAtomic(TASK, JSON.stringify(task));
  if (nurSperre) console.log(`${time()}  ${task.gesperrt ? 'Abgabe beendet' : 'Bearbeiten wieder erlaubt'}: „${task.thema || '(ohne Thema)'}“`);
  else console.log(`${time()}  Thema vorgegeben: „${task.thema || '(frei wählbar)'}“`);
  sendJson(res, 200, task);
}

/* ---------- Schüler-Zeitstrahlen ---------- */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne I, O, 0, 1: leicht zu verwechseln
const ID_RX = /^[a-f0-9]{16}$/;
const CODE_RX = /^[A-HJ-NP-Z2-9]{5}$/;
const newCode = () => [...crypto.randomBytes(5)].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

// Übersicht im Speicher, damit die Lehrkraft-Ansicht nicht ständig alle Bilder liest
const index = new Map();

// Lesbarer Dateiname, z. B. reformation-lena-und-tom-K7M2X.json
const abgabeFile = (a) => `${slug(a.thema)}-${slug(a.von)}-${a.code}.json`;

function summary(a, datei) {
  return {
    id: a.id,
    datei,
    code: a.code,
    thema: a.thema,
    titel: a.titel,
    von: a.von,
    status: a.status,
    rueckmeldung: str(a.rueckmeldung, 1000),
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
      if (!ID_RX.test(a.id) || !CODE_RX.test(a.code) || !Array.isArray(a.eintraege)) continue;
      // Ältere Abgaben hießen nur nach ihrer Kennung (3f9a1c7e5b2d8a04.json)
      let datei = f;
      if (f !== abgabeFile(a) && !fs.existsSync(path.join(ABGABEN, abgabeFile(a)))) {
        fs.renameSync(path.join(ABGABEN, f), path.join(ABGABEN, abgabeFile(a)));
        datei = abgabeFile(a);
      }
      index.set(a.id, summary(a, datei));
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
  if ((await readTask()).gesperrt) {
    return sendJson(res, 423, { gesperrt: true, fehler: 'Die Lehrkraft hat die Abgabe beendet. Ihr könnt gerade nichts mehr speichern.' });
  }
  const von = str(d.von, 120);
  const eintraege = cleanEntries(d.eintraege);
  if (!von) return sendJson(res, 400, { fehler: 'Bitte bei „Erstellt von“ eure Vornamen eintragen.' });
  if (!eintraege.length) return sendJson(res, 400, { fehler: 'Der Zeitstrahl hat noch kein vollständiges Ereignis.' });
  // Neue Zeitstrahlen kommen gemeinsam in eine Schlange, damit zwei nie denselben Code bekommen
  return oneAfterAnother(typeof d.id === 'string' ? d.id : '', () => storeAbgabe(res, d, von, eintraege));
}

async function storeAbgabe(res, d, von, eintraege) {
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
    rueckmeldung: old ? old.rueckmeldung || '' : '',
    erstellt: old ? old.erstellt : now,
    aktualisiert: now,
    eintraege,
  };
  await fsp.mkdir(ABGABEN, { recursive: true });
  const datei = abgabeFile(abgabe);
  await writeAtomic(path.join(ABGABEN, datei), JSON.stringify(abgabe));
  // Haben sich die Namen geändert, heißt auch die Datei anders
  if (old && old.datei !== datei) await fsp.unlink(path.join(ABGABEN, old.datei)).catch(() => {});
  index.set(abgabe.id, summary(abgabe, datei));
  const what = abgabe.status === 'abgegeben' ? 'Abgegeben' : 'Zwischengespeichert';
  console.log(`${time()}  ${what}: „${abgabe.titel || abgabe.thema}“ von ${von} (${eintraege.length} Ereignisse, Code ${code})`);
  sendJson(res, 200, { id: abgabe.id, code, thema: abgabe.thema, status: abgabe.status, aktualisiert: now });
}

async function sendAbgabe(res, id) {
  try {
    if (!index.has(id)) throw new Error();
    send(res, 200, await fsp.readFile(path.join(ABGABEN, index.get(id).datei), 'utf8'), 'application/json; charset=utf-8');
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

// Die Lehrkraft schreibt der Gruppe eine kurze Rückmeldung. Die Gruppe sieht sie
// auf der Schülerseite, sobald sie mit ihrem Code arbeitet.
async function saveRueckmeldung(req, res, id) {
  const d = await readJson(req, 64 * 1024);
  return oneAfterAnother(id, () => storeRueckmeldung(res, id, str(d.rueckmeldung, 1000)));
}

async function storeRueckmeldung(res, id, text) {
  if (!index.has(id)) return sendJson(res, 404, { fehler: 'Diesen Zeitstrahl gibt es nicht mehr.' });
  const datei = index.get(id).datei;
  const file = path.join(ABGABEN, datei);
  let abgabe;
  try {
    abgabe = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    return sendJson(res, 404, { fehler: 'Diesen Zeitstrahl gibt es nicht mehr.' });
  }
  abgabe.rueckmeldung = text;
  abgabe.rueckmeldungAm = text ? new Date().toISOString() : '';
  await writeAtomic(file, JSON.stringify(abgabe));
  index.set(id, summary(abgabe, datei));
  console.log(`${time()}  Rückmeldung für „${abgabe.titel || abgabe.thema}“ von ${abgabe.von}: ${text ? `„${text}“` : '(entfernt)'}`);
  sendJson(res, 200, { ok: true, rueckmeldung: text });
}

// Kurzer Stand für die Schülerseite: Ist die Abgabe beendet? Gibt es eine Rückmeldung?
async function sendStand(req, res, raw) {
  if (tooManyWrongCodes(req, false)) return sendJson(res, 429, { fehler: 'Zu viele falsche Codes. Bitte eine Minute warten.' });
  const code = String(raw).toUpperCase();
  const hit = CODE_RX.test(code) ? [...index.values()].find((x) => x.code === code) : null;
  if (!hit) {
    tooManyWrongCodes(req);
    return sendJson(res, 404, { fehler: 'Zu diesem Code gibt es keinen Zeitstrahl.' });
  }
  const task = await readTask();
  sendJson(res, 200, { status: hit.status, aktualisiert: hit.aktualisiert, rueckmeldung: hit.rueckmeldung || '', gesperrt: task.gesperrt });
}

const archiveAbgabe = (res, id) => oneAfterAnother(id, () => moveToArchive(res, id));

async function moveToArchive(res, id) {
  await fsp.mkdir(ARCHIVE, { recursive: true });
  const a = index.get(id);
  try {
    const taken = new Set(await fsp.readdir(ARCHIVE));
    await fsp.rename(path.join(ABGABEN, a.datei), path.join(ARCHIVE, freeName(a.datei.replace(/\.json$/, ''), taken)));
  } catch (e) { /* schon entfernt */ }
  index.delete(id);
  sendJson(res, 200, { ok: true });
}

/* ---------- Zeitstrahlen der Lehrkraft: je Zeitstrahl eine Datei ---------- */

// Dateiname aus einem Titel: „Weimarer Republik“ → weimarer-republik
function slug(name) {
  const s = String(name || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'zeitstrahl';
}

// Freier Dateiname in einem Ordner: name.json, sonst name-2.json, name-3.json …
function freeName(base, taken) {
  let name = base + '.json';
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}.json`;
  return name;
}

// Speichervorgänge nacheinander abarbeiten, damit sich zwei nicht in die Quere kommen
let backupQueue = Promise.resolve();

// Stand der Zeitstrahlen. Er ändert sich mit jeder gespeicherten Änderung. Bearbeiten
// Laptop und Lehrer-PC gleichzeitig, schickt jedes Gerät den Stand mit, auf dem seine
// Änderung beruht. Passt er nicht mehr, lädt das Gerät erst den neuen Stand.
const BOOT = Date.now().toString(36);
let standNr = 0;
let stand = `${BOOT}-0`;
let lastOrder = null;

// Welche Datei gehört zu welchem Zeitstrahl, und wie sah sie zuletzt aus
const files = new Map(); // id → { datei, hash }
const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex');

// Inhalt einer Einzeldatei. Sie lässt sich in der Lehrkraft-Ansicht über „Datei → Öffnen“ einlesen.
function timelineFile(t) {
  return JSON.stringify({
    typ: 'zeitstrahl-sicherung',
    version: 1,
    timelines: [{ id: t.id, name: t.name, source: t.source, images: t.images && typeof t.images === 'object' ? t.images : {} }],
  });
}

function readTimelines() {
  const list = [];
  let names = [];
  try {
    names = fs.readdirSync(TIMELINES).filter((f) => f.endsWith('.json') && f !== ORDER_FILE);
  } catch (e) {
    return list; // noch keine Zeitstrahlen
  }
  for (const datei of names) {
    try {
      const text = fs.readFileSync(path.join(TIMELINES, datei), 'utf8');
      const t = JSON.parse(text).timelines[0];
      if (!t || typeof t.id !== 'string' || typeof t.name !== 'string' || typeof t.source !== 'string') continue;
      if (files.has(t.id)) continue; // doppelte Kennung: erste Datei gilt
      files.set(t.id, { datei, hash: hashOf(text) });
      list.push(t);
    } catch (e) { /* unlesbare Datei überspringen */ }
  }
  return list;
}

function readOrder() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(TIMELINES, ORDER_FILE), 'utf8'));
    return { activeId: typeof o.activeId === 'string' ? o.activeId : '', reihenfolge: Array.isArray(o.reihenfolge) ? o.reihenfolge : [] };
  } catch (e) {
    return { activeId: '', reihenfolge: [] };
  }
}

// Früher lag alles zusammen in daten/sicherung.json. Beim ersten Start wird sie
// einmalig in Einzeldateien aufgeteilt und bleibt als sicherung-alt.json liegen.
function migrateBackup() {
  if (fs.existsSync(TIMELINES) || !fs.existsSync(OLD_BACKUP)) return;
  try {
    const d = JSON.parse(fs.readFileSync(OLD_BACKUP, 'utf8'));
    if (!d || !Array.isArray(d.timelines)) return;
    fs.mkdirSync(TIMELINES, { recursive: true });
    const taken = new Set();
    const ids = [];
    for (const t of d.timelines) {
      if (!t || typeof t.name !== 'string' || typeof t.source !== 'string') continue;
      const id = typeof t.id === 'string' && t.id ? t.id : 't' + crypto.randomBytes(5).toString('hex');
      const datei = freeName(slug(t.name), taken);
      taken.add(datei);
      fs.writeFileSync(path.join(TIMELINES, datei), timelineFile({ ...t, id }));
      ids.push(id);
    }
    fs.writeFileSync(path.join(TIMELINES, ORDER_FILE), JSON.stringify({ activeId: d.activeId || ids[0], reihenfolge: ids }));
    fs.renameSync(OLD_BACKUP, path.join(DATA, 'sicherung-alt.json'));
    console.log(`  Die Sicherung wurde in ${ids.length} Einzeldateien in daten/zeitstrahlen aufgeteilt.`);
  } catch (e) {
    console.error('  daten/sicherung.json ließ sich nicht aufteilen und bleibt unverändert.');
  }
}

function loadTimelines() {
  migrateBackup();
  readTimelines();
  lastOrder = readOrder().reihenfolge.join();
}

async function loadBackup(res) {
  await backupQueue; // erst fertig speichern, dann lesen
  files.clear();
  const list = readTimelines();
  if (!list.length) return sendJson(res, 200, { leer: true, stand }); // noch keine Sicherung vorhanden
  const { activeId, reihenfolge } = readOrder();
  const pos = (t) => {
    const i = reihenfolge.indexOf(t.id);
    return i < 0 ? Infinity : i;
  };
  list.sort((a, b) => pos(a) - pos(b) || a.name.localeCompare(b.name, 'de'));
  sendJson(res, 200, { app: 'zeitstrahl-werkstatt', activeId, stand, timelines: list });
}

// Speichert nur, was sich geändert hat. Umbenannte Zeitstrahlen bekommen einen
// neuen Dateinamen, gelöschte wandern nach daten/zeitstrahlen/geloescht.
async function writeTimelines(d) {
  await fsp.mkdir(TIMELINES, { recursive: true });
  const list = d.timelines.filter((t) => t && typeof t.id === 'string' && t.id
    && typeof t.name === 'string' && typeof t.source === 'string');
  const keep = new Set(list.map((t) => t.id));
  let changed = false;
  const before = async () => {
    if (!changed) { changed = true; await keepDailyCopy(); }
  };

  // Gelöschte Zeitstrahlen zuerst beiseitelegen, dann ist ihr Dateiname wieder frei
  for (const [id, f] of [...files]) {
    if (keep.has(id)) continue;
    await before();
    await fsp.mkdir(DELETED, { recursive: true });
    const gone = new Set(await fsp.readdir(DELETED));
    try {
      await fsp.rename(path.join(TIMELINES, f.datei), path.join(DELETED, freeName(f.datei.replace(/\.json$/, ''), gone)));
    } catch (e) { /* schon weg */ }
    files.delete(id);
  }

  // Dateien behalten ihren Namen, solange der Titel dazu passt
  const taken = new Set();
  const wanted = new Map();
  for (const t of list) {
    const f = files.get(t.id);
    if (f && new RegExp(`^${slug(t.name)}(-\\d+)?\\.json$`).test(f.datei)) {
      wanted.set(t.id, f.datei);
      taken.add(f.datei);
    }
  }
  // Umbenannte belegen ihren alten Namen noch, bis die neue Datei geschrieben ist
  for (const [id, f] of files) if (!wanted.has(id)) taken.add(f.datei);
  for (const t of list) {
    if (wanted.has(t.id)) continue;
    const datei = freeName(slug(t.name), taken);
    taken.add(datei);
    wanted.set(t.id, datei);
  }

  for (const t of list) {
    const text = timelineFile(t);
    const hash = hashOf(text);
    const f = files.get(t.id);
    const datei = wanted.get(t.id);
    if (f && f.hash === hash && f.datei === datei) continue;
    await before();
    await writeAtomic(path.join(TIMELINES, datei), text);
    if (f && f.datei !== datei) await fsp.unlink(path.join(TIMELINES, f.datei)).catch(() => {});
    files.set(t.id, { datei, hash });
  }
  const order = list.map((t) => t.id);
  await writeAtomic(path.join(TIMELINES, ORDER_FILE), JSON.stringify({
    activeId: typeof d.activeId === 'string' ? d.activeId : '',
    reihenfolge: order,
  }));
  // Nur ein anderer gezeigter Zeitstrahl ist keine Änderung für die anderen Geräte
  if (changed || order.join() !== lastOrder) stand = `${BOOT}-${++standNr}`;
  lastOrder = order.join();
}

async function saveBackup(req, res) {
  const text = await readBody(req, MAX_BACKUP);
  let d;
  try {
    d = JSON.parse(text);
    if (!d || !Array.isArray(d.timelines)) throw new Error();
  } catch (e) {
    return sendJson(res, 400, { fehler: 'Ungültige Sicherung.' });
  }
  const job = backupQueue.then(() => {
    // Ohne mitgeschickten Stand (Seite ohne Abgleich) wird wie bisher gespeichert
    if (typeof d.stand === 'string' && d.stand !== stand) return false;
    return writeTimelines(d).then(() => true);
  });
  backupQueue = job.catch(() => {});
  try {
    if (!(await job)) return sendJson(res, 409, { fehler: 'Auf einem anderen Gerät wurde inzwischen etwas geändert.', stand });
    sendJson(res, 200, { ok: true, stand });
  } catch (e) {
    console.error(`${time()}  Speichern der Zeitstrahlen fehlgeschlagen: ${e.message}`);
    sendJson(res, 500, { fehler: 'Speichern auf dem Laptop hat nicht geklappt.' });
  }
}

// Lokales Datum als 2026-10-04
function dayName(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

// Vor der ersten Änderung eines Tages wird der bisherige Stand als Tageskopie
// abgelegt (daten/sicherungen/2026-10-04/). So lässt sich ein versehentlich
// gelöschter oder verändertter Zeitstrahl zurückholen (Datei → Öffnen).
async function keepDailyCopy() {
  const target = path.join(BACKUP_DAYS, dayName(new Date()));
  if (fs.existsSync(target) || fs.existsSync(target + '.json')) return; // heute schon gesichert
  let names = [];
  try {
    names = (await fsp.readdir(TIMELINES)).filter((f) => f.endsWith('.json') && f !== ORDER_FILE);
  } catch (e) { /* noch nichts gespeichert */ }
  if (!names.length) return;
  await fsp.mkdir(target, { recursive: true });
  for (const f of names) await fsp.copyFile(path.join(TIMELINES, f), path.join(target, f));
  try {
    // Ordner und ältere Tageskopien als einzelne .json-Datei
    const old = (await fsp.readdir(BACKUP_DAYS)).filter((f) => /^\d{4}-\d\d-\d\d(\.json)?$/.test(f)).sort().reverse().slice(KEEP_DAYS);
    for (const f of old) await fsp.rm(path.join(BACKUP_DAYS, f), { recursive: true, force: true });
  } catch (e) { /* Aufräumen klappt beim nächsten Mal */ }
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
  if ((mm = p.match(/^\/api\/abgaben\/code\/([A-Za-z0-9]{1,10})\/stand$/)) && m === 'GET') return sendStand(req, res, mm[1]);

  // Anmelden an einem anderen Gerät (Lehrer-PC)
  if (p === '/lehrkraft' || p === '/lehrkraft/') {
    if (m === 'POST') return login(req, res);
    if (m !== 'GET' && m !== 'HEAD') return send(res, 405, 'Nicht erlaubt');
    if (isLocal(req)) {
      res.writeHead(302, { Location: '/' }); // am Laptop selbst braucht es kein Passwort
      return res.end();
    }
    if (hasSession(req)) return sendFile(res, path.join(ROOT, 'index.html'));
    return loginPage(res, url.searchParams.get('hinweis'));
  }

  // Stand des Passworts, nur am Laptop selbst
  if (p === '/api/zugang' && m === 'GET') {
    if (!localApi(req)) return sendJson(res, 403, { fehler: 'Nur am Laptop der Lehrkraft erlaubt.' });
    return sendJson(res, 200, { ...accessInfo(), port: server.address().port, adressen: lanAddresses() });
  }

  // Nur für die Lehrkraft: am Laptop oder angemeldet an einem anderen Gerät
  if (p.startsWith('/api/')) {
    if (!teacherApi(req)) return sendJson(res, 403, { fehler: 'Nur am Laptop der Lehrkraft erlaubt.' });
    if (p === '/api/abmelden' && m === 'POST') return logout(req, res);
    if (p === '/api/verbindung' && m === 'GET') return sendJson(res, 200, { port: server.address().port, adressen: lanAddresses() });
    if (p === '/api/aufgabe' && m === 'PUT') return saveTask(req, res);
    if (p === '/api/abgaben' && m === 'GET') {
      const list = [...index.values()].sort((a, b) => a.thema.localeCompare(b.thema, 'de') || a.erstellt.localeCompare(b.erstellt));
      return sendJson(res, 200, { abgaben: list, stand });
    }
    if ((mm = p.match(/^\/api\/abgaben\/([a-f0-9]{16})$/))) {
      if (m === 'GET') return sendAbgabe(res, mm[1]);
      if (m === 'DELETE') return archiveAbgabe(res, mm[1]);
    }
    if ((mm = p.match(/^\/api\/abgaben\/([a-f0-9]{16})\/rueckmeldung$/)) && m === 'PUT') return saveRueckmeldung(req, res, mm[1]);
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

/* ---------- Passwort im Server-Fenster festlegen ---------- */

// Liest eine Eingabe, ohne sie anzuzeigen
function askHidden(question) {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let text = '';
    const done = (value) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return done(text);
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(1); } // Strg+C
        if (c === '\u007f' || c === '\b') text = [...text].slice(0, -1).join('');
        else if (c >= ' ') text += c;
      }
    };
    input.on('data', onData);
  });
}

async function askPassword(firstStart) {
  console.log('');
  if (firstStart) {
    console.log('  Mit einem Passwort lässt sich die Lehrkraft-Ansicht auch an einem anderen Gerät');
    console.log('  im Netz öffnen, z. B. am Lehrer-PC am Beamer. Die Eingabe bleibt unsichtbar.');
    console.log('  Das Passwort geht unverschlüsselt durchs Schulnetz. Deshalb bitte eines wählen,');
    console.log('  das sonst nirgends benutzt wird.');
    console.log('  Ohne Passwort einfach Enter drücken: Dann geht die Lehrkraft-Ansicht nur an diesem Laptop.');
    console.log('  Später festlegen oder ändern: node server.js --passwort\n');
  } else {
    console.log('  Neues Passwort für die Lehrkraft-Ansicht an anderen Geräten. Die Eingabe bleibt unsichtbar.');
    console.log('  Das Passwort geht unverschlüsselt durchs Schulnetz. Deshalb bitte eines wählen,');
    console.log('  das sonst nirgends benutzt wird.');
    console.log('  Nur Enter: kein Passwort, die Lehrkraft-Ansicht geht dann nur an diesem Laptop.\n');
  }
  for (;;) {
    const pw = await askHidden('  Passwort: ');
    let value;
    if (!pw) {
      value = 'aus';
      console.log('  Kein Passwort. Die Lehrkraft-Ansicht geht nur an diesem Laptop.');
    } else if ([...pw].length < MIN_PASSWORD) {
      console.log(`  Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.\n`);
      continue;
    } else if ((await askHidden('  Noch einmal: ')) !== pw) {
      console.log('  Die beiden Eingaben stimmen nicht überein.\n');
      continue;
    } else {
      const salt = crypto.randomBytes(16).toString('hex');
      value = `scrypt:${salt}:${hashPassword(pw, salt)}`;
      console.log('  Passwort gespeichert (nur als Hash in einstellungen.txt).');
    }
    writeSetting('passwort', value);
    return;
  }
}

// Beim ersten Start oder mit --passwort fragen. Ohne Konsole (z. B. als Dienst) geht das nicht.
async function ensurePassword() {
  const firstStart = !passwordDecided();
  if (!ASK_PASSWORD && !firstStart) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (ASK_PASSWORD) {
      console.error('\nDas Passwort lässt sich nur in einem Terminal festlegen: node server.js --passwort\n');
      process.exit(1);
    }
    console.log('\n  Kein Passwort für andere Geräte festgelegt. Dafür einmal im Terminal starten: node server.js --passwort');
    return;
  }
  await askPassword(firstStart);
}

async function main() {
  await ensurePassword();
  for (const dir of [DATA, ABGABEN, TIMELINES]) removeTmp(dir);
  loadIndex();
  loadTimelines();
  listen();
}

const listen = () => server.listen(PORT, '0.0.0.0', () => {
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
  if (lan.length && readAccess()) {
    console.log(`  Lehrer-PC (mit Passwort):   http://${withPort(lan[0])}/lehrkraft`);
  } else if (lan.length) {
    console.log('  Lehrer-PC:                  nur mit Passwort, festlegen mit: node server.js --passwort');
  }
  console.log(`\n  Port ${PORT} (änderbar in einstellungen.txt)`);
  console.log('  Zum Beenden dieses Fenster schließen oder Strg+C drücken.\n');
  if (OPEN_BROWSER) {
    const cmd = process.platform === 'win32' ? `start "" "${local}"` : process.platform === 'darwin' ? `open "${local}"` : `xdg-open "${local}"`;
    exec(cmd, () => {});
  }
});

main();
