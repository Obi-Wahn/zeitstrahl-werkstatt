/*
 * Tests für den Klassenserver. Ausführen mit:  node tests/server.test.js
 *
 * Jeder Abschnitt startet server.js in einem eigenen Ordner unter dem
 * Temp-Verzeichnis und spielt einen Ablauf aus dem Unterricht über HTTP durch.
 * Die echten Daten in daten/ bleiben unberührt.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const PASSWORT = 'tafel-123';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('FEHLER ' + name);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

/* ---------- Server starten und anfragen ---------- */

// Leerer Ordner mit server.js und den Seiten, dazu einstellungen.txt mit Passwort
function workdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeitstrahl-test-'));
  fs.mkdirSync(path.join(dir, 'js'));
  for (const f of ['server.js', 'index.html', 'beitrag.html', 'anmelden.html', 'js/gemeinsam.js']) {
    fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(PASSWORT, salt, 32).toString('hex');
  fs.writeFileSync(path.join(dir, 'einstellungen.txt'), `passwort = scrypt:${salt}:${hash}\n`);
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function start(dir) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js', String(port), '--kein-browser'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startet nicht:\n' + out)), 5000);
    proc.stdout.on('data', () => {
      if (out.includes('läuft')) { clearTimeout(timer); resolve(); }
    });
    proc.on('exit', () => { clearTimeout(timer); reject(new Error('Server beendet:\n' + out)); });
  });
  const stop = () => new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.on('exit', resolve);
    proc.kill();
  });
  return { port, stop, log: () => out };
}

// Anfrage an den Server. host „localhost“ = Laptop der Lehrkraft, sonst ein iPad.
function request(port, method, url, { body, host = 'schule', lehrkraft = false, cookie, form } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (lehrkraft) headers['X-Zeitstrahl'] = 'lehrkraft';
    if (cookie) headers.Cookie = cookie;
    let data;
    if (form !== undefined) {
      data = new URLSearchParams(form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body !== undefined) {
      data = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* kein JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// Kurzformen für die beiden Seiten
const client = (port) => ({
  schueler: (method, url, body) => request(port, method, url, { body }),
  laptop: (method, url, body) => request(port, method, url, { body, host: 'localhost', lehrkraft: true }),
});

const ereignis = (titel, datum = '1517', extra = {}) => ({ datum, titel, kategorie: '', beschreibung: '', bildquelle: '', bild: '', ...extra });
const abgabe = (von, titel, eintraege, extra = {}) => ({ von, titel, thema: 'Reformation', status: 'entwurf', eintraege, ...extra });

const abgabenOrdner = (dir) => path.join(dir, 'daten', 'abgaben');
const dateienIn = (ordner) => (fs.existsSync(ordner) ? fs.readdirSync(ordner) : []);

/* ---------- Abläufe ---------- */

(async () => {
  console.log('Klassenserver');

  // Szenario 1: Gruppe speichert, holt den Zeitstrahl mit dem Code zurück und arbeitet weiter
  {
    const dir = workdir();
    const s = await start(dir);
    const c = client(s.port);

    await test('Gruppe speichert und bekommt einen Code', async () => {
      const r = await c.schueler('POST', '/api/abgaben', abgabe('Lena und Tom', 'Luther', [ereignis('Thesenanschlag')]));
      assert.equal(r.status, 200);
      assert.match(r.json.code, /^[A-HJ-NP-Z2-9]{5}$/);
      assert.match(r.json.id, /^[a-f0-9]{16}$/);
      s.gruppe = r.json;
    });

    await test('Code bringt denselben Zeitstrahl zurück, auch kleingeschrieben', async () => {
      const r = await c.schueler('GET', `/api/abgaben/code/${s.gruppe.code.toLowerCase()}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.von, 'Lena und Tom');
      assert.deepEqual(r.json.eintraege.map((e) => e.titel), ['Thesenanschlag']);
    });

    await test('Weiterarbeiten mit Code behält Code und Kennung', async () => {
      const r = await c.schueler('POST', '/api/abgaben', abgabe('Lena und Tom', 'Luther', [ereignis('Thesenanschlag'), ereignis('Bauernkrieg', '1525')], s.gruppe));
      assert.equal(r.status, 200);
      assert.equal(r.json.code, s.gruppe.code);
      assert.equal(r.json.id, s.gruppe.id);
      assert.equal(dateienIn(abgabenOrdner(dir)).length, 1);
    });

    await test('Anderer Name heißt andere Datei, die alte verschwindet', async () => {
      const r = await c.schueler('POST', '/api/abgaben', abgabe('Lena, Tom und Ali', 'Luther', [ereignis('Thesenanschlag')], s.gruppe));
      assert.equal(r.status, 200);
      assert.deepEqual(dateienIn(abgabenOrdner(dir)), [`reformation-lena-tom-und-ali-${s.gruppe.code}.json`]);
    });

    await test('Falscher Code zur Kennung wird abgelehnt', async () => {
      const r = await c.schueler('POST', '/api/abgaben', abgabe('Fremde', 'X', [ereignis('Y')], { id: s.gruppe.id, code: 'ZZZZZ' }));
      assert.equal(r.status, 403);
    });

    await test('Fehlende Namen oder Ereignisse werden abgelehnt', async () => {
      assert.equal((await c.schueler('POST', '/api/abgaben', abgabe('', 'X', [ereignis('Y')]))).status, 400);
      assert.equal((await c.schueler('POST', '/api/abgaben', abgabe('Lena', 'X', [{ titel: 'ohne Datum' }]))).status, 400);
      assert.equal((await c.schueler('POST', '/api/abgaben', '{kaputt')).status, 400);
    });

    await test('Ungültige Bilder fallen weg, der Rest wird gespeichert', async () => {
      const r = await c.schueler('POST', '/api/abgaben', abgabe('Mia', 'Bilder', [
        ereignis('Gut', '1517', { bild: 'data:image/png;base64,iVBORw0KGgo=' }),
        ereignis('Böse', '1518', { bild: 'data:text/html;base64,PHNjcmlwdD4=' }),
      ]));
      const back = (await c.schueler('GET', `/api/abgaben/code/${r.json.code}`)).json;
      assert.equal(back.eintraege[0].bild, 'data:image/png;base64,iVBORw0KGgo=');
      assert.equal(back.eintraege[1].bild, '');
    });

    await test('Unbekannter Code: 404, nach mehr als zehn falschen Codes eine Minute Pause', async () => {
      assert.equal((await c.schueler('GET', '/api/abgaben/code/AAAAA')).status, 404);
      for (let i = 0; i < 10; i++) await c.schueler('GET', '/api/abgaben/code/AAAAA');
      assert.equal((await c.schueler('GET', '/api/abgaben/code/AAAAA')).status, 429);
    });

    await s.stop();
  }

  // Szenario 2: Speichern, ändern, wieder speichern, Server neu starten
  {
    const dir = workdir();
    let s = await start(dir);
    let c = client(s.port);
    let gruppe;

    await test('Nach einem Neustart ist der letzte Stand vollständig da', async () => {
      gruppe = (await c.schueler('POST', '/api/abgaben', abgabe('Ben', 'Weimar', [ereignis('Republik', '1918')]))).json;
      await c.schueler('POST', '/api/abgaben', abgabe('Ben', 'Weimar', [ereignis('Republik', '1918'), ereignis('Inflation', '1923')], gruppe));
      await s.stop();
      s = await start(dir);
      c = client(s.port);
      const r = await c.schueler('GET', `/api/abgaben/code/${gruppe.code}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.eintraege.map((e) => e.titel), ['Republik', 'Inflation']);
      const liste = (await c.laptop('GET', '/api/abgaben')).json.abgaben;
      assert.equal(liste.length, 1);
      assert.equal(liste[0].anzahl, 2);
    });

    await test('Keine halb geschriebenen .tmp-Dateien bleiben liegen', () => {
      assert.deepEqual(dateienIn(abgabenOrdner(dir)).filter((f) => !f.endsWith('.json')), []);
    });

    await test('Archivieren: Datei wandert nach daten/archiv, der Code gilt nicht mehr', async () => {
      assert.equal((await c.laptop('DELETE', `/api/abgaben/${gruppe.id}`)).status, 200);
      assert.equal(dateienIn(abgabenOrdner(dir)).length, 0);
      assert.equal(dateienIn(path.join(dir, 'daten', 'archiv')).length, 1);
      assert.equal((await c.schueler('GET', `/api/abgaben/code/${gruppe.code}`)).status, 404);
    });

    await test('Gelöschter Zeitstrahl wird nicht still neu angelegt, erst auf Wunsch ohne Kennung', async () => {
      const weiter = await c.schueler('POST', '/api/abgaben', abgabe('Ben', 'Weimar', [ereignis('Republik', '1918')], gruppe));
      assert.equal(weiter.status, 410);
      assert.equal(weiter.json.geloescht, true);
      assert.equal(dateienIn(abgabenOrdner(dir)).length, 0);
      const neu = await c.schueler('POST', '/api/abgaben', abgabe('Ben', 'Weimar', [ereignis('Republik', '1918')]));
      assert.equal(neu.status, 200);
      assert.notEqual(neu.json.code, gruppe.code);
    });

    await s.stop();
  }

  // Szenario 3: Abgabe beenden und Rückmeldung
  {
    const dir = workdir();
    const s = await start(dir);
    const c = client(s.port);
    let gruppe;

    await test('Thema der Lehrkraft gilt für neue Abgaben', async () => {
      const r = await c.laptop('PUT', '/api/aufgabe', { thema: 'Reformation in Sachsen', auftrag: 'Zehn Ereignisse', kategorien: [' Politik ', 'Religion', 'politik', 'Sport; Spiel', '', 3] });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.kategorien, ['Politik', 'Religion', 'Sport Spiel'], 'gekürzt, ohne Doppelte, ohne Semikolon');
      gruppe = (await c.schueler('POST', '/api/abgaben', abgabe('Lena', 'Luther', [ereignis('Thesenanschlag')], { thema: 'Eigenes' }))).json;
      assert.equal(gruppe.thema, 'Reformation in Sachsen');
    });

    await test('Abgabe beendet: Speichern ergibt 423, die Daten bleiben unverändert', async () => {
      const vorher = fs.readFileSync(path.join(abgabenOrdner(dir), dateienIn(abgabenOrdner(dir))[0]), 'utf8');
      const r = await c.laptop('PUT', '/api/aufgabe', { gesperrt: true });
      assert.equal(r.json.thema, 'Reformation in Sachsen', 'nur das Schloss umlegen, Thema bleibt');
      assert.deepEqual(r.json.kategorien, ['Politik', 'Religion', 'Sport Spiel'], 'Kategorien bleiben auch');
      assert.equal(r.json.gesperrt, true);
      const save = await c.schueler('POST', '/api/abgaben', abgabe('Lena', 'Luther', [ereignis('Überschrieben?')], gruppe));
      assert.equal(save.status, 423);
      assert.equal((await c.schueler('POST', '/api/abgaben', abgabe('Neu', 'X', [ereignis('Y')]))).status, 423);
      assert.equal(fs.readFileSync(path.join(abgabenOrdner(dir), dateienIn(abgabenOrdner(dir))[0]), 'utf8'), vorher);
      assert.equal(dateienIn(abgabenOrdner(dir)).length, 1);
      assert.equal((await c.schueler('GET', `/api/abgaben/code/${gruppe.code}/stand`)).json.gesperrt, true);
    });

    await test('Die iPads sehen die vorgegebenen Kategorien, höchstens acht', async () => {
      assert.deepEqual((await c.schueler('GET', '/api/aufgabe')).json.kategorien, ['Politik', 'Religion', 'Sport Spiel']);
      const viele = Array.from({ length: 12 }, (_, i) => 'K' + i);
      const r = await c.laptop('PUT', '/api/aufgabe', { thema: 'Reformation in Sachsen', auftrag: 'Zehn Ereignisse', kategorien: viele, gesperrt: true });
      assert.deepEqual(r.json.kategorien, viele.slice(0, 8));
    });

    await test('Wieder freigegeben: Speichern klappt', async () => {
      await c.laptop('PUT', '/api/aufgabe', { gesperrt: false });
      assert.equal((await c.schueler('POST', '/api/abgaben', abgabe('Lena', 'Luther', [ereignis('Thesenanschlag'), ereignis('Bann', '1521')], gruppe))).status, 200);
    });

    await test('Rückmeldung erscheint bei der Gruppe und bleibt beim nächsten Speichern', async () => {
      const r = await c.laptop('PUT', `/api/abgaben/${gruppe.id}/rueckmeldung`, { rueckmeldung: 'Gut, ergänzt noch 1530.' });
      assert.equal(r.status, 200);
      assert.equal((await c.schueler('GET', `/api/abgaben/code/${gruppe.code}/stand`)).json.rueckmeldung, 'Gut, ergänzt noch 1530.');
      await c.schueler('POST', '/api/abgaben', abgabe('Lena', 'Luther', [ereignis('Augsburg', '1530')], gruppe));
      assert.equal((await c.schueler('GET', `/api/abgaben/code/${gruppe.code}`)).json.rueckmeldung, 'Gut, ergänzt noch 1530.');
    });

    await s.stop();
  }

  // Szenario 4: Viele Speichervorgänge gleichzeitig auf denselben Zeitstrahl
  {
    const dir = workdir();
    const s = await start(dir);
    const c = client(s.port);
    // Große Bilder, damit das Schreiben dauert und sich die Vorgänge überschneiden
    const bild = 'data:image/png;base64,' + 'A'.repeat(1.5 * 1024 * 1024);
    const version = (n) => [ereignis(`Version ${n}`, '1517', { bild }), ereignis(`Noch ${n}`, '1518', { bild })];
    let gruppe;

    await test('Zwei iPads und die Lehrkraft speichern gleichzeitig: nichts geht verloren oder kaputt', async () => {
      gruppe = (await c.schueler('POST', '/api/abgaben', abgabe('Lena', 'Luther', version(0)))).json;
      const jobs = [];
      for (let n = 1; n <= 8; n++) jobs.push(c.schueler('POST', '/api/abgaben', abgabe('Lena', 'Luther', version(n), gruppe)));
      jobs.push(c.laptop('PUT', `/api/abgaben/${gruppe.id}/rueckmeldung`, { rueckmeldung: 'Schön!' }));
      for (let n = 9; n <= 12; n++) jobs.push(c.schueler('POST', '/api/abgaben', abgabe('Lena', 'Luther', version(n), gruppe)));
      const antworten = await Promise.all(jobs);
      assert.deepEqual(antworten.map((r) => r.status), antworten.map(() => 200), 'alle Anfragen klappen');

      const namen = dateienIn(abgabenOrdner(dir));
      assert.deepEqual(namen, [`reformation-lena-${gruppe.code}.json`], 'genau eine Datei, keine .tmp-Reste');
      const gespeichert = JSON.parse(fs.readFileSync(path.join(abgabenOrdner(dir), namen[0]), 'utf8'));
      assert.match(gespeichert.eintraege[0].titel, /^Version \d+$/);
      assert.equal(gespeichert.eintraege[1].titel, gespeichert.eintraege[0].titel.replace('Version', 'Noch'), 'Datei stammt aus einem Guss');
      assert.equal(gespeichert.rueckmeldung, 'Schön!', 'Rückmeldung der Lehrkraft bleibt erhalten');
    });

    await s.stop();
  }

  // Szenario 5: Zugriffsgrenzen zwischen Schülerseite und Lehrkraft
  {
    const dir = workdir();
    const s = await start(dir);
    const c = client(s.port);

    await test('iPads kommen nicht an die Lehrkraft-Anfragen', async () => {
      for (const [m, u] of [['GET', '/api/abgaben'], ['GET', '/api/sicherung'], ['PUT', '/api/sicherung'], ['PUT', '/api/aufgabe'], ['GET', '/api/zugang'], ['DELETE', '/api/abgaben/0123456789abcdef']]) {
        assert.equal((await request(s.port, m, u, { body: m === 'GET' ? undefined : {}, lehrkraft: true })).status, 403, `${m} ${u}`);
      }
    });

    await test('Am Laptop braucht es den eigenen Kopf (Schutz vor fremden Webseiten)', async () => {
      assert.equal((await request(s.port, 'GET', '/api/abgaben', { host: 'localhost' })).status, 403);
      assert.equal((await c.laptop('GET', '/api/abgaben')).status, 200);
    });

    await test('Startseite: iPads landen auf der Schülerseite, Sicherheitsköpfe sind gesetzt', async () => {
      const r = await request(s.port, 'GET', '/');
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, '/beitrag.html');
      const seite = await request(s.port, 'GET', '/beitrag.html');
      assert.equal(seite.status, 200);
      assert.match(seite.headers['content-security-policy'], /default-src 'self'/);
      assert.equal(seite.headers['x-content-type-options'], 'nosniff');
    });

    await test('Server-Dateien, Daten und Einstellungen werden nicht ausgeliefert', async () => {
      fs.mkdirSync(path.join(dir, 'daten'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'daten', 'aufgabe.json'), '{}');
      for (const u of ['/server.js', '/einstellungen.txt', '/daten/aufgabe.json', '/js/../einstellungen.txt', '/js/%2e%2e/einstellungen.txt', '/css/..%2fserver.js', '/%00']) {
        assert.ok([400, 404].includes((await request(s.port, 'GET', u, { host: 'localhost' })).status), u);
      }
    });

    await test('Lehrer-PC: falsches Passwort abgelehnt, richtiges meldet an, Abmelden sperrt wieder', async () => {
      const falsch = await request(s.port, 'POST', '/lehrkraft', { form: { passwort: 'falsch' } });
      assert.equal(falsch.status, 303);
      assert.equal(falsch.headers.location, '/lehrkraft?hinweis=falsch');

      const richtig = await request(s.port, 'POST', '/lehrkraft', { form: { passwort: PASSWORT } });
      assert.equal(richtig.headers.location, '/lehrkraft');
      const cookie = richtig.headers['set-cookie'][0].split(';')[0];
      assert.match(richtig.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
      assert.equal((await request(s.port, 'GET', '/api/abgaben', { cookie, lehrkraft: true })).status, 200);
      assert.equal((await request(s.port, 'GET', '/api/abgaben', { cookie })).status, 403, 'ohne eigenen Kopf');
      assert.equal((await request(s.port, 'GET', '/api/zugang', { cookie, lehrkraft: true })).status, 403, 'Passwortstand nur am Laptop');

      // Mit Schrägstrich am Ende fänden Stil und Skripte nicht, deshalb weiterleiten
      const slash = await request(s.port, 'GET', '/lehrkraft/', { cookie });
      assert.equal(slash.status, 301);
      assert.equal(slash.headers.location, '/lehrkraft');

      assert.equal((await request(s.port, 'POST', '/api/abmelden', { cookie, lehrkraft: true })).status, 200);
      assert.equal((await request(s.port, 'GET', '/api/abgaben', { cookie, lehrkraft: true })).status, 403);
    });

    await test('Nach mehr als zehn falschen Passwörtern ist eine Minute Pause, auch für das richtige', async () => {
      for (let i = 0; i < 10; i++) await request(s.port, 'POST', '/lehrkraft', { form: { passwort: 'falsch' } });
      const r = await request(s.port, 'POST', '/lehrkraft', { form: { passwort: PASSWORT } });
      assert.equal(r.headers.location, '/lehrkraft?hinweis=gesperrt');
    });

    await test('Laptop sieht, wie viele Geräte angemeldet sind', async () => {
      const r = await c.laptop('GET', '/api/zugang');
      assert.equal(r.json.passwort, true);
      assert.equal(r.json.angemeldet, 0, 'abgemeldetes Gerät zählt nicht mehr');
    });

    await s.stop();
  }

  // Szenario 6: Zeitstrahlen der Lehrkraft und Tageskopie
  {
    const dir = workdir();
    const s = await start(dir);
    const c = client(s.port);
    const ordner = path.join(dir, 'daten', 'zeitstrahlen');
    let stand;

    await test('Jeder Zeitstrahl liegt als eigene Datei im Ordner daten, Reihenfolge bleibt', async () => {
      assert.equal((await c.laptop('GET', '/api/sicherung')).json.leer, true);
      await c.laptop('PUT', '/api/sicherung', {
        activeId: 'b',
        timelines: [{ id: 'a', name: 'Weimarer Republik', source: '1918 Republik' }, { id: 'b', name: 'Reformation', source: '1517 Thesen' }],
      });
      assert.deepEqual(dateienIn(ordner).sort(), ['_reihenfolge.json', 'reformation.json', 'weimarer-republik.json']);
      const r = await c.laptop('GET', '/api/sicherung');
      assert.deepEqual(r.json.timelines.map((t) => t.name), ['Weimarer Republik', 'Reformation']);
      assert.equal(r.json.activeId, 'b');
      stand = r.json.stand;
    });

    await test('Ändern legt vorher eine Tageskopie an, gelöschte wandern nach geloescht', async () => {
      const r = await c.laptop('PUT', '/api/sicherung', { stand, activeId: 'b', timelines: [{ id: 'b', name: 'Reformation', source: '1517 Thesen\n1521 Worms' }] });
      assert.equal(r.status, 200);
      assert.notEqual(r.json.stand, stand);
      assert.deepEqual(dateienIn(ordner).filter((f) => f.endsWith('.json')).sort(), ['_reihenfolge.json', 'reformation.json']);
      assert.deepEqual(dateienIn(path.join(ordner, 'geloescht')), ['weimarer-republik.json']);
      const tage = dateienIn(path.join(dir, 'daten', 'sicherungen'));
      assert.equal(tage.length, 1);
      assert.deepEqual(dateienIn(path.join(dir, 'daten', 'sicherungen', tage[0])).sort(), ['reformation.json', 'weimarer-republik.json']);
      stand = r.json.stand;
    });

    await test('Zwei Geräte gleichzeitig: das mit dem alten Stand bekommt 409', async () => {
      const laptop = c.laptop('PUT', '/api/sicherung', { stand, timelines: [{ id: 'b', name: 'Reformation', source: 'Laptop' }] });
      const pc = c.laptop('PUT', '/api/sicherung', { stand, timelines: [{ id: 'b', name: 'Reformation', source: 'Lehrer-PC' }] });
      const status = (await Promise.all([laptop, pc])).map((r) => r.status).sort();
      assert.deepEqual(status, [200, 409]);
    });

    await test('Umbenennen gibt der Datei einen neuen Namen', async () => {
      const aktuell = (await c.laptop('GET', '/api/sicherung')).json;
      await c.laptop('PUT', '/api/sicherung', { stand: aktuell.stand, timelines: [{ id: 'b', name: 'Reformation in Sachsen', source: 'x' }] });
      assert.deepEqual(dateienIn(ordner).filter((f) => f.endsWith('.json')).sort(), ['_reihenfolge.json', 'reformation-in-sachsen.json']);
    });

    await test('Kaputte Sicherung wird abgelehnt', async () => {
      assert.equal((await c.laptop('PUT', '/api/sicherung', { timelines: 'nein' })).status, 400);
    });

    await s.stop();
  }

  // Szenario: Lehrkraft macht einen ihrer Zeitstrahlen für die iPads sichtbar
  {
    const dir = workdir();
    const s = await start(dir);
    const c = client(s.port);
    const bild = 'data:image/png;base64,iVBORw0KGgo=';
    let hash;

    await test('Ohne Freigabe sehen die iPads keinen Zeitstrahl der Lehrkraft', async () => {
      await c.laptop('PUT', '/api/sicherung', { timelines: [
        { id: 'a', name: 'Reformation', source: '1517; Thesen; Religion; ; bild=b1', images: { b1: bild } },
        { id: 'b', name: 'Geheime Lösung', source: '1918; Republik' },
      ] });
      await c.laptop('PUT', '/api/aufgabe', { thema: 'Reformation', auftrag: '', kategorien: ['Politik'] });
      assert.deepEqual((await c.schueler('GET', '/api/freigabe')).json, { leer: true });
    });

    await test('Freigegeben: iPads bekommen genau diesen Zeitstrahl samt Bildern', async () => {
      const r = await c.laptop('PUT', '/api/aufgabe', { freigabe: 'a' });
      assert.equal(r.json.freigabe, 'a');
      assert.equal(r.json.thema, 'Reformation'); // Thema und Kategorien bleiben
      assert.deepEqual(r.json.kategorien, ['Politik']);
      const f = (await c.schueler('GET', '/api/freigabe')).json;
      assert.equal(f.name, 'Reformation');
      assert.match(f.source, /Thesen/);
      assert.deepEqual(f.images, { b1: bild });
      hash = f.hash;
    });

    await test('Unverändert: kurze Antwort ohne Inhalt, nach einer Änderung wieder alles', async () => {
      assert.deepEqual((await c.schueler('GET', `/api/freigabe?hash=${hash}`)).json, { unveraendert: true, hash });
      const stand = (await c.laptop('GET', '/api/sicherung')).json.stand;
      await c.laptop('PUT', '/api/sicherung', { stand, timelines: [
        { id: 'a', name: 'Reformation', source: '1517; Thesen\n1521; Worms' },
        { id: 'b', name: 'Geheime Lösung', source: '1918; Republik' },
      ] });
      const f = (await c.schueler('GET', `/api/freigabe?hash=${hash}`)).json;
      assert.notEqual(f.hash, hash);
      assert.match(f.source, /Worms/);
    });

    await test('Thema neu festlegen behält die Freigabe, iPads dürfen sie nicht ändern', async () => {
      const r = await c.laptop('PUT', '/api/aufgabe', { thema: 'Reformation', auftrag: 'Sechs Ereignisse', kategorien: [], gesperrt: false });
      assert.equal(r.json.freigabe, 'a');
      assert.equal((await c.schueler('PUT', '/api/aufgabe', { freigabe: 'b' })).status, 403);
      assert.equal((await c.schueler('GET', '/api/freigabe')).json.name, 'Reformation');
    });

    await test('Freigabe zurückgenommen oder Zeitstrahl gelöscht: nichts mehr zu sehen', async () => {
      await c.laptop('PUT', '/api/aufgabe', { freigabe: '' });
      assert.deepEqual((await c.schueler('GET', '/api/freigabe')).json, { leer: true });
      await c.laptop('PUT', '/api/aufgabe', { freigabe: 'a' });
      const stand = (await c.laptop('GET', '/api/sicherung')).json.stand;
      await c.laptop('PUT', '/api/sicherung', { stand, timelines: [{ id: 'b', name: 'Geheime Lösung', source: '1918; Republik' }] });
      assert.deepEqual((await c.schueler('GET', '/api/freigabe')).json, { leer: true });
    });

    await s.stop();
  }

  console.log(`\n${passed} Tests bestanden.`);
})();
