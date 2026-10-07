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
  const { slug, str, validImage, toast, download, savePng, printSvg, measure, setTheme, shownTheme, labelThemeIcon } = window.ZeitstrahlGemeinsam;

  const DRAFT_KEY = 'zeitstrahl-schueler-v2';
  const THEME_KEY = 'zeitstrahl-werkstatt-farben';
  const STUDENT_THEME_KEY = 'zeitstrahl-schueler-farben';
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
  // geloescht: Die Lehrkraft hat den gespeicherten Zeitstrahl gelöscht, die Gruppe entscheidet, ob er neu gespeichert wird.
  const emptyWork = () => ({ id: '', code: '', thema: '', titel: '', von: '', status: '', saved: '', rev: 0, savedRev: 0, rueckmeldung: '', geloescht: false, entries: [] });
  let work = emptyWork();
  let task = { thema: '', auftrag: '', kategorien: [], gesperrt: false };
  let serverMode = false;
  let busy = false;
  let editIndex = -1;
  let bildData = '';
  let autoTimer = 0;
  let pollTimer = 0;
  let online = true;
  let localWarned = false;

  const dirty = () => work.rev !== work.savedRev;

  /* ---------- Farben ---------- */

  // Eigene Wahl der Schüler zählt zuerst, sonst die der Lehrkraft-Ansicht auf demselben Gerät,
  // sonst die Einstellung des Geräts
  let theme = 'system';
  function applyTheme(t, save) {
    theme = setTheme(t);
    labelThemeIcon($('btn-theme'), theme);
    if (save) { try { localStorage.setItem(STUDENT_THEME_KEY, theme); } catch (e) { /* egal */ } }
  }
  try {
    applyTheme(localStorage.getItem(STUDENT_THEME_KEY) || localStorage.getItem(THEME_KEY) || 'system', false);
  } catch (e) { applyTheme('system', false); }

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
    renderKatChoices();
  }

  function fillGroup() {
    $('f-von').value = work.von;
    $('f-titel').value = work.titel;
    $('f-thema').value = work.thema;
  }

  /* ---------- Formular für ein Ereignis ---------- */

  // Vorgegebene Kategorien gelten nur für einen Zeitstrahl zum aktuellen Thema
  const presetKats = () => (serverMode && (!work.id || work.thema === task.thema) && Array.isArray(task.kategorien) ? task.kategorien : []);
  const sameKats = (a, b) => (a || []).join('\n') === (b || []).join('\n');

  // Mit Vorgabe tippen die Schüler eine Kategorie an statt sie einzugeben. Der Wert steht
  // weiter im (dann versteckten) Textfeld, damit Speichern und Bearbeiten gleich bleiben.
  function renderKatChoices() {
    const kats = presetKats();
    const on = kats.length > 0;
    const box = $('f-kat-choices');
    $('f-kategorie').hidden = on;
    $('f-kategorie-note').hidden = on;
    $('f-kat-choices-note').hidden = !on;
    box.hidden = !on;
    box.textContent = '';
    if (!on) return;
    const cur = val('f-kategorie');
    const colors = Parser.presetColors(kats);
    const list = kats.slice();
    // Eine Kategorie, die die Lehrkraft inzwischen gestrichen hat, bleibt beim Bearbeiten wählbar
    const alt = cur && !kats.some((k) => k.toLowerCase() === cur.toLowerCase());
    if (alt) list.push(cur);
    for (const name of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kat-choice' + (alt && name === cur ? ' alt' : '');
      b.setAttribute('role', 'radio');
      const checked = name.toLowerCase() === cur.toLowerCase();
      b.setAttribute('aria-checked', String(checked));
      b.tabIndex = checked || (!cur && name === list[0]) ? 0 : -1;
      const ci = colors.get(name.toLowerCase());
      if (ci) b.style.setProperty('--c', `var(--cat-${ci})`);
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.setAttribute('aria-hidden', 'true');
      b.append(sw, name);
      b.addEventListener('click', () => {
        $('f-kategorie').value = name;
        $('form-msg').textContent = '';
        renderKatChoices();
        box.querySelector('[aria-checked="true"]').focus();
      });
      box.append(b);
    }
  }

  // Pfeiltasten wandern wie bei Optionsfeldern durch die Kategorien
  $('f-kat-choices').addEventListener('keydown', (ev) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (!step) return;
    const all = [...$('f-kat-choices').querySelectorAll('.kat-choice')];
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    ev.preventDefault();
    all[(i + step + all.length) % all.length].click();
  });

  function dateInfo(text) {
    const r = Parser.parseDateField(text, NOW);
    if (r.error) return { ok: false, text: r.error };
    const when = r.longLabel // Jahrhundert: „15. Jahrhundert“ statt „um 1401 bis um 1500“
      ? r.longLabel
      : r.kind === 'point' ? Parser.fmtLong(r.a) : `${Parser.fmtLong(r.a)} bis ${Parser.fmtLong(r.b)}`;
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
    renderKatChoices();
    checkDate();
    updateCounter();
  }

  function fillForm(i) {
    const e = work.entries[i];
    if (!e) return;
    $('f-datum').value = e.datum;
    $('f-ereignis').value = e.titel;
    $('f-kategorie').value = e.kategorie || '';
    renderKatChoices();
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
    if (!info.ok) {
      $('date-help').open = true;
      return fail('f-datum', info.text);
    }
    if (!titel) return fail('f-ereignis', 'Bitte das Ereignis benennen.');
    if (presetKats().length && !val('f-kategorie')) {
      $('form-msg').textContent = 'Bitte eine Kategorie antippen.';
      $('f-kat-choices').querySelector('.kat-choice').focus();
      return;
    }
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

  // So sieht der Zeitstrahl aus; Antippen eines Ereignisses öffnet es im Formular
  function renderPreview() {
    const box = $('preview');
    const n = work.entries.length;
    $('preview-empty').hidden = n > 0;
    $('preview-note').hidden = n === 0;
    $('preview-actions').hidden = n === 0;
    if (!n) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    const src = work.entries.map((e) => Parser.buildLine({ ...e, bild: e.bild ? 'vorschau' : '' })).join('\n');
    const { items } = Parser.parseSource(src, NOW, presetKats());
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

  // Der eigene Zeitstrahl als Seite A4 quer, genauso wie bei der Lehrkraft
  function pageSvg() {
    const src = work.entries.map((e) => Parser.buildLine({ ...e, bild: e.bild ? 'vorschau' : '' })).join('\n');
    const { items, cats } = Parser.parseSource(src, NOW, presetKats());
    if (!items.length) { toast('Euer Zeitstrahl hat noch keine Einträge.'); return null; }
    let lo = Math.min(...items.map((i) => i.start));
    let hi = Math.max(...items.map((i) => i.end));
    if (hi - lo < 2) { lo -= 5; hi += 5; }
    const pad = (hi - lo) * 0.05;
    return Layout.pageSvg(items, { v0: lo - pad, v1: hi + pad }, cats, {
      title: work.titel || work.thema || 'Mein Zeitstrahl', von: work.von.trim(), measure, day: new Date().toLocaleDateString('de-DE'),
    });
  }

  function savePicture() {
    const page = pageSvg();
    if (!page) return;
    const name = ['zeitstrahl', ...[work.titel || work.thema, work.von].filter(Boolean).map(slug)].join('-');
    savePng(page.markup, page.w, page.h, name, 'Bild gespeichert.');
  }

  function printPage() {
    const page = pageSvg();
    if (page) printSvg(page.markup);
  }

  /* ---------- Verbindung zum Laptop ---------- */

  // Fällt das WLAN aus, sagt die Seite Bescheid und speichert nach, sobald es wieder geht
  function setOnline(on) {
    if (on === online) return;
    online = on;
    $('offline-msg').hidden = on;
    if (!on) {
      toast('Keine Verbindung zum Laptop der Lehrkraft. Eure Eingaben bleiben auf dem iPad.');
      return;
    }
    if (dirty() && work.id && !work.geloescht) {
      saveToServer(work.status || 'entwurf', true).then((ok) => {
        toast(ok ? 'Verbindung wieder da. Euer Zeitstrahl ist gespeichert.' : 'Verbindung wieder da.');
      });
    } else {
      toast('Verbindung wieder da.');
    }
  }

  function renderFeedback() {
    const text = work.rueckmeldung || '';
    $('feedback-text').textContent = text;
    $('feedback-card').hidden = !text;
  }

  // Regelmäßig nachsehen: Ist der Laptop noch da, gibt es eine Rückmeldung,
  // hat die Lehrkraft die Abgabe beendet?
  async function pollServer() {
    if (!serverMode) return;
    try {
      const t = await fetch('api/aufgabe', { cache: 'no-store' });
      if (t.ok) {
        const neu = await t.json();
        const changed = neu.gesperrt !== task.gesperrt || neu.thema !== task.thema || neu.auftrag !== task.auftrag;
        const katsChanged = !sameKats(neu.kategorien, task.kategorien);
        task = neu;
        if (changed) { renderHead(); renderStatus(); }
        else if (katsChanged) renderKatChoices();
        if (changed || katsChanged) renderPreview();
      }
      if (work.code) {
        const r = await fetch(`api/abgaben/code/${encodeURIComponent(work.code)}/stand`, { cache: 'no-store' });
        if (r.status === 404 && work.id && !work.geloescht) markDeleted();
        if (r.ok) {
          const d = await r.json();
          if ((d.rueckmeldung || '') !== (work.rueckmeldung || '')) {
            const neu = !!d.rueckmeldung && d.rueckmeldung !== work.rueckmeldung;
            work.rueckmeldung = d.rueckmeldung || '';
            saveLocal();
            renderFeedback();
            if (neu) toast('Eure Lehrkraft hat euch eine Rückmeldung geschrieben.');
          }
        }
      }
      setOnline(true);
    } catch (e) {
      setOnline(false);
    }
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
    $('code-box').hidden = !work.code || work.geloescht;
    $('code-value').textContent = work.code;
    $('submitted-msg').hidden = !(serverMode && work.status === 'abgegeben' && !dirty());
    $('btn-draft').hidden = !serverMode;
    $('btn-submit').hidden = !serverMode;
    $('btn-file').hidden = serverMode;
    $('btn-open').hidden = serverMode;
    const zu = serverMode && !!task.gesperrt;
    $('locked-msg').hidden = !zu;
    $('deleted-msg').hidden = !(serverMode && work.geloescht);
    for (const id of ['btn-draft', 'btn-submit', 'btn-file']) $(id).disabled = !n || busy || (zu && id !== 'btn-file') || (work.geloescht && id !== 'btn-file');
    $('btn-save-new').disabled = !n || busy || zu;
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
      if (res.status === 410) {
        markDeleted();
        return false;
      }
      if (res.status === 423) {
        task.gesperrt = true;
        renderStatus();
        if (!silent) toast(d.fehler);
        return false;
      }
      if (!res.ok) throw new Error(d.fehler || 'Speichern hat nicht geklappt. Bitte noch einmal versuchen.');
      setOnline(true);
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
      if (err instanceof TypeError) setOnline(false);
      else if (!silent) toast(err.message);
      return false;
    } finally {
      busy = false;
      renderHead();
      renderStatus();
    }
  }

  // Die Lehrkraft hat den Zeitstrahl gelöscht: nichts mehr automatisch speichern, die Gruppe fragen
  function markDeleted() {
    work.geloescht = true;
    clearTimeout(autoTimer);
    saveLocal();
    renderStatus();
    toast('Eure Lehrkraft hat diesen Zeitstrahl gelöscht. Eure Eingaben sind noch auf dem iPad.');
  }

  // Auf Wunsch der Gruppe: als neuen Zeitstrahl speichern, mit neuem Code
  async function saveAsNew() {
    Object.assign(work, { id: '', code: '', status: '', saved: '', rueckmeldung: '', geloescht: false });
    renderFeedback();
    if (!(await saveToServer('entwurf'))) {
      saveLocal();
      renderStatus();
    }
  }

  // Wer schon einmal gespeichert hat, wird automatisch weiter gesichert
  function scheduleAutosave() {
    clearTimeout(autoTimer);
    if (!serverMode || !work.id || work.geloescht) return;
    autoTimer = setTimeout(() => {
      if (dirty()) saveToServer(work.status || 'entwurf', true);
    }, AUTOSAVE_MS);
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
    const name = ['zeitstrahl', ...[work.thema, work.von].filter(Boolean).map(slug)].join('-') + '.json';
    download(name, new Blob([JSON.stringify(data)], { type: 'application/json' }));
    toast(`„${name}“ gespeichert. Jetzt bei der Lehrkraft abgeben.`);
  }

  // Ohne Server: eine gespeicherte Datei wieder öffnen und weiterarbeiten
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
        const [datum = '', titel = '', kategorie = '', beschreibung = ''] = Parser.splitLine(l.trim());
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
        rueckmeldung: d.rueckmeldung || '',
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

  function renderAll() {
    fillGroup();
    resetForm();
    renderHead();
    renderFeedback();
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
  $('btn-save-new').addEventListener('click', saveAsNew);
  $('btn-submit').addEventListener('click', () => saveToServer('abgegeben'));
  $('btn-file').addEventListener('click', saveFile);
  $('btn-png').addEventListener('click', savePicture);
  $('btn-print').addEventListener('click', printPage);
  $('btn-open').addEventListener('click', chooseFile);
  $('open-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) openFile(file).finally(() => { e.target.value = ''; });
  });
  $('resume').addEventListener('submit', loadCode);
  $('btn-new').addEventListener('click', startNew);
  // Immer ins Gegenteil des Sichtbaren, wie in der Lehrkraft-Ansicht
  $('btn-theme').addEventListener('click', () => applyTheme(shownTheme(theme) === 'dark' ? 'light' : 'dark', true));
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
    renderPreview(); // Farben der vorgegebenen Kategorien
    renderStatus();
    scheduleAutosave();
    if (on) {
      pollTimer = setInterval(pollServer, 20000);
      pollServer();
    }
  });
})();
