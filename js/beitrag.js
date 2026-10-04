/*
 * Zeitstrahl-Werkstatt · Schülerseite
 *
 * Schülerinnen und Schüler bauen zum Thema der Lehrkraft einen eigenen Zeitstrahl.
 * Über den Klassenserver speichern sie ihn auf dem Laptop der Lehrkraft und erhalten
 * einen Code, mit dem sie später weiterarbeiten. Ist er fertig, geben sie ihn ab.
 * Ohne Server (Datei per Doppelklick geöffnet) lässt er sich als Datei speichern.
 */
(() => {
  'use strict';

  const Parser = window.ZeitstrahlParser;
  const Layout = window.ZeitstrahlLayout;
  const Bild = window.ZeitstrahlBild;

  const DRAFT_KEY = 'zeitstrahl-schueler-v2';
  const THEME_KEY = 'zeitstrahl-werkstatt-farben';
  const AUTOSAVE_MS = 15000;
  const NOW = new Date();
  const FAM = '"Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif';
  const PAINT = {
    ink: 'var(--ink)', soft: 'var(--ink-soft)', grid: 'var(--grid)', sheet: 'var(--sheet)', accent: 'var(--board)',
    cat: (i) => `var(--cat-${i})`,
  };

  const $ = (id) => document.getElementById(id);
  const val = (id) => $(id).value.trim();

  // Der eigene Zeitstrahl. id und code vergibt der Server beim ersten Speichern.
  const emptyWork = () => ({ id: '', code: '', thema: '', titel: '', von: '', status: '', saved: '', rev: 0, savedRev: 0, entries: [] });
  let work = emptyWork();
  let task = { thema: '', auftrag: '' };
  let serverMode = false;
  let busy = false;
  let editIndex = -1;
  let bildData = '';
  let autoTimer = 0;
  let localWarned = false;

  const dirty = () => work.rev !== work.savedRev;

  // Farbwahl der Lehrkraft-Ansicht übernehmen, falls auf demselben Gerät gesetzt
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* egal */ }

  /* ---------- Auf diesem Gerät zwischenspeichern ---------- */

  function saveLocal() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(work));
    } catch (e) {
      if (!localWarned) {
        localWarned = true;
        toast('Der Speicher dieses Geräts ist voll. Bitte bald speichern.');
      }
    }
  }

  function loadLocal() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (d && Array.isArray(d.entries)) {
        work = Object.assign(emptyWork(), d, {
          entries: d.entries.filter((e) => e && typeof e.titel === 'string' && typeof e.datum === 'string'),
        });
      }
    } catch (e) { /* kein Entwurf */ }
  }

  // Nach jeder Änderung: merken, anzeigen, später automatisch speichern
  function touch() {
    work.rev++;
    saveLocal();
    renderStatus();
    scheduleAutosave();
  }

  /* ---------- Kopf: Thema und Arbeitsauftrag ---------- */

  function renderHead() {
    // Auf dem Server legt die Lehrkraft das Thema fest; ein gespeicherter Zeitstrahl behält seins
    const fixed = serverMode ? (work.id ? work.thema : task.thema) : '';
    const shown = fixed || work.thema;
    $('topic-title').textContent = shown || 'Mein Zeitstrahl';
    $('topic-label').hidden = !shown;
    $('thema-field').hidden = !!fixed;
    const sameTopic = !work.id || work.thema === task.thema;
    $('task-text').textContent = task.auftrag;
    $('task-text').hidden = !(serverMode && task.auftrag && sameTopic);
    const hint = serverMode && work.id && task.thema && work.thema !== task.thema;
    $('topic-hint').textContent = hint ? `Eure Lehrkraft hat ein neues Thema vorgegeben: „${task.thema}“. Dafür unten „Neuen Zeitstrahl beginnen“ antippen.` : '';
    $('topic-hint').hidden = !hint;
    document.title = shown ? `${shown} · Mein Zeitstrahl` : 'Mein Zeitstrahl';
  }

  function fillGroup() {
    $('f-von').value = work.von;
    $('f-titel').value = work.titel;
    $('f-thema').value = work.thema;
  }

  /* ---------- Formular für ein Ereignis ---------- */

  function dateInfo(text) {
    const r = Parser.parseDateField(text, NOW);
    if (r.error) return { ok: false, text: r.error };
    const when = r.kind === 'point' ? Parser.fmtLong(r.a) : `${Parser.fmtLong(r.a)} bis ${Parser.fmtLong(r.b)}`;
    return { ok: true, text: when, ago: Parser.agoText({ kind: r.kind, a: r.a, b: r.b }, NOW) };
  }

  function checkDate() {
    const el = $('f-datum-check');
    const v = val('f-datum');
    if (!v) { el.textContent = ''; el.dataset.tone = ''; return; }
    const info = dateInfo(v);
    el.textContent = info.ok ? `Erkannt: ${info.text} · ${info.ago}` : info.text;
    el.dataset.tone = info.ok ? 'ok' : 'warn';
  }

  function updateCounter() {
    $('f-text-count').textContent = `${$('f-text').value.length} / 600`;
  }

  function showImage(data) {
    bildData = data;
    const img = $('f-bild-preview');
    if (data) {
      img.src = data;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      $('f-bild').value = '';
    }
    $('f-bild-del').hidden = !data;
    $('quelle-field').hidden = !data;
  }

  function resetForm() {
    for (const id of ['f-datum', 'f-ereignis', 'f-kategorie', 'f-text', 'f-quelle']) $(id).value = '';
    showImage('');
    $('f-bild-check').textContent = '';
    $('form-msg').textContent = '';
    editIndex = -1;
    $('form-title').textContent = 'Neues Ereignis';
    $('f-submit').textContent = 'Zum Zeitstrahl hinzufügen';
    $('f-cancel').hidden = true;
    checkDate();
    updateCounter();
  }

  function fillForm(i) {
    const e = work.entries[i];
    if (!e) return;
    $('f-datum').value = e.datum;
    $('f-ereignis').value = e.titel;
    $('f-kategorie').value = e.kategorie || '';
    $('f-text').value = e.beschreibung || '';
    $('f-quelle').value = e.quelle || '';
    showImage(e.bild || '');
    editIndex = i;
    $('form-title').textContent = 'Ereignis bearbeiten';
    $('f-submit').textContent = 'Änderungen übernehmen';
    $('f-cancel').hidden = false;
    $('form-msg').textContent = '';
    checkDate();
    updateCounter();
    renderPreview();
    $('entry-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('f-datum').focus({ preventScroll: true });
  }

  function fail(id, msg) {
    $('form-msg').textContent = msg;
    $(id).focus();
  }

  function submitForm(ev) {
    ev.preventDefault();
    const datum = val('f-datum');
    const titel = val('f-ereignis');
    if (!datum) return fail('f-datum', 'Bitte ein Datum eintragen.');
    const info = dateInfo(datum);
    if (!info.ok) return fail('f-datum', info.text);
    if (!titel) return fail('f-ereignis', 'Bitte das Ereignis benennen.');
    if (bildData && !val('f-quelle')) return fail('f-quelle', 'Bitte angeben, woher das Bild stammt.');
    const e = {
      datum,
      titel,
      kategorie: val('f-kategorie'),
      beschreibung: val('f-text'),
      bild: bildData,
      quelle: bildData ? val('f-quelle') : '',
    };
    const wasEdit = editIndex >= 0;
    if (wasEdit) work.entries[editIndex] = e;
    else work.entries.push(e);
    resetForm();
    touch();
    renderList();
    toast(wasEdit ? 'Änderungen übernommen.' : `„${e.titel}“ steht jetzt auf eurem Zeitstrahl.`);
    $('f-datum').focus({ preventScroll: true });
  }

  /* ---------- Liste und Vorschau ---------- */

  function renderList() {
    const ul = $('entries');
    ul.textContent = '';
    // Liste in zeitlicher Reihenfolge, Index bleibt der in work.entries
    const order = work.entries
      .map((e, i) => ({ e, i, info: Parser.parseDateField(e.datum, NOW) }))
      .sort((a, b) => (a.info.start ?? 0) - (b.info.start ?? 0));
    for (const { e, i } of order) {
      const li = document.createElement('li');
      li.className = 'entry';
      let pic;
      if (e.bild) {
        pic = document.createElement('img');
        pic.src = e.bild;
        pic.alt = '';
        pic.className = 'entry-img';
      } else {
        pic = document.createElement('span');
        pic.className = 'entry-noimg';
        pic.setAttribute('aria-hidden', 'true');
      }
      const box = document.createElement('div');
      box.className = 'entry-text';
      const t = document.createElement('strong');
      t.textContent = e.titel;
      const d = document.createElement('span');
      d.className = 'entry-date';
      const info = dateInfo(e.datum);
      d.textContent = (info.ok ? info.text : e.datum) + (e.kategorie ? ' · ' + e.kategorie : '');
      const actions = document.createElement('div');
      actions.className = 'entry-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'linkbtn';
      edit.textContent = 'Bearbeiten';
      edit.addEventListener('click', () => fillForm(i));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'linkbtn danger';
      del.textContent = 'Entfernen';
      del.addEventListener('click', () => {
        work.entries.splice(i, 1);
        if (editIndex === i) resetForm();
        else if (editIndex > i) editIndex--;
        touch();
        renderList();
      });
      actions.append(edit, del);
      box.append(t, d, actions);
      li.append(pic, box);
      ul.append(li);
    }
    const n = work.entries.length;
    $('list-title').textContent = n ? `Ereignisse (${n})` : 'Ereignisse';
    $('empty-list').hidden = n > 0;
    renderPreview();
    renderStatus();
  }

  const mctx = document.createElement('canvas').getContext('2d');
  function measure(text, weight, size, fam) {
    mctx.font = `${weight} ${size.toFixed(2)}px ${fam}`;
    return mctx.measureText(text).width;
  }

  // So sieht der Zeitstrahl aus; Antippen eines Ereignisses öffnet es im Formular
  function renderPreview() {
    const box = $('preview');
    const n = work.entries.length;
    $('preview-empty').hidden = n > 0;
    $('preview-note').hidden = n === 0;
    if (!n) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    const src = work.entries.map((e) => Parser.buildLine({ ...e, bild: e.bild ? 'vorschau' : '' })).join('\n');
    const { items } = Parser.parseSource(src, NOW);
    const W = box.clientWidth || 600;
    if (!items.length) { box.textContent = ''; return; }
    let lo = Infinity;
    let hi = -Infinity;
    for (const it of items) { lo = Math.min(lo, it.start); hi = Math.max(hi, it.end); }
    if (hi - lo < 2) { lo -= 5; hi += 5; }
    const pad = (hi - lo) * 0.05;
    const g = Layout.layout(items, { v0: lo - pad, v1: hi + pad }, W, { scale: 1, family: FAM, measure, blank: false });
    const H = Math.ceil(g.H);
    box.innerHTML = `<svg class="tl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="Vorschau eures Zeitstrahls">`
      + Layout.svgBody(g, PAINT, { selectedId: editIndex >= 0 ? 'L' + editIndex : null, interactive: true, todayPos: null }) + '</svg>';
  }

  /* ---------- Speichern und abgeben ---------- */

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '');

  function renderStatus() {
    const st = $('save-status');
    const n = work.entries.length;
    let text = '';
    let tone = '';
    if (!serverMode) {
      text = n ? 'Auf diesem Gerät gespeichert. Zum Abgeben als Datei speichern.' : '';
    } else if (!work.id) {
      text = n ? 'Noch nicht auf dem Laptop der Lehrkraft gespeichert.' : '';
      tone = n ? 'warn' : '';
    } else if (dirty()) {
      text = 'Ungespeicherte Änderungen';
      tone = 'warn';
    } else {
      text = `${work.status === 'abgegeben' ? 'Abgegeben' : 'Zwischengespeichert'} um ${fmtTime(work.saved)} Uhr`;
      tone = 'ok';
    }
    st.textContent = text;
    st.dataset.tone = tone;
    st.hidden = !text;
    $('code-box').hidden = !work.code;
    $('code-value').textContent = work.code;
    $('submitted-msg').hidden = !(serverMode && work.status === 'abgegeben' && !dirty());
    $('btn-draft').hidden = !serverMode;
    $('btn-submit').hidden = !serverMode;
    $('btn-file').hidden = serverMode;
    $('btn-open').hidden = serverMode;
    for (const id of ['btn-draft', 'btn-submit', 'btn-file']) $(id).disabled = !n || busy;
    $('btn-submit').textContent = work.status === 'abgegeben' ? 'Erneut abgeben' : 'Fertig – abgeben';
    $('resume').hidden = !serverMode;
    $('btn-new').hidden = !n && !work.code;
  }

  function payloadEntries() {
    return work.entries.map((e) => ({
      datum: e.datum, titel: e.titel, kategorie: e.kategorie, beschreibung: e.beschreibung, bildquelle: e.quelle, bild: e.bild,
    }));
  }

  async function saveToServer(status, silent) {
    if (busy || !work.entries.length) return false;
    if (!work.von.trim()) {
      if (!silent) {
        toast('Bitte bei „Erstellt von“ eure Vornamen eintragen.');
        $('f-von').focus();
      }
      return false;
    }
    busy = true;
    const rev = work.rev;
    renderStatus();
    try {
      const res = await fetch('api/abgaben', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: work.id, code: work.code, thema: work.thema, titel: work.titel, von: work.von, status, eintraege: payloadEntries(),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.fehler || 'Speichern hat nicht geklappt. Bitte noch einmal versuchen.');
      const first = !work.code;
      Object.assign(work, { id: d.id, code: d.code, thema: d.thema, status: d.status, saved: d.aktualisiert, savedRev: rev });
      saveLocal();
      if (!silent) {
        toast(status === 'abgegeben'
          ? 'Abgegeben! Eure Lehrkraft kann den Zeitstrahl jetzt zeigen.'
          : first ? `Gespeichert. Euer Code ist ${d.code}. Bitte aufschreiben!` : 'Zwischengespeichert.');
      }
      return true;
    } catch (err) {
      if (!silent) {
        toast(err instanceof TypeError ? 'Keine Verbindung zum Laptop der Lehrkraft. Ist das iPad im richtigen WLAN?' : err.message);
      }
      return false;
    } finally {
      busy = false;
      renderHead();
      renderStatus();
    }
  }

  // Wer schon einmal gespeichert hat, wird automatisch weiter gesichert
  function scheduleAutosave() {
    clearTimeout(autoTimer);
    if (!serverMode || !work.id) return;
    autoTimer = setTimeout(() => {
      if (dirty()) saveToServer(work.status || 'entwurf', true);
    }, AUTOSAVE_MS);
  }

  function slug(s) {
    return (s || '').toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  // Ohne Server: als Datei, die die Lehrkraft über „Datei → Öffnen“ einliest
  function saveFile() {
    if (!work.entries.length) return;
    const data = {
      typ: 'zeitstrahl-schueler',
      version: 1,
      thema: work.thema,
      titel: work.titel,
      von: work.von,
      erstellt: new Date().toISOString(),
      eintraege: payloadEntries(),
    };
    const name = ['zeitstrahl', slug(work.thema), slug(work.von)].filter(Boolean).join('-') + '.json';
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`„${name}“ gespeichert. Jetzt bei der Lehrkraft abgeben.`);
  }

  // Ohne Server: eine gespeicherte Datei wieder öffnen und weiterarbeiten
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max).trim() : '');
  const validImage = (s) => typeof s === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s);

  let openArmed = 0;
  function disarmOpen() {
    clearTimeout(openArmed);
    openArmed = 0;
    $('btn-open').textContent = 'Datei öffnen und weiterarbeiten';
    $('btn-open').classList.remove('armed');
  }
  function chooseFile() {
    if (work.entries.length && !openArmed) {
      $('btn-open').textContent = 'Der Zeitstrahl hier wird ersetzt. Noch einmal tippen.';
      $('btn-open').classList.add('armed');
      openArmed = setTimeout(disarmOpen, 6000);
      return;
    }
    disarmOpen();
    $('open-input').click();
  }

  async function openFile(file) {
    let d = null;
    try { d = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); } catch (e) { /* unten gemeldet */ }
    if (!d || d.typ !== 'zeitstrahl-schueler' || !Array.isArray(d.eintraege)) {
      toast(`„${file.name}“ ist keine gespeicherte Zeitstrahl-Datei.`);
      return;
    }
    const entries = d.eintraege
      .filter((e) => e && typeof e.datum === 'string' && typeof e.titel === 'string')
      .map((e) => {
        const bild = validImage(e.bild) ? e.bild : '';
        return {
          datum: str(e.datum, 80), titel: str(e.titel, 200), kategorie: str(e.kategorie, 60),
          beschreibung: str(e.beschreibung, 600), bild, quelle: bild ? str(e.bildquelle, 300) : '',
        };
      });
    work = Object.assign(emptyWork(), { thema: str(d.thema, 140), titel: str(d.titel, 140), von: str(d.von, 120), entries });
    saveLocal();
    renderAll();
    toast(`„${work.titel || work.thema || file.name}“ geöffnet. Viel Erfolg beim Weiterarbeiten!`);
  }

  /* ---------- Weiterarbeiten mit Code, neu beginnen ---------- */

  // Beispiel-Zeitstrahlen mit festem Code (js/beispiele.js) öffnen sich als Vorlage:
  // ohne id und Code, beim Speichern bekommt die Gruppe einen eigenen Code.
  function openSample(code) {
    const s = (window.ZeitstrahlBeispiele || []).find((x) => x.code === code);
    if (!s) return false;
    const entries = s.source.split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => {
        const [datum = '', titel = '', kategorie = '', beschreibung = ''] = l.split('|').map((x) => x.trim());
        return { datum, titel, kategorie, beschreibung, bild: '', quelle: '' };
      })
      .filter((e) => e.datum && e.titel);
    const keepNames = work.von;
    work = Object.assign(emptyWork(), { thema: s.thema || '', titel: s.thema || s.name, von: keepNames, entries });
    work.rev = 1;
    saveLocal();
    $('code-input').value = '';
    $('code-msg').textContent = '';
    renderAll();
    toast(`Beispiel „${s.thema || s.name}“ geöffnet. Ihr könnt es verändern und als euren Zeitstrahl speichern.`);
    return true;
  }

  let replaceArmed = 0;
  async function loadCode(ev) {
    ev.preventDefault();
    const msg = $('code-msg');
    const code = val('code-input').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) {
      msg.textContent = 'Der Code hat fünf Zeichen, z. B. K7M2X.';
      msg.dataset.tone = 'warn';
      return;
    }
    if (work.entries.length && work.code !== code && !replaceArmed) {
      msg.textContent = 'Achtung: Der Zeitstrahl auf diesem iPad wird dabei ersetzt. Zum Bestätigen noch einmal auf „Laden“ tippen.';
      msg.dataset.tone = 'warn';
      replaceArmed = setTimeout(() => { replaceArmed = 0; }, 8000);
      return;
    }
    clearTimeout(replaceArmed);
    replaceArmed = 0;
    if (openSample(code)) return;
    try {
      const res = await fetch('api/abgaben/code/' + encodeURIComponent(code), { cache: 'no-store' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.fehler || 'Laden hat nicht geklappt.');
      work = Object.assign(emptyWork(), {
        id: d.id, code: d.code, thema: d.thema || '', titel: d.titel || '', von: d.von || '', status: d.status || 'entwurf', saved: d.aktualisiert,
        entries: (d.eintraege || []).map((e) => ({
          datum: e.datum, titel: e.titel, kategorie: e.kategorie || '', beschreibung: e.beschreibung || '', bild: e.bild || '', quelle: e.bildquelle || '',
        })),
      });
      saveLocal();
      $('code-input').value = '';
      msg.textContent = '';
      renderAll();
      toast(`„${d.titel || d.thema}“ geladen. Viel Erfolg beim Weiterarbeiten!`);
    } catch (err) {
      msg.textContent = err instanceof TypeError ? 'Keine Verbindung zum Laptop der Lehrkraft.' : err.message;
      msg.dataset.tone = 'warn';
    }
  }

  let newArmed = 0;
  function startNew() {
    const b = $('btn-new');
    if (!newArmed) {
      b.textContent = dirty() && work.entries.length ? 'Ungespeichertes geht verloren. Wirklich neu beginnen?' : 'Wirklich neu beginnen?';
      b.classList.add('armed');
      newArmed = setTimeout(() => {
        newArmed = 0;
        b.textContent = 'Neuen Zeitstrahl beginnen';
        b.classList.remove('armed');
      }, 5000);
      return;
    }
    clearTimeout(newArmed);
    newArmed = 0;
    b.textContent = 'Neuen Zeitstrahl beginnen';
    b.classList.remove('armed');
    const keepNames = work.von; // meist dieselbe Gruppe
    work = emptyWork();
    work.von = keepNames;
    saveLocal();
    renderAll();
    toast('Neuer Zeitstrahl begonnen.');
  }

  /* ---------- Hinweise ---------- */

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  function renderAll() {
    fillGroup();
    resetForm();
    renderHead();
    renderList();
  }

  /* ---------- Start ---------- */

  async function detectServer() {
    if (!/^https?:$/.test(location.protocol)) return false;
    try {
      const res = await fetch('api/status', { cache: 'no-store' });
      const d = await res.json();
      if (!res.ok || !d || d.app !== 'zeitstrahl-werkstatt') return false;
      const t = await fetch('api/aufgabe', { cache: 'no-store' });
      if (t.ok) task = await t.json();
      return true;
    } catch (e) {
      return false;
    }
  }

  $('entry-form').addEventListener('submit', submitForm);
  $('f-datum').addEventListener('input', checkDate);
  $('f-text').addEventListener('input', updateCounter);
  $('f-cancel').addEventListener('click', () => { resetForm(); renderPreview(); });
  for (const [id, key] of [['f-von', 'von'], ['f-titel', 'titel'], ['f-thema', 'thema']]) {
    $(id).addEventListener('input', () => {
      work[key] = $(id).value.trim();
      if (key === 'thema') renderHead();
      touch();
    });
  }
  $('f-bild').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    const check = $('f-bild-check');
    if (!file) return;
    check.textContent = 'Bild wird vorbereitet …';
    check.dataset.tone = '';
    try {
      showImage(await Bild.verkleinern(file));
      check.textContent = '';
    } catch (err) {
      showImage('');
      check.textContent = err.message;
      check.dataset.tone = 'warn';
    }
  });
  $('f-bild-del').addEventListener('click', () => showImage(''));
  $('preview').addEventListener('click', (e) => {
    const hit = e.target.closest('[data-id]');
    if (hit) fillForm(Number(hit.getAttribute('data-id').slice(1)));
  });
  $('preview').addEventListener('keydown', (e) => {
    const hit = e.target.closest('[data-id]');
    if (hit && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      fillForm(Number(hit.getAttribute('data-id').slice(1)));
    }
  });
  $('btn-draft').addEventListener('click', () => saveToServer('entwurf'));
  $('btn-submit').addEventListener('click', () => saveToServer('abgegeben'));
  $('btn-file').addEventListener('click', saveFile);
  $('btn-open').addEventListener('click', chooseFile);
  $('open-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) openFile(file).finally(() => { e.target.value = ''; });
  });
  $('resume').addEventListener('submit', loadCode);
  $('btn-new').addEventListener('click', startNew);
  window.addEventListener('pagehide', saveLocal);

  new ResizeObserver(() => renderPreview()).observe($('preview'));
  if (document.fonts) document.fonts.ready.then(renderPreview);

  loadLocal();
  // Ohne Server kann das Thema über die Adresse kommen: beitrag.html?thema=Reformation
  const fromUrl = new URLSearchParams(location.search).get('thema');
  if (fromUrl && !work.thema) work.thema = fromUrl.slice(0, 140);
  renderAll();
  detectServer().then((on) => {
    serverMode = on;
    if (on) {
      $('f-von-note').textContent = 'Pflichtfeld. Nur Vornamen angeben.';
      $('step-2').textContent = 'Zwischendurch speichern';
      $('step-3').textContent = 'Fertig? Abgeben';
    } else {
      $('step-2').textContent = 'Auf diesem Gerät wird automatisch gespeichert';
      $('step-3').textContent = 'Fertig? Als Datei speichern und abgeben';
    }
    renderHead();
    renderStatus();
    scheduleAutosave();
  });
})();
