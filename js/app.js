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
  const SAMPLES = window.ZeitstrahlBeispiele || [];

  const DB_NAME = 'zeitstrahl-werkstatt';
  const DB_STORE = 'daten';
  const DB_KEY = 'zustand';
  const LS_KEY = 'zeitstrahl-werkstatt-v1';
  const THEME_KEY = 'zeitstrahl-werkstatt-farben';

  const FAM_SCREEN = '"Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif';
  const FAM_EXPORT = 'Arial, Helvetica, sans-serif';
  const PRESENT_SCALE = 1.4;
  const MIN_SPAN = 0.25;
  const MAX_SPAN = 40000;
  const LIMIT_LO = -30000;
  const LIMIT_HI = 6000;
  const CAT_LIGHT = ['#B23A30', '#6A47A6', '#9A6608', '#2760A8', '#86552A', '#A3356E', '#157A80', '#6B7671'];
  const NOW = new Date();
  const TODAY_POS = Parser.toPos({ y: NOW.getFullYear(), m: NOW.getMonth() + 1, d: NOW.getDate(), bc: false });

  const SCREEN_PAINT = {
    ink: 'var(--ink)', soft: 'var(--ink-soft)', grid: 'var(--grid)', sheet: 'var(--sheet)', accent: 'var(--board)',
    cat: (i) => `var(--cat-${i})`,
  };
  const EXPORT_PAINT = {
    ink: '#1C2420', soft: '#56635D', grid: '#E3E8E5', sheet: '#FFFFFF', accent: '#2C5A4B',
    cat: (i) => CAT_LIGHT[i - 1],
  };

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const isTl = (t) => isObj(t) && typeof t.name === 'string' && typeof t.source === 'string';
  const validImage = (s) => typeof s === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(s);
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* ---------- Textbreiten messen ---------- */

  const mctx = document.createElement('canvas').getContext('2d');
  const mcache = new Map();
  function measure(text, weight, size, fam) {
    const key = weight + '|' + size.toFixed(2) + '|' + fam + '|' + text;
    let w = mcache.get(key);
    if (w === undefined) {
      mctx.font = `${weight} ${size.toFixed(2)}px ${fam}`;
      w = mctx.measureText(text).width;
      if (mcache.size > 5000) mcache.clear();
      mcache.set(key, w);
    }
    return w;
  }

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
  function freshState() {
    const timelines = SAMPLES.map((t) => ({ id: t.id, name: t.name, source: t.source, images: {} }));
    if (!timelines.length) timelines.push({ id: newId(), name: 'Neuer Zeitstrahl', source: '', images: {} });
    return { activeId: timelines[0].id, timelines };
  }
  async function loadState() {
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
    if (server.on) {
      try {
        const res = await fetch('api/sicherung', { headers: API_HEADERS, cache: 'no-store' });
        const d = res.ok ? normalize(await res.json()) : null;
        if (d) return d;
      } catch (e) { /* keine Sicherung */ }
    }
    return freshState();
  }

  let storageOk = true;
  let saveTimer = 0;
  async function persistNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const snapshot = { activeId: state.activeId, timelines: state.timelines };
    let ok = false;
    if (idbOk) {
      try { await dbPut(DB_KEY, snapshot); ok = true; } catch (e) { idbOk = false; }
    }
    if (!ok) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); ok = true; } catch (e) { ok = false; }
    }
    storageOk = ok;
    showStatus(false);
    scheduleBackup();
  }
  function changed() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 400);
    showStatus(true);
  }
  function showStatus(pending) {
    const el = $('save-status');
    if (!storageOk) {
      el.textContent = 'Speichern im Browser klappt nicht. Bitte über „Datei“ sichern.';
      el.dataset.tone = 'warn';
      return;
    }
    el.textContent = pending ? 'Wird gespeichert …' : 'In diesem Browser gespeichert';
    el.dataset.tone = pending ? 'pending' : 'ok';
  }

  /* ---------- Klassenserver (wenn die Seite über server.js läuft) ---------- */

  const API_HEADERS = { 'X-Zeitstrahl': 'lehrkraft' };
  const server = { on: false, info: null, offline: false, ready: false, abgaben: [], known: new Map(), task: { thema: '', auftrag: '' } };

  async function api(pathname, opts = {}) {
    const headers = { ...API_HEADERS, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) };
    const res = await fetch(pathname, { cache: 'no-store', ...opts, headers });
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

  const signature = (list) => JSON.stringify(list.map((a) => [a.id, a.titel, a.von, a.status, a.anzahl, a.aktualisiert]));

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
      if (listChanged) {
        renderPicker();
        renderAbgabenList();
        renderTlNav();
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
    const b = $('btn-abgaben');
    const n = server.abgaben.length;
    b.hidden = !server.on;
    b.textContent = server.offline ? 'Server nicht erreichbar' : n ? `Schüler-Zeitstrahlen (${n})` : 'Schüler-Zeitstrahlen';
    document.querySelectorAll('.connect-btn').forEach((c) => { c.hidden = !server.on; });
    $('link-student').hidden = server.on;
  }

  // Übersicht für die Lehrkraft, mit Code für den Fall, dass eine Gruppe ihn vergessen hat
  function renderAbgabenList() {
    const box = $('abgaben-list');
    box.textContent = '';
    if (!server.abgaben.length) {
      const p = document.createElement('p');
      p.className = 'empty-list';
      p.textContent = 'Noch keine Schüler-Zeitstrahlen. Über „iPads verbinden“ kommt die Klasse auf die Schülerseite.';
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
        li.append(chip, text, btn);
        ul.append(li);
      }
      box.append(h, ul);
    }
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
    if (!sv) return;
    const m = sv.meta;
    $('sp-title').textContent = m.titel || m.thema;
    $('sp-meta').textContent = [
      `von ${m.von}`,
      `Thema: ${m.thema}`,
      `${m.anzahl} ${m.anzahl === 1 ? 'Ereignis' : 'Ereignisse'}`,
      `${m.status === 'abgegeben' ? 'abgegeben' : 'in Arbeit, gespeichert'} ${fmtWhen(m.aktualisiert)}`,
      `Code ${m.code}`,
    ].join(' · ');
  }

  function copyStudentView() {
    const sv = studentView;
    if (!sv) return;
    const t = addTimeline({ name: sv.name, source: sv.source, images: clone(sv.images) });
    switchTo(t.id);
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
  function scheduleBackup() {
    if (!server.on) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(async () => {
      try {
        await fetch('api/sicherung', {
          method: 'PUT',
          headers: { ...API_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: 'zeitstrahl-werkstatt', gesichert: new Date().toISOString(), activeId: state.activeId, timelines: state.timelines }),
        });
      } catch (e) { /* nächster Versuch beim nächsten Speichern */ }
    }, 3000);
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

  async function loadTask() {
    try {
      server.task = await api('api/aufgabe');
    } catch (e) { /* bleibt leer */ }
  }

  function renderTaskState() {
    const t = server.task.thema;
    $('task-state').textContent = t
      ? `Die iPads zeigen jetzt das Thema „${t}“.`
      : 'Noch kein Thema festgelegt. Ohne Thema wählen die Schüler selbst eins.';
    $('connect-thema').textContent = t || 'frei wählbar';
  }

  async function saveTask(ev) {
    ev.preventDefault();
    try {
      server.task = await api('api/aufgabe', {
        method: 'PUT',
        body: JSON.stringify({ thema: $('task-thema').value.trim(), auftrag: $('task-auftrag').value.trim() }),
      });
      renderTaskState();
      toast(server.task.thema ? `Thema „${server.task.thema}“ festgelegt.` : 'Thema zurückgesetzt.');
    } catch (e) {
      toast(e.message);
    }
  }

  async function openConnect() {
    await detectServer(); // Adressen neu abfragen, falls das WLAN gewechselt hat
    await loadTask();
    const ips = (server.info && server.info.adressen) || [];
    const port = server.info ? server.info.port : 8080;
    $('task-thema').value = server.task.thema || displayName(ownTl()).replace(/\s*\(Beispiel\)\s*$/, '');
    $('task-auftrag').value = server.task.auftrag || '';
    renderTaskState();
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

  function reparse() {
    parsed = Parser.parseSource(activeTl().source, NOW);
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
    const g = Layout.layout(shownItems(), view, W, { scale: present ? PRESENT_SCALE : 1, family: FAM_SCREEN, measure, blank: false });
    const H = Math.max(Math.ceil(g.H), Math.floor(stage.clientHeight));
    const offY = Math.max(0, (H - g.H) / 2);
    const active = document.activeElement;
    const focusId = active && active !== stage && stage.contains(active) ? active.getAttribute('data-id') : null;
    stage.innerHTML = `<svg class="tl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="${Layout.esc(displayName(activeTl()))}">`
      + `<g transform="translate(0 ${offY.toFixed(1)})">${Layout.svgBody(g, SCREEN_PAINT, { selectedId, interactive: true, todayPos: TODAY_POS })}</g></svg>`;
    if (focusId) {
      const el = stage.querySelector(`[data-id="${focusId}"]`);
      if (el) el.focus({ preventScroll: true });
    }
    $('empty').hidden = parsed.items.length > 0;
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
    $('tl-heading').textContent = displayName(activeTl());
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

  async function switchTo(id) {
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
      changed();
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

  function slug(name) {
    const s = (name || '').toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return s || 'zeitstrahl';
  }

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

  function exportJson(all) {
    const list = all ? state.timelines : [activeTl()];
    const data = {
      typ: 'zeitstrahl-sicherung',
      version: 1,
      gesichert: new Date().toISOString(),
      timelines: list.map((t) => ({ name: t.name, source: t.source, images: usedImages(t) })),
    };
    const name = all ? 'zeitstrahl-werkstatt-sicherung' : slug(activeTl().name);
    download(name + '.json', new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    toast(all ? 'Alle Zeitstrahlen gesichert.' : 'Zeitstrahl mit Bildern gesichert.');
  }

  function exportSvg(blank) {
    const items = visibleItems();
    const W = 1600;
    const pad = 28;
    const s = 1.1;
    const g = Layout.layout(items, view, W - pad * 2, { scale: s, family: FAM_EXPORT, measure, blank });
    const headH = 70;
    const P = EXPORT_PAINT;
    let lx = pad;
    let ly = headH + g.H + 26;
    const legend = [];
    for (const c of parsed.cats) {
      if (hiddenCats.has(c.key)) continue;
      const tw = measure(c.name, 400, 15, FAM_EXPORT);
      if (lx + 22 + tw > W - pad) { lx = pad; ly += 26; }
      legend.push(`<rect x="${lx}" y="${ly - 11}" width="13" height="13" rx="2" style="fill:${P.cat(c.ci)}"/>`
        + `<text x="${lx + 20}" y="${ly}" style="font-size:15px;fill:${P.soft}">${Layout.esc(c.name)}</text>`);
      lx += 20 + tw + 26;
    }
    const H = Math.ceil(ly + 22);
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}" style="font-family:${FAM_EXPORT}">`
      + `<rect width="${W}" height="${H}" style="fill:#FFFFFF"/>`
      + `<text x="${pad}" y="44" style="font-size:28px;font-weight:700;fill:${P.ink}">${Layout.esc(displayName(activeTl()))}</text>`
      + (blank ? `<text x="${W - pad}" y="44" text-anchor="end" style="font-size:16px;fill:${P.soft}">Name: ______________________</text>` : '')
      + `<g transform="translate(${pad} ${headH})">${Layout.svgBody(g, P, { selectedId: null, interactive: false, blank })}</g>`
      + legend.join('')
      + '</svg>';
    return { markup, w: W * 2, h: H * 2 };
  }

  function exportPng(blank) {
    if (!visibleItems().length) { toast('Der Zeitstrahl hat noch keine Einträge.'); return; }
    const { markup, w, h } = exportSvg(blank);
    const name = slug(activeTl().name) + (blank ? '-lueckenbild' : '');
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      try {
        c.toBlob((blob) => {
          if (blob) {
            download(name + '.png', blob);
            toast(blank ? 'Lückenbild gesichert.' : 'Bild gesichert.');
          } else {
            download(name + '.svg', new Blob([markup], { type: 'image/svg+xml' }));
          }
        }, 'image/png');
      } catch (e) {
        // Manche Browser sperren das Umwandeln: dann als SVG sichern (lässt sich ebenso drucken)
        download(name + '.svg', new Blob([markup], { type: 'image/svg+xml' }));
        toast('Als SVG-Bild gesichert.');
      }
    };
    img.onerror = () => toast('Das Bild konnte nicht erzeugt werden.');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  }

  /* ---------- Öffnen: Textdateien, Sicherungen, Schülerbeiträge ---------- */

  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max || 2000) : '');

  async function importFiles(fileList) {
    const fehler = [];
    let lastAdded = null;
    let added = 0;
    for (const file of [...fileList]) {
      if (file.size > 80 * 1024 * 1024) { fehler.push(`${file.name} ist zu groß.`); continue; }
      let text;
      try { text = (await file.text()).replace(/^﻿/, ''); } catch (e) { fehler.push(`${file.name} lässt sich nicht lesen.`); continue; }
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
          lastAdded = addTimeline({ name: tl.name || 'Schüler-Zeitstrahl', source: tl.source, images: tl.images });
          added++;
        } else if (isObj(data) && Array.isArray(data.timelines)) {
          for (const t of data.timelines) {
            if (!isTl(t)) continue;
            lastAdded = addTimeline({ name: t.name, source: t.source, images: cleanImages(t.images) });
            added++;
          }
        } else {
          fehler.push(`${file.name} ist keine Zeitstrahl-Datei.`);
        }
      } else {
        let name = file.name.replace(/\.[^.]+$/, '');
        let src = text.replace(/\r\n?/g, '\n');
        const m = src.match(/^#\s*Titel:\s*(.+)\n?/);
        if (m) { name = m[1].trim(); src = src.slice(m[0].length); }
        lastAdded = addTimeline({ name: name || 'Geöffneter Zeitstrahl', source: src, images: {} });
        added++;
      }
    }
    if (lastAdded) {
      switchTo(lastAdded.id);
      toast(added === 1 ? `„${displayName(lastAdded)}“ geöffnet.` : `${added} Zeitstrahlen geöffnet.`);
    }
    if (fehler.length) toast(fehler.join(' '));
  }

  /* ---------- Farben ---------- */

  const THEMES = { system: 'Farben: automatisch', light: 'Farben: hell', dark: 'Farben: Tafel' };
  let theme = 'system';
  function applyTheme(t, save) {
    theme = THEMES[t] ? t : 'system';
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-btn').forEach((b) => { b.textContent = THEMES[theme]; });
    if (save) { try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* egal */ } }
    requestRender();
  }

  /* ---------- Hinweise ---------- */

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
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
      const t = addTimeline({ name: 'Neuer Zeitstrahl', source: '# Datum | Titel | Kategorie | Beschreibung\n', images: {} });
      switchTo(t.id);
      $('tl-name').focus();
      $('tl-name').select();
    });
    $('btn-dup').addEventListener('click', () => {
      const s = activeTl();
      const t = addTimeline({ name: displayName(s) + ' (Kopie)', source: s.source, images: clone(s.images) });
      switchTo(t.id);
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
      switchTo(state.timelines[Math.max(0, idx - 1)].id);
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
      applyTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system', true);
    }));

    // Datei-Menü
    const fileBtn = $('btn-file');
    const menu = $('file-menu');
    const setMenu = (open) => {
      menu.hidden = !open;
      fileBtn.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('button').focus();
    };
    fileBtn.addEventListener('click', () => setMenu(menu.hidden));
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !e.target.closest('.menu')) setMenu(false);
    });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { setMenu(false); fileBtn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      setMenu(false);
      const act = b.dataset.act;
      if (act === 'import') $('file-input').click();
      else if (act === 'export-txt') exportTxt();
      else if (act === 'export-json') exportJson(false);
      else if (act === 'export-backup') exportJson(true);
      else if (act === 'export-png') exportPng(false);
      else if (act === 'export-png-blank') exportPng(true);
      else if (act === 'add-samples') {
        let last = null;
        for (const s of SAMPLES) last = addTimeline({ name: s.name, source: s.source, images: {} });
        if (last) { switchTo(last.id); toast('Beispiele hinzugefügt.'); }
      }
    });
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
        toast('Der Server antwortet nicht. Läuft das Fenster „Server starten“ noch?');
        return;
      }
      renderAbgabenList();
      $('abgaben').showModal();
    });
    $('abgaben-close').addEventListener('click', () => $('abgaben').close());
    document.querySelectorAll('.connect-btn').forEach((b) => b.addEventListener('click', openConnect));
    $('connect-close').addEventListener('click', () => $('connect').close());
    $('task-form').addEventListener('submit', saveTask);
    $('sp-copy').addEventListener('click', copyStudentView);
    $('sp-del').addEventListener('click', deleteStudentView);
    $('tl-prev').addEventListener('click', () => stepTimeline(-1));
    $('tl-next').addEventListener('click', () => stepTimeline(1));

    // Tastatur allgemein
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        persistNow();
        toast('In diesem Browser gespeichert. Zum Weitergeben: Datei → Als Textdatei sichern.');
        return;
      }
      if ($('abgaben').open || $('connect').open) return;
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
        mcache.clear();
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
      loadTask();
      pollAbgaben();
      setInterval(pollAbgaben, 5000);
      scheduleBackup();
    }
  }

  start();
})();
