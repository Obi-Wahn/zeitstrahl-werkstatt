/*
 * Zeitstrahl-Werkstatt · Lehrkraft-Ansicht
 * Verbindet Editor, Zeitstrahl-Bühne, Tafelbild, Dateien und eingereichte Schülerbeiträge.
 * Alle Daten bleiben im Browser (IndexedDB, ersatzweise localStorage).
 */
(() => {
  'use strict';

  const Parser = window.ZeitstrahlParser;
  const Layout = window.ZeitstrahlLayout;
  const Bild = window.ZeitstrahlBild;
  const Zip = window.ZeitstrahlZip;
  const Stand = window.ZeitstrahlStand;
  const SAMPLES = window.ZeitstrahlBeispiele || [];
  const { slug, str, cleanKategorien, MAX_KATEGORIEN, validImage, toast, download, measure, clearMeasure, THEMES, setTheme, shownTheme, labelThemeIcon, savePng, printSvg } = window.ZeitstrahlGemeinsam;

  const DB_NAME = 'zeitstrahl-werkstatt';
  const DB_STORE = 'daten';
  const DB_KEY = 'zustand';
  const LS_KEY = 'zeitstrahl-werkstatt-v1';
  const THEME_KEY = 'zeitstrahl-werkstatt-farben';
  const UNSAVED_KEY = 'zeitstrahl-werkstatt-ungesichert-seit';
  const SHOWN_KEY = 'zeitstrahl-werkstatt-gezeigt';
  const REMIND_DAYS = 7;
  const ORDER_FILE = '_reihenfolge.json';

  const FAM_SCREEN = '"Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif';
  const PRESENT_SCALE = 1.4;
  const MIN_PRESENT_SCALE = 0.85; // so weit darf das Tafelbild schrumpfen, damit alles aufs Bild passt
  const MIN_SPAN = 0.25;
  const MAX_SPAN = 40000;
  const LIMIT_LO = -30000;
  const LIMIT_HI = 6000;
  const NOW = new Date();
  const TODAY_POS = Parser.toPos({ y: NOW.getFullYear(), m: NOW.getMonth() + 1, d: NOW.getDate(), bc: false });

  const SCREEN_PAINT = {
    ink: 'var(--ink)', soft: 'var(--ink-soft)', grid: 'var(--grid)', sheet: 'var(--sheet)', accent: 'var(--board)',
    cat: (i) => `var(--cat-${i})`,
  };

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const isTl = (t) => isObj(t) && typeof t.name === 'string' && typeof t.source === 'string';
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // Lehrkraft-Ansicht an einem anderen Gerät (Lehrer-PC), angemeldet mit Passwort.
  // Dort bleibt nichts im Browser liegen, alles kommt vom Laptop und geht dorthin zurück.
  const REMOTE = location.pathname === '/lehrkraft';

  /* ---------- Speicher ---------- */

  let idbOk = true;
  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('kein IndexedDB')); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blockiert'));
      });
    }
    return dbPromise;
  }
  async function dbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbPut(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function cleanImages(images) {
    const out = {};
    if (isObj(images)) for (const k of Object.keys(images)) if (validImage(images[k])) out[k] = images[k];
    return out;
  }
  function normalize(d) {
    if (!isObj(d) || !Array.isArray(d.timelines)) return null;
    const timelines = d.timelines.filter(isTl).map((t) => ({
      id: typeof t.id === 'string' && t.id ? t.id : newId(),
      name: t.name,
      source: t.source,
      images: cleanImages(t.images),
    }));
    if (!timelines.length) return null;
    const activeId = timelines.some((t) => t.id === d.activeId) ? d.activeId : timelines[0].id;
    return { activeId, timelines };
  }
  // Beim ersten Start gibt es nur einen leeren Zeitstrahl. Beispiele öffnet man bei Bedarf über „Datei → Beispiel öffnen …“.
  const NEW_NAME = 'Neuer Zeitstrahl';
  const NEW_SOURCE = '# Datum; Titel; Kategorie; Beschreibung\n';
  function freshState() {
    const id = newId();
    return { activeId: id, timelines: [{ id, name: NEW_NAME, source: NEW_SOURCE, images: {} }] };
  }
  // Mit Server gilt der Stand im Ordner daten auf dem Laptop, denn dort kann auch
  // ein anderes Gerät (Lehrer-PC) etwas geändert haben. Der mitgelieferte Stand gilt
  // erst, wenn die Daten auch übernommen werden (siehe syncFromServer).
  let loadedStand = null;
  async function loadFromServer() {
    try {
      const res = await fetch('api/sicherung', { headers: API_HEADERS, cache: 'no-store' });
      if (!res.ok) return undefined;
      const d = await res.json();
      loadedStand = typeof d.stand === 'string' ? d.stand : null;
      return normalize(d); // null: Ordner daten ist leer
    } catch (e) {
      return undefined; // Server antwortet nicht
    }
  }

  async function loadBrowser() {
    try {
      const d = normalize(await dbGet(DB_KEY));
      if (d) return d;
    } catch (e) {
      idbOk = false;
    }
    try {
      const d = normalize(JSON.parse(localStorage.getItem(LS_KEY) || 'null'));
      if (d) return d;
    } catch (e) { /* nichts gespeichert */ }
    return null;
  }
  async function loadState() {
    const d = await Stand.waehlen({ serverAn: server.on, lehrerPc: REMOTE, ladeServer: loadFromServer, ladeBrowser: loadBrowser });
    server.stand = loadedStand;
    if (!d) return freshState();
    // Jedes Gerät zeigt wieder den Zeitstrahl, den es zuletzt gezeigt hat
    let shown = '';
    try { shown = localStorage.getItem(SHOWN_KEY) || ''; } catch (e) { /* egal */ }
    if (d.timelines.some((t) => t.id === shown)) d.activeId = shown;
    return d;
  }
  function rememberShown() {
    try { localStorage.setItem(SHOWN_KEY, state.activeId); } catch (e) { /* egal */ }
  }

  let storageOk = true;
  let saveTimer = 0;
  async function persistNow(fromServer) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const snapshot = { activeId: state.activeId, timelines: state.timelines };
    let ok = REMOTE;
    if (REMOTE) { /* nur auf dem Laptop speichern */ } else if (idbOk) {
      try { await dbPut(DB_KEY, snapshot); ok = true; } catch (e) { idbOk = false; }
    }
    if (!ok) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); ok = true; } catch (e) { ok = false; }
    }
    storageOk = ok;
    showStatus(false);
    if (!fromServer) scheduleBackup();
  }
  function changed() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 400);
    markUnsaved();
    showStatus(true);
  }

  /* ---------- Erinnerung an eine Datei-Sicherung (nur ohne Server) ---------- */

  // Ohne Server liegen die Zeitstrahlen nur im Browser. Der darf sie bei Platzmangel
  // oder nach längerer Pause (Safari) löschen, wenn er nicht um dauerhaftes Speichern gebeten wurde.
  let persistAsked = false;
  function askPersist() {
    if (persistAsked || server.on) return;
    persistAsked = true;
    const st = navigator.storage;
    if (!st || !st.persist || !st.persisted) return;
    st.persisted().then((yes) => (yes ? true : st.persist())).catch(() => { /* egal */ });
  }

  // Merkt sich, seit wann es Änderungen ohne Datei-Sicherung gibt
  function markUnsaved() {
    if (REMOTE) return;
    try { if (!localStorage.getItem(UNSAVED_KEY)) localStorage.setItem(UNSAVED_KEY, String(Date.now())); } catch (e) { /* egal */ }
    askPersist();
  }
  function markBackedUp() {
    try { localStorage.removeItem(UNSAVED_KEY); } catch (e) { /* egal */ }
    showBackupDue();
  }
  function unsavedDays() {
    let since = 0;
    try { since = Number(localStorage.getItem(UNSAVED_KEY)) || 0; } catch (e) { /* egal */ }
    return since ? Math.floor((Date.now() - since) / 86400000) : 0;
  }
  function showBackupDue() {
    const days = unsavedDays();
    const due = !server.on && days >= REMIND_DAYS;
    const b = $('backup-due');
    b.hidden = !due;
    if (due) b.title = `Seit ${days} Tagen keine Sicherung als Datei. Speichert alle Zeitstrahlen als ZIP-Datei.`;
    return due ? days : 0;
  }
  function showStatus(pending) {
    const el = $('save-status');
    // Schüler-Zeitstrahlen werden hier nicht bearbeitet, also auch nicht gespeichert
    el.hidden = !!studentView;
    if (!storageOk) {
      el.textContent = 'Speichern im Browser klappt nicht. Bitte über „Datei“ sichern.';
      el.dataset.tone = 'warn';
      return;
    }
    el.textContent = pending ? 'Wird gespeichert …' : 'Gespeichert';
    el.title = REMOTE ? 'Auf dem Laptop im Ordner daten gespeichert'
      : server.on ? 'In diesem Browser und auf dem Laptop im Ordner daten gespeichert' : 'In diesem Browser gespeichert';
    el.dataset.tone = pending ? 'pending' : 'ok';
  }

  /* ---------- Klassenserver (wenn die Seite über server.js läuft) ---------- */

  const API_HEADERS = { 'X-Zeitstrahl': 'lehrkraft' };
  const server = {
    on: false, info: null, offline: false, ready: false, abgaben: [], known: new Map(), task: { thema: '', auftrag: '', kategorien: [] }, stand: null,
  };

  // Am Lehrer-PC: Nach einem Neustart des Servers oder einem neuen Passwort neu anmelden
  function checkLogin(res) {
    if (REMOTE && res.status === 403) location.replace('lehrkraft');
  }

  async function api(pathname, opts = {}) {
    const headers = { ...API_HEADERS, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) };
    const res = await fetch(pathname, { cache: 'no-store', ...opts, headers });
    checkLogin(res);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.fehler || 'Der Server hat die Anfrage abgelehnt.');
    return d;
  }

  async function detectServer() {
    if (!/^https?:$/.test(location.protocol)) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await fetch('api/verbindung', { headers: API_HEADERS, cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) return;
      server.info = await res.json();
      server.on = true;
    } catch (e) {
      /* kein Klassenserver */
    } finally {
      clearTimeout(t);
    }
  }

  const fmtWhen = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
    return d.toDateString() === new Date().toDateString() ? 'um ' + time : 'am ' + d.toLocaleDateString('de-DE') + ', ' + time;
  };

  // Abgaben nach Thema gruppieren (Reihenfolge wie vom Server geliefert)
  function groupByThema(list) {
    const groups = new Map();
    for (const a of list) {
      if (!groups.has(a.thema)) groups.set(a.thema, []);
      groups.get(a.thema).push(a);
    }
    return groups;
  }

  const signature = (list) => JSON.stringify(list.map((a) => [a.id, a.titel, a.von, a.status, a.anzahl, a.aktualisiert, a.rueckmeldung]));

  // Die Schüler-Zeitstrahlen der Klasse regelmäßig abfragen
  async function pollAbgaben() {
    try {
      const d = await api('api/abgaben');
      const list = Array.isArray(d.abgaben) ? d.abgaben : [];
      const listChanged = signature(list) !== signature(server.abgaben);
      for (const a of list) {
        const before = server.known.get(a.id);
        if (server.ready && !present && a.status === 'abgegeben' && (!before || before.status !== 'abgegeben')) {
          toast(`Abgegeben: „${a.titel || a.thema}“ von ${a.von}`);
        }
        server.known.set(a.id, a);
      }
      server.abgaben = list;
      server.offline = false;
      server.ready = true;
      // Ein anderes Gerät hat die Zeitstrahlen geändert
      if (typeof d.stand === 'string' && server.stand && d.stand !== server.stand && !syncPending()) syncFromServer();
      // Während jemand eine Rückmeldung tippt, bleibt die Liste stehen
      const typing = document.activeElement && document.activeElement.closest('.ab-feedback');
      if (listChanged) {
        renderPicker();
        if (!typing) renderAbgabenList();
        renderTlNav();
        renderKlassePanel();
      }
      // Der gerade gezeigte Schüler-Zeitstrahl wurde verändert oder gelöscht
      if (studentView && !present) {
        const cur = list.find((a) => a.id === studentView.abgabeId);
        if (!cur) {
          toast('Dieser Schüler-Zeitstrahl wurde gelöscht.');
          switchTo(state.activeId);
        } else if (cur.aktualisiert !== studentView.meta.aktualisiert) {
          reloadStudentView();
        }
      }
    } catch (e) {
      server.offline = true;
    }
    renderServerUi();
  }

  function renderServerUi() {
    const n = server.abgaben.length;
    $('klasse').hidden = !server.on;
    $('btn-abgaben').firstChild.textContent = server.offline ? 'Server nicht erreichbar ' : 'Schüler-Zeitstrahlen ';
    $('abgaben-count').textContent = n;
    $('abgaben-count').hidden = !n || server.offline;
    document.querySelectorAll('.connect-btn').forEach((c) => { c.hidden = !server.on; });
    $('link-student').hidden = server.on;
    document.querySelectorAll('.zugang-only').forEach((c) => { c.hidden = !server.on || REMOTE; });
    $('btn-logout').hidden = !REMOTE;
    $('help-save').innerHTML = REMOTE
      ? 'Alles wird auf dem Laptop im Ordner <code>daten</code> gespeichert. Änderungen von dort erscheinen hier nach wenigen Sekunden. Zum Weitergeben: <strong>Datei → Mit Bildern sichern</strong>.'
      : server.on
      ? 'Alles wird in diesem Browser und zusätzlich auf dem Laptop in <code>daten/zeitstrahlen</code> gespeichert, dazu je Tag eine Kopie in <code>daten/sicherungen</code>. Zum Weitergeben: <strong>Datei → Mit Bildern sichern</strong>.'
      : 'Alles wird nur in diesem Browser gespeichert. Als Sicherung: <strong>Datei → Alle Zeitstrahlen sichern</strong>. Zum Weitergeben: <strong>Datei → Mit Bildern sichern</strong>.';
    showBackupDue();
  }

  // Übersicht für die Lehrkraft, mit Code für den Fall, dass eine Gruppe ihn vergessen hat
  function renderAbgabenList() {
    const box = $('abgaben-list');
    box.textContent = '';
    if (!server.abgaben.length) {
      const p = document.createElement('p');
      p.className = 'empty-list';
      p.textContent = 'Noch keine Schüler-Zeitstrahlen. Über „Unterricht“ kommt die Klasse auf die Schülerseite.';
      box.append(p);
      return;
    }
    for (const [thema, list] of groupByThema(server.abgaben)) {
      const h = document.createElement('h3');
      h.textContent = thema;
      const ul = document.createElement('ul');
      ul.className = 'ab-list';
      for (const a of list) {
        const li = document.createElement('li');
        li.className = 'ab';
        const chip = document.createElement('span');
        chip.className = 'ab-status' + (a.status === 'abgegeben' ? ' done' : '');
        chip.textContent = a.status === 'abgegeben' ? 'abgegeben' : 'in Arbeit';
        const text = document.createElement('div');
        text.className = 'ab-text';
        const t = document.createElement('strong');
        t.textContent = a.titel || a.thema;
        const m = document.createElement('span');
        m.className = 'ab-meta';
        m.textContent = `von ${a.von} · ${a.anzahl} ${a.anzahl === 1 ? 'Ereignis' : 'Ereignisse'} · gespeichert ${fmtWhen(a.aktualisiert)} · Code ${a.code}`;
        text.append(t, m);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = 'Zeigen';
        btn.addEventListener('click', () => {
          $('abgaben').close();
          switchTo('abgabe:' + a.id);
        });
        const fb = document.createElement('button');
        fb.type = 'button';
        fb.className = 'btn ghost';
        fb.textContent = a.rueckmeldung ? 'Rückmeldung ändern' : 'Rückmeldung';
        const box = feedbackBox(a);
        fb.addEventListener('click', () => {
          box.hidden = !box.hidden;
          if (!box.hidden) box.querySelector('textarea').focus();
        });
        li.append(chip, text, fb, btn, box);
        ul.append(li);
      }
      box.append(h, ul);
    }
  }

  // Kurze Rückmeldung an eine Gruppe. Sie steht auf dem iPad, sobald die Gruppe
  // mit ihrem Code weiterarbeitet oder speichert.
  function feedbackBox(a) {
    const box = document.createElement('div');
    box.className = 'ab-feedback';
    box.hidden = !a.rueckmeldung;
    const label = document.createElement('label');
    label.textContent = `Rückmeldung an ${a.von}`;
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.maxLength = 1000;
    ta.value = a.rueckmeldung || '';
    ta.placeholder = 'z. B. Schöne Auswahl! Ergänzt noch ein Ereignis nach 1555.';
    label.htmlFor = 'fb-' + a.id;
    ta.id = 'fb-' + a.id;
    const row = document.createElement('div');
    row.className = 'ab-feedback-row';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn primary';
    save.textContent = 'Speichern';
    const state = document.createElement('span');
    state.className = 'ab-meta';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api('api/abgaben/' + a.id + '/rueckmeldung', { method: 'PUT', body: JSON.stringify({ rueckmeldung: ta.value.trim() }) });
        a.rueckmeldung = ta.value.trim();
        state.textContent = a.rueckmeldung ? 'Gespeichert. Die Gruppe sieht sie auf dem iPad.' : 'Rückmeldung entfernt.';
      } catch (e) {
        state.textContent = e.message;
      } finally {
        save.disabled = false;
      }
    });
    row.append(save, state);
    box.append(label, ta, row);
    return box;
  }

  // Ein Schüler-Zeitstrahl wird für die Anzeige in dieselbe Form gebracht wie die eigenen
  function abgabeToTimeline(a) {
    const images = {};
    const lines = (a.eintraege || []).map((e, i) => {
      let key = '';
      if (validImage(e.bild)) {
        key = 'b' + i;
        images[key] = e.bild;
      }
      return Parser.buildLine({
        datum: e.datum, titel: e.titel, kategorie: e.kategorie, beschreibung: e.beschreibung, quelle: e.bildquelle, bild: key,
      });
    });
    return {
      id: 'abgabe:' + a.id,
      abgabeId: a.id,
      name: [a.titel || a.thema, a.von].filter(Boolean).join(' – '),
      source: lines.join('\n') + '\n',
      images,
      meta: {
        titel: a.titel, von: a.von, thema: a.thema, status: a.status, aktualisiert: a.aktualisiert, code: a.code, anzahl: lines.length,
      },
    };
  }

  async function reloadStudentView() {
    try {
      studentView = abgabeToTimeline(await api('api/abgaben/' + studentView.abgabeId));
      reparse();
      keepSelection();
      renderHeading();
      renderStudentPanel();
      refreshLists();
      requestRender();
    } catch (e) { /* beim nächsten Abfragen erneut */ }
  }

  function renderStudentPanel() {
    const sv = studentView;
    $('editor-own').hidden = !!sv;
    $('student-panel').hidden = !sv;
    renderKlassePanel();
    showStatus(!!saveTimer);
    if (!sv) return;
    const m = sv.meta;
    $('sp-meta').textContent = [
      `${m.anzahl} ${m.anzahl === 1 ? 'Ereignis' : 'Ereignisse'}`,
      `${m.status === 'abgegeben' ? 'abgegeben' : 'in Arbeit, gespeichert'} ${fmtWhen(m.aktualisiert)}`,
      `Code ${m.code}`,
    ].join(' · ');
  }

  // Rechte Spalte bei einem Schüler-Zeitstrahl: Thema, Arbeitsauftrag und alle Gruppen dazu
  function renderKlassePanel() {
    const sv = studentView;
    $('help').hidden = !!sv;
    $('klasse-panel').hidden = !sv;
    if (!sv) return;
    const thema = sv.meta.thema;
    $('kp-title').textContent = thema;
    const auftrag = server.task.thema === thema ? server.task.auftrag : '';
    $('kp-auftrag').textContent = auftrag;
    $('kp-auftrag').hidden = !auftrag;
    const ul = $('kp-list');
    ul.textContent = '';
    for (const a of server.abgaben.filter((x) => x.thema === thema)) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kp-item';
      const cur = a.id === sv.abgabeId;
      if (cur) b.setAttribute('aria-current', 'true');
      const text = document.createElement('span');
      text.className = 'kp-text';
      const t = document.createElement('strong');
      t.textContent = a.titel || a.thema;
      const m = document.createElement('span');
      m.textContent = `${a.von} · ${a.anzahl} ${a.anzahl === 1 ? 'Ereignis' : 'Ereignisse'}`;
      text.append(t, m);
      const chip = document.createElement('span');
      chip.className = 'ab-status' + (a.status === 'abgegeben' ? ' done' : '');
      chip.textContent = a.status === 'abgegeben' ? 'abgegeben' : 'in Arbeit';
      b.append(text, chip);
      b.addEventListener('click', () => { if (!cur) switchTo('abgabe:' + a.id); });
      li.append(b);
      ul.append(li);
    }
  }

  function copyStudentView() {
    const sv = studentView;
    if (!sv) return;
    const t = addTimeline({ name: sv.name, source: sv.source, images: clone(sv.images) });
    switchTo(t.id, true);
    toast(`„${displayName(t)}“ liegt jetzt in deinen Zeitstrahlen.`);
  }

  let spDelArmed = 0;
  async function deleteStudentView() {
    const b = $('sp-del');
    if (!studentView) return;
    if (!spDelArmed) {
      b.textContent = 'Wirklich löschen?';
      b.classList.add('armed');
      spDelArmed = setTimeout(() => {
        spDelArmed = 0;
        b.textContent = 'Abgabe löschen';
        b.classList.remove('armed');
      }, 4000);
      return;
    }
    clearTimeout(spDelArmed);
    spDelArmed = 0;
    b.textContent = 'Abgabe löschen';
    b.classList.remove('armed');
    try {
      await api('api/abgaben/' + studentView.abgabeId, { method: 'DELETE' });
      toast('Abgabe gelöscht. Sie liegt noch im Ordner daten/archiv auf dem Laptop.');
      await switchTo(state.activeId);
      pollAbgaben();
    } catch (e) {
      toast(e.message);
    }
  }

  let backupTimer = 0;
  let pushing = 0;
  let backupChain = Promise.resolve();
  function scheduleBackup() {
    if (!server.on) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(() => {
      backupTimer = 0;
      pushing++;
      // Nacheinander senden, damit jede Sendung auf dem Stand der vorigen aufbaut
      backupChain = backupChain.then(pushBackup).finally(() => { pushing--; });
    }, 3000);
  }
  const syncPending = () => !!(saveTimer || backupTimer || pushing);

  async function pushBackup() {
    try {
      const res = await fetch('api/sicherung', {
        method: 'PUT',
        headers: { ...API_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app: 'zeitstrahl-werkstatt', gesichert: new Date().toISOString(), activeId: state.activeId, timelines: state.timelines,
          ...(server.stand ? { stand: server.stand } : {}),
        }),
      });
      checkLogin(res);
      const d = await res.json().catch(() => ({}));
      if (res.ok && typeof d.stand === 'string') server.stand = d.stand;
      if (res.status === 409) {
        // Beide Geräte haben gleichzeitig geändert: Der Laptop-Ordner gilt
        await syncFromServer(true);
        toast('Auf dem anderen Gerät wurde gerade etwas geändert. Deine letzte Änderung ließ sich deshalb nicht speichern, hier steht jetzt der neue Stand.');
      }
    } catch (e) { /* nächster Versuch beim nächsten Speichern */ }
  }

  // Den Stand vom Laptop übernehmen, den gezeigten Zeitstrahl und Ausschnitt möglichst behalten
  // Läuft schon ein Abgleich, wartet ein erzwungener (nach 409) auf ihn und holt danach selbst neu
  let syncing = null;
  function syncFromServer(force) {
    if (syncing) return force ? syncing.then(() => syncFromServer(true)) : syncing;
    syncing = applyServerState(force).finally(() => { syncing = null; });
    return syncing;
  }
  async function applyServerState(force) {
    const d = await loadFromServer();
    // Inzwischen geändert: nichts übernehmen und den alten Stand behalten. Sonst ginge die
    // eigene Änderung mit dem neuen Stand durch und würde die des anderen Geräts überschreiben.
    if (!d || (!force && syncPending())) return;
    server.stand = loadedStand;
    const before = ownTl();
    const keepId = d.timelines.some((t) => t.id === state.activeId) ? state.activeId : d.activeId;
    state = { activeId: keepId, timelines: d.timelines };
    persistNow(true);
    const now = ownTl();
    const same = before && now.id === before.id;
    const editing = document.activeElement && ['tl-name', 'tl-source'].includes(document.activeElement.id);
    if (!same || !editing || now.name !== $('tl-name').value || now.source !== $('tl-source').value) loadEditor();
    renderPicker();
    renderTlNav();
    if (studentView) return;
    if (!same) {
      hiddenCats = new Set();
      selectedId = null;
      selectedTitle = null;
      reveal.n = 0;
    }
    reparse();
    keepSelection();
    renderHeading();
    refreshLists();
    if (same) requestRender();
    else refit(false);
  }

  // Adresse und Passwort-Stand für den Lehrer-PC (nur am Laptop selbst).
  // Festgelegt wird das Passwort im Server-Fenster, damit es auch ohne Bildschirm am Server geht.
  let zugang = null;
  function renderZugang() {
    const z = zugang || { passwort: false, adressen: [], port: 8080 };
    const ips = z.adressen || [];
    const url = (ip) => `http://${z.port === 80 ? ip : `${ip}:${z.port}`}/lehrkraft`;
    $('zugang-url').textContent = ips.length ? url(ips[0]) : '';
    $('zugang-url').hidden = !ips.length;
    $('zugang-none').hidden = ips.length > 0;
    const alt = ips.slice(1).map(url);
    $('zugang-alt').textContent = alt.length ? 'Falls es nicht klappt: ' + alt.join(' · ') : '';
    $('zugang-alt').hidden = !alt.length;
    const st = $('zugang-state');
    st.textContent = z.passwort
      ? `Passwort ist festgelegt.${z.angemeldet ? ` Angemeldete Geräte: ${z.angemeldet}.` : ''}`
      : 'Noch kein Passwort festgelegt. Ohne Passwort kommt nur dieser Laptop in die Lehrkraft-Ansicht.';
    st.dataset.tone = z.passwort ? 'ok' : '';
    $('zugang-how').innerHTML = (z.passwort ? 'Ändern oder entfernen' : 'Festlegen')
      + ': das Server-Fenster schließen und im Werkstatt-Ordner <code>node server.js --passwort</code> starten. Das Server-Fenster fragt dann nach dem Passwort.';
  }

  async function openZugang() {
    try {
      zugang = await api('api/zugang');
    } catch (e) {
      toast(e.message);
      return;
    }
    renderZugang();
    $('zugang').showModal();
  }

  async function logout() {
    if (syncPending()) {
      clearTimeout(saveTimer);
      saveTimer = 0;
      clearTimeout(backupTimer);
      backupTimer = 0;
      await backupChain.then(pushBackup); // Letzte Änderung noch auf den Laptop bringen
    }
    try { await api('api/abmelden', { method: 'POST' }); } catch (e) { /* trotzdem zur Anmeldung */ }
    location.replace('lehrkraft?hinweis=abgemeldet');
  }

  // QR-Code als SVG (schwarz auf weiß, damit jede Kamera ihn liest)
  function qrSvg(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
    const size = n + quiet * 2;
    return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="QR-Code zur Schülerseite" shape-rendering="crispEdges">`
      + `<rect width="${size}" height="${size}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
  }

  // Thema, Auftrag und Kategorien wirken auf die rechte Spalte und die Farben eines Schüler-Zeitstrahls
  function applyTask() {
    renderKlassePanel();
    if (!studentView) return;
    reparse();
    requestRender();
  }

  async function loadTask() {
    try {
      server.task = await api('api/aufgabe');
    } catch (e) { /* bleibt leer */ }
  }

  function renderTaskState() {
    const t = server.task.thema;
    const zu = !!server.task.gesperrt;
    $('task-state').textContent = zu
      ? 'Die Abgabe ist beendet. Die iPads können nichts mehr speichern.'
      : t
      ? `Die iPads zeigen jetzt das Thema „${t}“.`
      : 'Noch kein Thema festgelegt. Ohne Thema wählen die Schüler selbst eins.';
    $('connect-thema').textContent = t || 'frei wählbar';
    $('btn-sperre').textContent = zu ? 'Bearbeiten wieder erlauben' : 'Abgabe beenden';
    $('sperre-note').hidden = !zu;
    $('abgaben-sperre').hidden = !zu;
  }

  // Beim Präsentieren soll niemand mehr am eigenen Zeitstrahl ändern
  async function toggleSperre() {
    const zu = !server.task.gesperrt;
    try {
      server.task = await api('api/aufgabe', { method: 'PUT', body: JSON.stringify({ gesperrt: zu }) });
      renderTaskState();
      toast(zu ? 'Abgabe beendet. Die iPads können nichts mehr speichern.' : 'Die Klasse kann wieder weiterarbeiten.');
    } catch (e) {
      toast(e.message);
    }
  }

  const splitKategorien = (text) => cleanKategorien(String(text).split(/[,;\n]/));

  // Kategorien des eigenen Zeitstrahls in der Reihenfolge, in der sie zuerst vorkommen
  function takeOwnKategorien() {
    const cats = Parser.parseSource(ownTl().source, NOW).cats.map((c) => c.name);
    const list = cleanKategorien(cats);
    if (!list.length) return toast('Der Zeitstrahl hat noch keine Kategorien.');
    $('task-kategorien').value = list.join(', ');
    if (cats.length > list.length) toast(`Nur die ersten ${MAX_KATEGORIEN} Kategorien übernommen.`);
  }

  async function saveTask(ev) {
    ev.preventDefault();
    try {
      server.task = await api('api/aufgabe', {
        method: 'PUT',
        body: JSON.stringify({
          thema: $('task-thema').value.trim(),
          auftrag: $('task-auftrag').value.trim(),
          kategorien: splitKategorien($('task-kategorien').value),
          gesperrt: !!server.task.gesperrt,
        }),
      });
      renderTaskState();
      applyTask();
      toast(server.task.thema ? `Thema „${server.task.thema}“ festgelegt.` : 'Thema zurückgesetzt.');
    } catch (e) {
      toast(e.message);
    }
  }

  // Ein eigener Zeitstrahl der Lehrkraft, den die iPads nur ansehen (daten/aufgabe.json, Feld „freigabe“)
  function renderFreigabe() {
    const sel = $('task-freigabe');
    const id = server.task.freigabe || '';
    sel.innerHTML = '<option value="">keiner</option>' + state.timelines
      .map((t) => `<option value="${Layout.esc(t.id)}">${Layout.esc(displayName(t))}</option>`).join('');
    sel.value = state.timelines.some((t) => t.id === id) ? id : '';
  }

  async function saveFreigabe() {
    const id = $('task-freigabe').value;
    try {
      server.task = await api('api/aufgabe', { method: 'PUT', body: JSON.stringify({ freigabe: id }) });
      const t = state.timelines.find((x) => x.id === id);
      toast(t ? `Die iPads können jetzt „${displayName(t)}“ ansehen.` : 'Die iPads zeigen keinen Zeitstrahl von dir mehr.');
    } catch (e) {
      toast(e.message);
      renderFreigabe();
    }
  }

  async function openConnect() {
    await detectServer(); // Adressen neu abfragen, falls das WLAN gewechselt hat
    await loadTask();
    const ips = (server.info && server.info.adressen) || [];
    const port = server.info ? server.info.port : 8080;
    $('task-thema').value = server.task.thema || displayName(ownTl()).replace(/\s*\(Beispiel\)\s*$/, '');
    $('task-auftrag').value = server.task.auftrag || '';
    $('task-kategorien').value = (server.task.kategorien || []).join(', ');
    renderTaskState();
    renderFreigabe();
    $('connect-grid').hidden = !ips.length;
    $('connect-none').hidden = ips.length > 0;
    if (ips.length) {
      const hostPort = (ip) => (port === 80 ? ip : `${ip}:${port}`); // Port 80 muss man nicht eintippen
      $('connect-qr').innerHTML = qrSvg(`http://${hostPort(ips[0])}/`);
      $('connect-url').textContent = hostPort(ips[0]); // Safari ergänzt http:// selbst
      const alt = ips.slice(1).map(hostPort);
      $('connect-alt').textContent = alt.length ? 'Falls es nicht klappt: ' + alt.join(' · ') : '';
      $('connect-alt').hidden = !alt.length;
    }
    const dlg = $('connect');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  /* ---------- Sortier-Übung „Was kam zuerst?“ ---------- */

  // Die Ereignisse des gezeigten Zeitstrahls kommen gemischt an die Tafel, die Klasse
  // bringt sie in die richtige Reihenfolge. Das Datum bleibt verdeckt, bis geprüft wird.
  let sortCards = [];
  let sortSolved = false;

  function openSort() {
    const items = revealOrder();
    if (items.length < 3) {
      toast('Für die Übung braucht der Zeitstrahl mindestens drei Ereignisse.');
      return;
    }
    sortCards = shuffleCards(items.slice(0, 12));
    sortSolved = false;
    $('sort-result').textContent = '';
    $('sort-result').dataset.tone = '';
    renderSort();
    const dlg = $('sort');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  // Mischen, aber nie in der richtigen Reihenfolge anfangen
  function shuffleCards(items) {
    const cards = items.map((it, i) => ({ it, pos: i }));
    for (let n = 0; n < 20; n++) {
      for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
      }
      if (cards.some((c, i) => c.pos !== i)) break;
    }
    return cards;
  }

  function renderSort() {
    const ol = $('sort-list');
    ol.textContent = '';
    sortCards.forEach((c, i) => {
      const li = document.createElement('li');
      li.className = 'sort-card';
      if (c.state) li.dataset.state = c.state;
      li.draggable = true;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(i));
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (e) => e.preventDefault());
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (Number.isInteger(from)) moveCard(from, i);
      });
      const dot = document.createElement('span');
      dot.className = 'swatch';
      dot.style.background = `var(--cat-${c.it.ci})`;
      const text = document.createElement('div');
      text.className = 'sort-text';
      const t = document.createElement('strong');
      t.textContent = c.it.title;
      const m = document.createElement('span');
      m.className = 'ab-meta';
      m.textContent = sortSolved ? `${c.it.shortDate} · ${c.it.cat}` : c.it.cat;
      text.append(t, m);
      const tools = document.createElement('div');
      tools.className = 'sort-tools';
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'btn icon';
      up.textContent = '↑';
      up.setAttribute('aria-label', `„${c.it.title}“ nach oben`);
      up.disabled = i === 0;
      up.addEventListener('click', () => moveCard(i, i - 1));
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'btn icon';
      down.textContent = '↓';
      down.setAttribute('aria-label', `„${c.it.title}“ nach unten`);
      down.disabled = i === sortCards.length - 1;
      down.addEventListener('click', () => moveCard(i, i + 1));
      tools.append(up, down);
      li.append(dot, text, tools);
      ol.append(li);
    });
  }

  function moveCard(from, to) {
    if (to < 0 || to >= sortCards.length || from === to) return;
    const [card] = sortCards.splice(from, 1);
    sortCards.splice(to, 0, card);
    for (const c of sortCards) c.state = '';
    $('sort-result').textContent = '';
    $('sort-result').dataset.tone = '';
    renderSort();
    const items = [...$('sort-list').children];
    const btn = items[to] && items[to].querySelector('.sort-tools button:not([disabled])');
    if (btn) btn.focus();
  }

  function checkSort() {
    // Gleich alte Ereignisse dürfen in beliebiger Reihenfolge stehen
    const order = sortCards.map((c) => c.it.start);
    let right = 0;
    sortCards.forEach((c, i) => {
      const okBefore = i === 0 || order[i - 1] <= c.it.start;
      const okAfter = i === order.length - 1 || c.it.start <= order[i + 1];
      c.state = okBefore && okAfter ? 'ok' : 'wrong';
      if (c.state === 'ok') right++;
    });
    renderSort();
    const all = right === sortCards.length;
    $('sort-result').textContent = all
      ? 'Alles richtig! Die Reihenfolge stimmt.'
      : `${right} von ${sortCards.length} stehen an der richtigen Stelle. Die roten Karten passen noch nicht.`;
    $('sort-result').dataset.tone = all ? 'ok' : 'warn';
  }

  function solveSort() {
    sortCards.sort((a, b) => a.it.start - b.it.start || a.it.line - b.it.line);
    for (const c of sortCards) c.state = 'ok';
    sortSolved = true;
    renderSort();
    $('sort-result').textContent = 'So war es richtig. Mit „Neu mischen“ geht es noch einmal los.';
    $('sort-result').dataset.tone = 'ok';
  }

  /* ---------- Zeitstrahlen nacheinander zeigen (Tafelbild) ---------- */

  // Bei einem Schüler-Zeitstrahl: alle Zeitstrahlen desselben Themas, sonst die eigenen
  function timelineSequence() {
    if (studentView) {
      const thema = studentView.meta.thema;
      return server.abgaben.filter((a) => a.thema === thema).map((a) => 'abgabe:' + a.id);
    }
    return state.timelines.map((t) => t.id);
  }
  const currentKey = () => (studentView ? studentView.id : state.activeId);

  function renderTlNav() {
    const seq = timelineSequence();
    const i = seq.indexOf(currentKey());
    $('tl-nav').hidden = seq.length < 2;
    $('tl-nav-count').textContent = seq.length > 1 ? `Zeitstrahl ${i + 1} von ${seq.length}` : '';
  }

  async function stepTimeline(d) {
    const seq = timelineSequence();
    if (seq.length < 2) return;
    const i = seq.indexOf(currentKey());
    await switchTo(seq[(i + d + seq.length) % seq.length]);
  }

  /* ---------- Zustand ---------- */

  let state = freshState();
  let studentView = null; // angezeigter Schüler-Zeitstrahl (nur ansehen) oder null
  let parsed = { items: [], problems: [], cats: [] };
  let view = { v0: 1400, v1: 2030 };
  let userMovedView = false;
  let hiddenCats = new Set();
  let selectedId = null;
  let selectedTitle = null;
  let present = false;
  let fsByUs = false;
  const reveal = { on: false, n: 0 };

  const ownTl = () => state.timelines.find((t) => t.id === state.activeId) || state.timelines[0];
  const activeTl = () => studentView || ownTl();
  const displayName = (t) => (t.name || '').trim() || 'Ohne Titel';
  const visibleItems = () => parsed.items.filter((i) => !hiddenCats.has(i.catKey));
  const revealOrder = () => visibleItems().slice().sort((a, b) => a.start - b.start || a.line - b.line);
  const shownItems = () => (present && reveal.on ? revealOrder().slice(0, reveal.n) : visibleItems());
  const currentItem = () => (selectedId ? parsed.items.find((i) => i.id === selectedId) : null);

  // Vorgegebene Kategorien färben die Schüler-Zeitstrahlen zum aktuellen Thema einheitlich
  const presetFor = (tl) => (tl.meta && tl.meta.thema && tl.meta.thema === server.task.thema ? server.task.kategorien : null);

  function reparse() {
    parsed = Parser.parseSource(activeTl().source, NOW, presetFor(activeTl()));
  }

  /* ---------- Sichtbarer Zeitraum ---------- */

  function clampView(v) {
    const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, v.v1 - v.v0));
    let v0 = (v.v0 + v.v1) / 2 - span / 2;
    v0 = Math.max(LIMIT_LO, Math.min(LIMIT_HI - span, v0));
    return { v0, v1: v0 + span };
  }

  // Zeigt alle Einträge mit etwas Rand (Beschriftungen am Rand weichen im Layout selbst aus)
  function fitView() {
    return fitRange(visibleItems());
  }
  function fitRange(items) {
    if (!items.length) return clampView({ v0: 1400, v1: 2030 });
    let lo = Infinity;
    let hi = -Infinity;
    for (const it of items) {
      lo = Math.min(lo, it.start);
      hi = Math.max(hi, it.end);
    }
    if (hi - lo < 2) { lo -= 5; hi += 5; }
    const pad = (hi - lo) * 0.04;
    return clampView({ v0: lo - pad, v1: hi + pad });
  }

  function zoomAt(factor, x) {
    const W = stage.clientWidth || 1;
    const span = view.v1 - view.v0;
    const t = view.v0 + (x / W) * span;
    const ns = Math.min(MAX_SPAN, Math.max(MIN_SPAN, span * factor));
    const v0 = t - (x / W) * ns;
    view = clampView({ v0, v1: v0 + ns });
    userMovedView = true;
    requestRender();
  }
  function panPx(dx) {
    const W = stage.clientWidth || 1;
    const dt = (dx / W) * (view.v1 - view.v0);
    view = clampView({ v0: view.v0 + dt, v1: view.v1 + dt });
    userMovedView = true;
    requestRender();
  }

  let anim = 0;
  function animateTo(target) {
    cancelAnimationFrame(anim);
    if (reduceMotion()) { view = target; requestRender(); return; }
    const from = { v0: view.v0, v1: view.v1 };
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 420);
      const e = 1 - Math.pow(1 - k, 3);
      view = { v0: from.v0 + (target.v0 - from.v0) * e, v1: from.v1 + (target.v1 - from.v1) * e };
      render();
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  function refit(animated) {
    const target = fitView();
    userMovedView = false;
    if (animated) animateTo(target);
    else { view = target; requestRender(); }
  }

  /* ---------- Zeichnen ---------- */

  let raf = 0;
  function requestRender() {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
  }
  function render() {
    const W = stage.clientWidth;
    if (W < 20) return;
    const isEmpty = parsed.items.length === 0;
    $('empty').hidden = !isEmpty;
    if (isEmpty) { stage.textContent = ''; return; } // ohne Einträge keine Achse, nur der Hinweis
    const items = shownItems();
    const draw = (scale) => Layout.layout(items, view, W, { scale, family: FAM_SCREEN, measure });
    let g = draw(present ? PRESENT_SCALE : 1);
    // Im Tafelbild gibt es keinen Platz zum Scrollen: Passt der Zeitstrahl nicht auf den
    // Beamer (z. B. 1024 × 768), wird er so weit verkleinert, bis alles sichtbar ist.
    const box = Math.floor(stage.clientHeight);
    if (present && box > 100 && g.H > box) {
      let scale = PRESENT_SCALE;
      for (let i = 0; i < 4 && g.H > box; i++) {
        scale = Math.max(MIN_PRESENT_SCALE, scale * (box / g.H));
        g = draw(scale);
        if (scale <= MIN_PRESENT_SCALE) break;
      }
    }
    const H = Math.max(Math.ceil(g.H), box);
    const offY = Math.max(0, (H - g.H) / 2);
    const active = document.activeElement;
    const focusId = active && active !== stage && stage.contains(active) ? active.getAttribute('data-id') : null;
    stage.innerHTML = `<svg class="tl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="${Layout.esc(displayName(activeTl()))}">`
      + `<g transform="translate(0 ${offY.toFixed(1)})">${Layout.svgBody(g, SCREEN_PAINT, { selectedId, interactive: true, todayPos: TODAY_POS })}</g></svg>`;
    if (focusId) {
      const el = stage.querySelector(`[data-id="${focusId}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  /* ---------- Bereiche neben der Bühne ---------- */

  function renderPicker() {
    const sel = $('tl-select');
    sel.textContent = '';
    const own = document.createElement('optgroup');
    own.label = 'Meine Zeitstrahlen';
    for (const t of state.timelines) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = displayName(t);
      own.append(o);
    }
    sel.append(own);
    for (const [thema, list] of groupByThema(server.abgaben)) {
      const g = document.createElement('optgroup');
      g.label = `Schüler: ${thema}`;
      for (const a of list) {
        const o = document.createElement('option');
        o.value = 'abgabe:' + a.id;
        o.textContent = `${a.titel || a.thema} – ${a.von}${a.status === 'abgegeben' ? '' : ' (in Arbeit)'}`;
        g.append(o);
      }
      sel.append(g);
    }
    sel.value = currentKey();
    $('btn-del').disabled = state.timelines.length < 2;
  }

  function renderLegend() {
    const el = $('legend');
    el.textContent = '';
    for (const c of parsed.cats) {
      const shown = !hiddenCats.has(c.key);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.style.setProperty('--c', `var(--cat-${c.ci})`);
      b.setAttribute('aria-pressed', String(shown));
      b.title = shown ? `${c.name} ausblenden` : `${c.name} einblenden`;
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.textContent = c.name;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = c.count;
      b.append(sw, name, n);
      b.addEventListener('click', () => {
        if (hiddenCats.has(c.key)) hiddenCats.delete(c.key);
        else hiddenCats.add(c.key);
        const it = currentItem();
        if (it && hiddenCats.has(it.catKey)) select(null);
        renderLegend();
        renderReveal();
        requestRender();
      });
      el.append(b);
    }
  }

  function renderProblems() {
    const ul = $('problems');
    ul.textContent = '';
    const list = parsed.problems;
    for (const p of list.slice(0, 12)) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'problem';
      b.textContent = `Zeile ${p.line + 1}: ${p.msg}`;
      b.addEventListener('click', () => gotoLine(p.line));
      li.append(b);
      ul.append(li);
    }
    if (list.length > 12) {
      const li = document.createElement('li');
      li.className = 'problem';
      li.textContent = `… und ${list.length - 12} weitere Zeilen mit Fehlern`;
      ul.append(li);
    }
  }

  function renderHeading() {
    const sv = studentView;
    // Bei Schüler-Zeitstrahlen stehen die Namen in einer eigenen Zeile unter dem Titel
    $('tl-heading').textContent = sv ? sv.meta.titel || sv.meta.thema : displayName(activeTl());
    $('tl-sub').textContent = sv ? `von ${sv.meta.von}${sv.meta.status === 'abgegeben' ? '' : ' · noch in Arbeit'}` : '';
    $('tl-sub').hidden = !sv;
  }

  function refreshLists() {
    renderLegend();
    renderProblems();
    renderReveal();
    renderDetail();
  }

  function loadEditor() {
    const t = ownTl();
    $('tl-name').value = t.name;
    $('tl-source').value = t.source;
  }

  function gotoLine(n) {
    const ta = $('tl-source');
    const lines = ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < n && i < lines.length; i++) pos += lines[i].length + 1;
    ta.focus();
    ta.setSelectionRange(pos, pos + (lines[n] || '').length);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 21;
    ta.scrollTop = Math.max(0, n * lh - ta.clientHeight / 3);
  }

  /* ---------- Auswahl und Details ---------- */

  function select(id) {
    selectedId = id;
    const it = currentItem();
    selectedTitle = it ? it.title : null;
    renderDetail();
    requestRender();
  }

  function keepSelection() {
    if (!selectedId) return;
    const same = parsed.items.find((i) => i.id === selectedId && i.title === selectedTitle);
    if (same) return;
    const byTitle = parsed.items.find((i) => i.title === selectedTitle);
    selectedId = byTitle ? byTitle.id : null;
  }

  function renderDetail() {
    const it = currentItem();
    const box = $('detail');
    if (!it) { box.hidden = true; return; }
    box.hidden = false;
    $('detail-swatch').style.background = `var(--cat-${it.ci})`;
    $('detail-cat').textContent = it.cat;
    $('detail-title').textContent = it.title;
    $('detail-when').textContent = it.kind === 'span' ? `${it.longDate} · ${Parser.durationText(it)}` : it.longDate;
    $('detail-ago').textContent = Parser.agoText(it, NOW);
    $('detail-desc').textContent = it.desc;
    $('detail-desc').hidden = !it.desc;

    const src = it.img ? activeTl().images[it.img] : '';
    const img = $('detail-img');
    if (src) {
      img.src = src;
      img.alt = it.title;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
    const meta = [];
    if (it.von) meta.push('Beitrag von ' + it.von);
    if (it.quelle) meta.push('Bildquelle: ' + it.quelle);
    if (it.img && !src) meta.push('Das Bild zu diesem Eintrag fehlt.');
    $('detail-meta').textContent = meta.join(' · ');
    $('detail-meta').hidden = !meta.length;

    $('detail-tools').hidden = present || !!studentView;
    $('detail-img-add').textContent = src ? 'Bild ersetzen' : 'Bild hinzufügen';
    $('detail-img-del').hidden = !src;
  }

  // Ersetzt oder entfernt eine Zusatzangabe wie {bild:…} in einer Zeile
  function setLineMeta(lineIdx, key, value) {
    const tl = ownTl();
    const lines = tl.source.split('\n');
    let line = lines[lineIdx] || '';
    line = line.replace(new RegExp('\\s*\\{' + key + ':[^{}]*\\}', 'gi'), '');
    if (value) line = line.replace(/\s+$/, '') + ` {${key}:${value}}`;
    lines[lineIdx] = line;
    tl.source = lines.join('\n');
  }

  function afterSourceChange() {
    $('tl-source').value = activeTl().source;
    reparse();
    keepSelection();
    refreshLists();
    requestRender();
    changed();
  }

  /* ---------- Zeitstrahl wechseln, anlegen, löschen ---------- */

  // modified: Zeitstrahlen wurden dabei angelegt, gelöscht oder ersetzt. Nur dann wird gespeichert
  // und an den Laptop geschickt; welcher Zeitstrahl gezeigt wird, merkt sich jedes Gerät selbst.
  async function switchTo(id, modified) {
    if (typeof id === 'string' && id.startsWith('abgabe:')) {
      try {
        studentView = abgabeToTimeline(await api('api/abgaben/' + id.slice(7)));
      } catch (e) {
        toast(e.message || 'Der Schüler-Zeitstrahl ließ sich nicht laden.');
        renderPicker();
        return;
      }
    } else {
      studentView = null;
      if (state.timelines.some((t) => t.id === id)) state.activeId = id;
      rememberShown();
      if (modified) changed();
    }
    hiddenCats = new Set();
    selectedId = null;
    selectedTitle = null;
    reveal.n = 0;
    loadEditor();
    reparse();
    renderPicker();
    renderHeading();
    renderStudentPanel();
    refreshLists();
    renderTlNav();
    refit(false);
  }

  function addTimeline(t) {
    const tl = { id: newId(), name: t.name, source: t.source, images: t.images || {} };
    state.timelines.push(tl);
    return tl;
  }

  /* ---------- Beispiele ---------- */

  // Ein Beispiel, das schon angelegt ist (auch unter neuer id), wird nur aufgerufen statt verdoppelt
  const sampleTl = (s) => state.timelines.find((t) => t.id === s.id || t.name === s.name);
  // Der unberührte leere Zeitstrahl vom Start wird durch das Beispiel ersetzt
  const isUntouched = (t) => t && t.name === NEW_NAME && t.source.replace(/^#.*$/gm, '').trim() === ''
    && !Object.keys(t.images || {}).length;

  function openSamples() {
    const list = $('samples-list');
    list.textContent = '';
    for (const s of SAMPLES) {
      const items = Parser.parseSource(s.source, NOW).items;
      const lo = items.reduce((m, it) => (it.start < m.start ? it : m), items[0]);
      const hi = items.reduce((m, it) => ((it.end ?? it.start) > (m.end ?? m.start) ? it : m), items[0]);
      const year = (p) => (p.today ? 'heute' : p.bc ? p.y + ' v. Chr.' : String(p.y));
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sample';
      const text = document.createElement('span');
      text.className = 'ab-text';
      const name = document.createElement('strong');
      name.textContent = s.name.replace(/\s*\(Beispiel\)\s*$/, '');
      const meta = document.createElement('span');
      meta.className = 'ab-meta';
      const parts = [items.length + ' Einträge'];
      if (items.length) parts.push(year(lo.a) + ' bis ' + year(hi.b || hi.a));
      if (s.code) parts.push('Schülercode ' + s.code);
      meta.textContent = parts.join(' · ');
      text.append(name, meta);
      b.append(text);
      if (sampleTl(s)) {
        const tag = document.createElement('span');
        tag.className = 'ab-status done';
        tag.textContent = 'schon da';
        b.append(tag);
      }
      b.addEventListener('click', () => { $('samples').close(); openSample(s); });
      li.append(b);
      list.append(li);
    }
    $('samples').showModal();
  }

  function openSample(s) {
    const had = sampleTl(s);
    if (had) { switchTo(had.id); return; }
    const own = ownTl();
    const t = addTimeline({ name: s.name, source: s.source, images: {} });
    if (!studentView && state.timelines.length > 1 && isUntouched(own)) {
      state.timelines = state.timelines.filter((x) => x !== own);
    }
    switchTo(t.id, true);
    toast(`Beispiel „${t.name.replace(/\s*\(Beispiel\)\s*$/, '')}“ geöffnet.`);
  }

  let delArmed = 0;
  function disarmDelete() {
    clearTimeout(delArmed);
    delArmed = 0;
    const b = $('btn-del');
    b.textContent = 'Löschen';
    b.classList.remove('armed');
  }

  /* ---------- Schrittweise aufdecken ---------- */

  function renderReveal() {
    const total = revealOrder().length;
    reveal.n = Math.min(reveal.n, total);
    const on = reveal.on;
    $('reveal-toggle').setAttribute('aria-pressed', String(on));
    $('reveal-toggle').textContent = on ? 'Alle zeigen' : 'Schrittweise aufdecken';
    for (const id of ['reveal-prev', 'reveal-next', 'reveal-count', 'reveal-keys']) $(id).hidden = !on;
    $('reveal-count').textContent = `${reveal.n} / ${total}`;
    $('reveal-prev').disabled = reveal.n <= 0;
    $('reveal-next').disabled = reveal.n >= total;
  }

  function stepReveal(d) {
    const order = revealOrder();
    const n = Math.max(0, Math.min(order.length, reveal.n + d));
    if (n === reveal.n) return;
    reveal.n = n;
    const it = n > 0 ? order[n - 1] : null;
    selectedId = it ? it.id : null;
    selectedTitle = it ? it.title : null;
    renderDetail();
    renderReveal();
    // Nur verschieben, wenn das Ereignis nicht ganz zu sehen ist – dann so, dass es ganz hineinpasst
    if (it && d > 0 && (it.start < view.v0 || it.end > view.v1)) {
      const span = view.v1 - view.v0;
      const len = it.end - it.start;
      const v0 = len < span * 0.8 ? it.start - (span - len) / 2 : it.start - span * 0.05;
      userMovedView = true;
      animateTo(clampView({ v0, v1: v0 + Math.max(span, len * 1.1) }));
      return;
    }
    requestRender();
  }

  /* ---------- Tafelbild ---------- */

  function setPresent(on) {
    present = on;
    document.body.classList.toggle('present', on);
    if (on) {
      const el = document.documentElement;
      if (el.requestFullscreen && !document.fullscreenElement) {
        el.requestFullscreen().then(() => { fsByUs = true; }).catch(() => {});
      }
      stage.focus({ preventScroll: true });
    } else {
      if (document.fullscreenElement && fsByUs) document.exitFullscreen().catch(() => {});
      fsByUs = false;
      reveal.on = false;
    }
    renderReveal();
    renderDetail();
    requestAnimationFrame(() => refit(false));
  }

  /* ---------- Dateien ---------- */

  // Nur Bilder mitnehmen, auf die eine Zeile wirklich verweist
  function usedImages(tl) {
    const keys = new Set();
    tl.source.replace(/\{bild:([^{}]*)\}/gi, (m, k) => { keys.add(k.trim()); return m; });
    const out = {};
    for (const k of keys) if (tl.images[k]) out[k] = tl.images[k];
    return out;
  }

  function exportTxt() {
    const t = activeTl();
    const data = `# Titel: ${displayName(t)}\n` + t.source.replace(/\n*$/, '\n');
    download(slug(t.name) + '.txt', new Blob([data], { type: 'text/plain;charset=utf-8' }));
    toast(Object.keys(usedImages(t)).length
      ? 'Textdatei gesichert. Bilder sind nur in der .json-Sicherung enthalten.'
      : 'Textdatei gesichert.');
  }

  // Eine Datei mit einem Zeitstrahl samt Bildern, lesbar über „Datei → Öffnen“
  const timelineJson = (t) => JSON.stringify({
    typ: 'zeitstrahl-sicherung',
    version: 1,
    gesichert: new Date().toISOString(),
    timelines: [{ name: t.name, source: t.source, images: usedImages(t) }],
  }, null, 1);

  function exportJson() {
    const t = activeTl();
    download(slug(t.name) + '.json', new Blob([timelineJson(t)], { type: 'application/json' }));
    toast('Zeitstrahl mit Bildern gesichert.');
  }

  // Alle Zeitstrahlen als ZIP-Datei, darin je Zeitstrahl eine eigene .json-Datei
  function exportAll() {
    const enc = new TextEncoder();
    const taken = new Set([ORDER_FILE]);
    const files = state.timelines.map((t) => {
      let name = slug(t.name) + '.json';
      for (let i = 2; taken.has(name); i++) name = `${slug(t.name)}-${i}.json`;
      taken.add(name);
      return { name, data: enc.encode(timelineJson(t)) };
    });
    // Reihenfolge der Zeitstrahlen, damit sie beim Zurückspielen gleich bleibt
    files.push({ name: ORDER_FILE, data: enc.encode(JSON.stringify({ reihenfolge: files.map((f) => f.name) })) });
    const day = new Date().toISOString().slice(0, 10);
    download(`zeitstrahl-werkstatt-sicherung-${day}.zip`, new Blob([Zip.erstellen(files)], { type: 'application/zip' }));
    markBackedUp();
    toast(state.timelines.length === 1 ? 'Der Zeitstrahl wurde als ZIP-Datei gesichert.' : `Alle ${state.timelines.length} Zeitstrahlen als ZIP-Datei gesichert.`);
  }

  // Seite im Format A4 quer für Bild und Druck (gebaut in js/layout.js)
  const pageSvg = (blank) => Layout.pageSvg(visibleItems(), view, parsed.cats, {
    title: displayName(activeTl()), blank, hidden: hiddenCats, measure, day: new Date().toLocaleDateString('de-DE'),
  });

  function exportPng(blank) {
    if (!visibleItems().length) { toast('Der Zeitstrahl hat noch keine Einträge.'); return; }
    const { markup, w, h } = pageSvg(blank);
    savePng(markup, w, h, slug(activeTl().name) + (blank ? '-lueckenbild' : ''), blank ? 'Lückenbild gesichert.' : 'Bild gesichert.');
  }

  function printTimeline(blank) {
    if (!visibleItems().length) { toast('Der Zeitstrahl hat noch keine Einträge.'); return; }
    printSvg(pageSvg(blank).markup);
  }

  /* ---------- Öffnen: Textdateien, Tabellen, Sicherungen, Schülerbeiträge ---------- */

  // Excel unter Windows speichert CSV oft nicht als UTF-8. Dann ergeben Umlaute
  // Fehlerzeichen, und die Datei wird als Windows-1252 gelesen.
  async function readText(file) {
    const buf = await file.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { text = new TextDecoder('windows-1252').decode(buf); }
    return text.replace(/^﻿/, '');
  }

  // Zeitstrahlen aus einer .json-Sicherung
  function timelinesOf(data) {
    return data.timelines.filter(isTl).map((t) => ({ name: t.name, source: t.source, images: cleanImages(t.images) }));
  }

  // ZIP-Datei von „Alle Zeitstrahlen sichern“ oder ein gepackter Ordner mit .json-Dateien
  async function readZip(file) {
    let entries;
    try { entries = await Zip.lesen(await file.arrayBuffer()); } catch (e) { throw new Error(`${file.name}: ${e.message}`); }
    const dec = new TextDecoder('utf-8');
    const base = (n) => n.split('/').pop();
    let order = [];
    const found = [];
    for (const e of entries) {
      if (!/\.json$/i.test(e.name) || base(e.name).startsWith('.')) continue;
      let data = null;
      try { data = JSON.parse(dec.decode(e.data).replace(/^\uFEFF/, '')); } catch (err) { continue; }
      if (base(e.name) === ORDER_FILE) {
        if (isObj(data) && Array.isArray(data.reihenfolge)) order = data.reihenfolge;
      } else if (isObj(data) && Array.isArray(data.timelines)) {
        found.push({ file: base(e.name), list: timelinesOf(data) });
      }
    }
    const pos = (f) => {
      const i = order.indexOf(f.file);
      return i < 0 ? Infinity : i;
    };
    found.sort((a, b) => pos(a) - pos(b));
    const list = found.flatMap((f) => f.list);
    if (!list.length) throw new Error(`${file.name} enthält keine Zeitstrahlen.`);
    return { backup: true, list };
  }

  // Liest eine Datei und liefert die enthaltenen Zeitstrahlen.
  // backup: die Datei ist eine Sicherung mehrerer Zeitstrahlen
  async function readFile(file) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (/\.zip$/i.test(file.name) || (head[0] === 0x50 && head[1] === 0x4B && head[2] === 3 && head[3] === 4)) {
      if (file.size > 400 * 1024 * 1024) throw new Error(`${file.name} ist zu groß.`);
      return readZip(file);
    }
    if (file.size > 80 * 1024 * 1024) throw new Error(`${file.name} ist zu groß.`);
    let text;
    try { text = await readText(file); } catch (e) { throw new Error(`${file.name} lässt sich nicht lesen.`); }
    const base = file.name.replace(/\.[^.]+$/, '');
    if (/\.(csv|tsv)$/i.test(file.name)) {
      const source = Parser.tableToSource(text);
      if (!source.trim()) throw new Error(`${file.name} enthält keine Zeilen.`);
      return { backup: false, list: [{ name: base || 'Tabelle', source, images: {} }] };
    }
    if (/\.json$/i.test(file.name) || /^\s*\{/.test(text)) {
      let data = null;
      try { data = JSON.parse(text); } catch (e) { /* unten gemeldet */ }
      if (isObj(data) && data.typ === 'zeitstrahl-schueler' && Array.isArray(data.eintraege)) {
        // Schüler-Zeitstrahl ohne Server: wird zu einem eigenen Zeitstrahl
        const tl = abgabeToTimeline({
          id: '', thema: str(data.thema, 140), titel: str(data.titel, 140), von: str(data.von, 120),
          eintraege: data.eintraege.filter(isObj).map((e) => ({
            datum: str(e.datum, 80), titel: str(e.titel, 200), kategorie: str(e.kategorie, 60),
            beschreibung: str(e.beschreibung, 2000), bildquelle: str(e.bildquelle, 300), bild: e.bild,
          })),
        });
        return { backup: false, list: [{ name: tl.name || 'Schüler-Zeitstrahl', source: tl.source, images: tl.images }] };
      }
      if (isObj(data) && Array.isArray(data.timelines)) {
        const list = timelinesOf(data);
        // Eine Datei mit mehreren Zeitstrahlen gilt als Sicherung
        return { backup: list.length > 1, list };
      }
      throw new Error(`${file.name} ist keine Zeitstrahl-Datei.`);
    }
    let name = base;
    let src = text.replace(/\r\n?/g, '\n');
    const m = src.match(/^#\s*Titel:\s*(.+)\n?/);
    if (m) { name = m[1].trim(); src = src.slice(m[0].length); }
    return { backup: false, list: [{ name: name || 'Geöffneter Zeitstrahl', source: src, images: {} }] };
  }

  // Fragt bei einer Sicherung, ob ihre Zeitstrahlen dazukommen oder die vorhandenen ersetzen
  function askImport(n) {
    const dlg = $('import-ask');
    $('import-ask-text').textContent = `Die Sicherung enthält ${n === 1 ? 'einen Zeitstrahl' : n + ' Zeitstrahlen'}. `
      + `Hier ${state.timelines.length === 1 ? 'ist gerade einer' : 'sind gerade ' + state.timelines.length}.`;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true }));
  }

  async function importFiles(fileList) {
    const fehler = [];
    const found = [];
    let backup = false;
    for (const file of [...fileList]) {
      try {
        const r = await readFile(file);
        found.push(...r.list);
        backup = backup || r.backup;
      } catch (e) {
        fehler.push(e.message);
      }
    }
    const fertig = (msg) => {
      const text = [msg, ...fehler].filter(Boolean).join(' ');
      if (text) toast(text);
    };
    if (!found.length) { fertig(''); return; }

    let mode = 'add';
    if (backup) {
      mode = await askImport(found.length);
      if (mode !== 'add' && mode !== 'replace') { fertig(''); return; }
    }
    if (mode === 'replace') {
      state.timelines = found.map((t) => ({ id: newId(), name: t.name, source: t.source, images: t.images }));
      await switchTo(state.timelines[0].id, true);
      fertig(found.length === 1 ? 'Sicherung geöffnet, ein Zeitstrahl.' : `Sicherung geöffnet, ${found.length} Zeitstrahlen.`);
      return;
    }
    // Gleicher Titel und gleiche Einträge: schon vorhanden, nicht doppelt anlegen
    const same = (a, b) => a.name === b.name && a.source.trim() === b.source.trim();
    let lastAdded = null;
    let added = 0;
    let skipped = null;
    for (const t of found) {
      const there = state.timelines.find((x) => same(x, t));
      if (there) { skipped = there; continue; }
      lastAdded = addTimeline(t);
      added++;
    }
    const n = found.length - added;
    const doppelt = n === 1 ? 'Einer war schon vorhanden.' : `${n} waren schon vorhanden.`;
    if (lastAdded) {
      await switchTo(lastAdded.id, true);
      fertig((added === 1 ? `„${displayName(lastAdded)}“ geöffnet.` : `${added} Zeitstrahlen geöffnet.`) + (n ? ' ' + doppelt : ''));
    } else {
      await switchTo(skipped.id);
      fertig(found.length === 1 ? `„${displayName(skipped)}“ ist schon vorhanden.` : `Alle ${found.length} Zeitstrahlen sind schon vorhanden.`);
    }
  }

  /* ---------- Farben ---------- */

  let theme = 'system';
  function applyTheme(t, save) {
    theme = setTheme(t);
    document.querySelectorAll('.theme-btn').forEach((b) => {
      // Der Knopf in der Kopfleiste zeigt nur ein Symbol, der Name steht im Tooltip
      if (b.classList.contains('theme-icon')) labelThemeIcon(b, theme);
      else b.textContent = THEMES[theme];
    });
    if (save) { try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* egal */ } }
    requestRender();
  }

  /* ---------- Ereignisse verdrahten ---------- */

  function wire() {
    // Zeitstrahl-Auswahl und Editor
    $('tl-select').addEventListener('change', (e) => switchTo(e.target.value));
    $('tl-name').addEventListener('input', () => {
      if (studentView) return;
      ownTl().name = $('tl-name').value;
      renderHeading();
      const opt = $('tl-select').selectedOptions[0];
      if (opt) opt.textContent = displayName(ownTl());
      changed();
    });
    let parseTimer = 0;
    $('tl-source').addEventListener('input', () => {
      if (studentView) return;
      ownTl().source = $('tl-source').value;
      changed();
      clearTimeout(parseTimer);
      parseTimer = setTimeout(() => {
        const hadItems = parsed.items.length > 0;
        reparse();
        keepSelection();
        refreshLists();
        if (!hadItems && parsed.items.length) refit(false);
        else requestRender();
      }, 180);
    });

    $('btn-new').addEventListener('click', () => {
      const t = addTimeline({ name: NEW_NAME, source: NEW_SOURCE, images: {} });
      switchTo(t.id, true);
      $('tl-name').focus();
      $('tl-name').select();
    });
    $('btn-dup').addEventListener('click', () => {
      const s = activeTl();
      const t = addTimeline({ name: displayName(s) + ' (Kopie)', source: s.source, images: clone(s.images) });
      switchTo(t.id, true);
      toast('Kopie angelegt.');
    });
    $('btn-del').addEventListener('click', () => {
      const b = $('btn-del');
      if (state.timelines.length < 2) return;
      if (!delArmed) {
        b.textContent = 'Wirklich löschen?';
        b.classList.add('armed');
        delArmed = setTimeout(disarmDelete, 4000);
        return;
      }
      disarmDelete();
      const idx = state.timelines.findIndex((t) => t.id === state.activeId);
      const [gone] = state.timelines.splice(idx, 1);
      switchTo(state.timelines[Math.max(0, idx - 1)].id, true);
      toast(`„${displayName(gone)}“ gelöscht.`);
    });

    // Zoom
    $('zoom-in').addEventListener('click', () => zoomAt(0.7, stage.clientWidth / 2));
    $('zoom-out').addEventListener('click', () => zoomAt(1 / 0.7, stage.clientWidth / 2));
    $('zoom-fit').addEventListener('click', () => refit(true));

    // Ziehen, Tippen, Zwei-Finger-Zoom
    const ptrs = new Map();
    let drag = null;
    let pinch = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      cancelAnimationFrame(anim);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
      if (ptrs.size === 1) {
        drag = { x: e.clientX, y: e.clientY, view: { ...view }, scrollTop: stage.scrollTop, moved: false, target: e.target, mouse: e.pointerType === 'mouse' };
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const rect = stage.getBoundingClientRect();
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2 - rect.left, view: { ...view } };
        if (drag) drag.moved = true;
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const W = stage.clientWidth || 1;
      if (pinch && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const rect = stage.getBoundingClientRect();
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const cx = (a.x + b.x) / 2 - rect.left;
        const sp0 = pinch.view.v1 - pinch.view.v0;
        const t = pinch.view.v0 + (pinch.cx / W) * sp0;
        const ns = Math.min(MAX_SPAN, Math.max(MIN_SPAN, (sp0 * pinch.d) / d));
        const v0 = t - (cx / W) * ns;
        view = clampView({ v0, v1: v0 + ns });
        userMovedView = true;
        requestRender();
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) {
        drag.moved = true;
        stage.classList.add('dragging');
      }
      if (drag.moved) {
        const sp = drag.view.v1 - drag.view.v0;
        const dt = (-dx / W) * sp;
        view = clampView({ v0: drag.view.v0 + dt, v1: drag.view.v1 + dt });
        if (drag.mouse) stage.scrollTop = drag.scrollTop - dy;
        userMovedView = true;
        requestRender();
      }
    });
    const endPointer = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (ptrs.size === 0) {
        if (drag && !drag.moved && e.type === 'pointerup') {
          const hit = drag.target && drag.target.closest ? drag.target.closest('[data-id]') : null;
          select(hit ? hit.getAttribute('data-id') : null);
        }
        drag = null;
        stage.classList.remove('dragging');
      } else if (ptrs.size === 1) {
        const [p] = [...ptrs.values()];
        drag = { x: p.x, y: p.y, view: { ...view }, scrollTop: stage.scrollTop, moved: true, target: null, mouse: false };
      }
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);

    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      cancelAnimationFrame(anim);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        panPx((e.shiftKey ? e.deltaY || e.deltaX : e.deltaX) * unit);
      } else {
        const x = e.clientX - stage.getBoundingClientRect().left;
        zoomAt(Math.exp(e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015)), x);
      }
    }, { passive: false });

    stage.addEventListener('keydown', (e) => {
      const W = stage.clientWidth;
      const item = e.target.closest && e.target.closest('[data-id]');
      if (item && (e.key === 'Enter' || e.key === ' ') && !(present && reveal.on)) {
        e.preventDefault();
        select(item.getAttribute('data-id'));
        return;
      }
      if (present && reveal.on) return; // Tasten gehören dann dem Aufdecken
      if (e.key === 'ArrowLeft') { e.preventDefault(); panPx(-W * 0.15); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); panPx(W * 0.15); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(0.75, W / 2); }
      else if (e.key === '-' || e.key === '−') { e.preventDefault(); zoomAt(1 / 0.75, W / 2); }
      else if (e.key === '0' || e.key === 'Home') { e.preventDefault(); refit(true); }
    });

    const ro = new ResizeObserver(() => {
      if (!userMovedView) view = fitView();
      requestRender();
    });
    ro.observe(stage);

    // Details
    $('detail-close').addEventListener('click', () => select(null));
    $('detail-edit').addEventListener('click', () => {
      const it = currentItem();
      if (it) gotoLine(it.line);
    });
    $('detail-img-add').addEventListener('click', () => $('img-input').click());
    $('img-input').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      const it = currentItem();
      if (!file || !it) return;
      try {
        const data = await Bild.verkleinern(file);
        const tl = activeTl();
        const key = it.img && tl.images[it.img] ? it.img : Bild.neuerSchluessel(tl.images);
        tl.images[key] = data;
        if (it.img !== key) setLineMeta(it.line, 'bild', key);
        afterSourceChange();
        toast('Bild hinzugefügt.');
      } catch (err) {
        toast(err.message);
      }
    });
    $('detail-img-del').addEventListener('click', () => {
      const it = currentItem();
      if (!it || !it.img) return;
      delete activeTl().images[it.img];
      setLineMeta(it.line, 'bild', null);
      afterSourceChange();
      toast('Bild entfernt.');
    });

    // Tafelbild
    $('btn-present').addEventListener('click', () => setPresent(true));
    $('present-exit').addEventListener('click', () => setPresent(false));
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && fsByUs && present) {
        fsByUs = false;
        setPresent(false);
      }
    });
    $('reveal-toggle').addEventListener('click', () => {
      reveal.on = !reveal.on;
      reveal.n = 0;
      selectedId = null;
      selectedTitle = null;
      renderDetail();
      renderReveal();
      refit(false);
      stage.focus({ preventScroll: true });
    });
    $('reveal-prev').addEventListener('click', () => stepReveal(-1));
    $('reveal-next').addEventListener('click', () => stepReveal(1));

    // Farben
    document.querySelectorAll('.theme-btn').forEach((b) => b.addEventListener('click', () => {
      applyTheme(shownTheme(theme) === 'dark' ? 'light' : 'dark', true);
    }));

    // Menüs „Datei“ und „Arbeitsblatt“
    const menus = [...document.querySelectorAll('.menu')].map((box) => ({
      btn: box.querySelector('[aria-haspopup="menu"]'),
      list: box.querySelector('.menu-list'),
    }));
    const setMenu = (m, open) => {
      m.list.hidden = !open;
      m.btn.setAttribute('aria-expanded', String(open));
      if (open) m.list.querySelector('button').focus();
    };
    menus.forEach((m) => {
      m.btn.addEventListener('click', () => {
        const open = m.list.hidden;
        menus.forEach((o) => { if (o !== m) setMenu(o, false); });
        setMenu(m, open);
      });
      m.list.addEventListener('keydown', (e) => {
        const items = [...m.list.querySelectorAll('button:not([hidden])')];
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { setMenu(m, false); m.btn.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      });
      m.list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        setMenu(m, false);
        const act = b.dataset.act;
        if (act === 'import') $('file-input').click();
        else if (act === 'export-txt') exportTxt();
        else if (act === 'export-json') exportJson();
        else if (act === 'export-backup') exportAll();
        else if (act === 'export-png') exportPng(false);
        else if (act === 'export-png-blank') exportPng(true);
        else if (act === 'print') printTimeline(false);
        else if (act === 'print-blank') printTimeline(true);
        else if (act === 'open-sample') openSamples();
      });
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu')) menus.forEach((m) => { if (!m.list.hidden) setMenu(m, false); });
    });
    $('empty-sample').addEventListener('click', openSamples);
    $('samples-close').addEventListener('click', () => $('samples').close());
    $('backup-due').addEventListener('click', exportAll);
    $('file-input').addEventListener('change', (e) => {
      const files = e.target.files;
      if (files && files.length) importFiles(files).finally(() => { e.target.value = ''; });
    });

    // Dateien auf die Seite ziehen
    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
    });
    document.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      importFiles(e.dataTransfer.files);
    });

    // Klassenserver
    $('btn-abgaben').addEventListener('click', () => {
      if (server.offline) {
        toast('Der Server antwortet nicht. Läuft das Server-Fenster noch?');
        return;
      }
      loadTask().then(renderTaskState);
      renderAbgabenList();
      $('abgaben').showModal();
    });
    $('abgaben-close').addEventListener('click', () => $('abgaben').close());
    document.querySelectorAll('.connect-btn').forEach((b) => b.addEventListener('click', openConnect));
    $('connect-close').addEventListener('click', () => $('connect').close());
    $('connect-zugang').addEventListener('click', () => { $('connect').close(); openZugang(); });
    $('task-form').addEventListener('submit', saveTask);
    $('task-kat-uebernehmen').addEventListener('click', takeOwnKategorien);
    $('task-freigabe').addEventListener('change', saveFreigabe);
    $('btn-sperre').addEventListener('click', toggleSperre);
    $('zugang-close').addEventListener('click', () => $('zugang').close());
    $('btn-logout').addEventListener('click', logout);
    $('sp-copy').addEventListener('click', copyStudentView);
    $('sp-del').addEventListener('click', deleteStudentView);
    $('btn-sort').addEventListener('click', openSort);
    $('sort-close').addEventListener('click', () => $('sort').close());
    $('sort-check').addEventListener('click', checkSort);
    $('sort-solve').addEventListener('click', solveSort);
    $('sort-new').addEventListener('click', openSort);
    $('tl-prev').addEventListener('click', () => stepTimeline(-1));
    $('tl-next').addEventListener('click', () => stepTimeline(1));

    // Tastatur allgemein
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        persistNow();
        toast(REMOTE ? 'Wird auf dem Laptop gespeichert.'
          : server.on ? 'Gespeichert, auch auf dem Laptop im Ordner daten.'
          : 'In diesem Browser gespeichert. Als Sicherung: Datei → Alle Zeitstrahlen sichern.');
        return;
      }
      if ($('abgaben').open || $('connect').open || $('zugang').open || $('import-ask').open || $('sort').open) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
      if (present) {
        if (e.key === 'Escape') { setPresent(false); return; }
        if (reveal.on && tag !== 'button') {
          if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); stepReveal(1); return; }
          if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); stepReveal(-1); return; }
        } else if (tag !== 'button') {
          // Ohne Aufdecken blättert der Presenter (Bild auf/ab) durch die Zeitstrahlen
          if (e.key === 'PageDown') { e.preventDefault(); stepTimeline(1); return; }
          if (e.key === 'PageUp') { e.preventDefault(); stepTimeline(-1); return; }
        }
      } else if (e.key === 'Escape' && selectedId) {
        select(null);
      }
    });

    window.addEventListener('pagehide', () => { if (saveTimer) persistNow(); });

    if (document.fonts) {
      const onFonts = () => {
        clearMeasure();
        if (!userMovedView) view = fitView();
        requestRender();
      };
      document.fonts.addEventListener('loadingdone', onFonts);
      document.fonts.ready.then(onFonts);
    }
  }

  /* ---------- Start ---------- */

  async function start() {
    let savedTheme = 'system';
    try { savedTheme = localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { /* egal */ }
    applyTheme(savedTheme, false);

    await detectServer();
    state = await loadState();
    reparse();
    loadEditor();
    renderPicker();
    renderHeading();
    refreshLists();
    wire();
    view = fitView();
    render();
    showStatus(false);
    renderStudentPanel();
    renderTlNav();
    if (server.on) {
      renderServerUi();
      loadTask().then(applyTask);
      pollAbgaben();
      setInterval(pollAbgaben, 5000);
    }
    const days = showBackupDue();
    if (days) toast(`Seit ${days} Tagen keine Sicherung als Datei. Oben auf „Jetzt sichern“ klicken.`);
  }

  start();
})();
