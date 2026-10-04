/*
 * Zeitstrahl-Werkstatt · Schülerseite
 * Schülerinnen und Schüler sammeln Ereignisse (mit Bild) und speichern sie als Beitragsdatei.
 * Die Lehrkraft öffnet diese Datei in der Lehrkraft-Ansicht und übernimmt die Beiträge.
 */
(() => {
  'use strict';

  const Parser = window.ZeitstrahlParser;
  const Layout = window.ZeitstrahlLayout;
  const Bild = window.ZeitstrahlBild;

  const DRAFT_KEY = 'zeitstrahl-beitrag-entwurf-v1';
  const THEME_KEY = 'zeitstrahl-werkstatt-farben';
  const NOW = new Date();
  const FAM = '"Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif';
  const PAINT = {
    ink: 'var(--ink)', soft: 'var(--ink-soft)', grid: 'var(--grid)', sheet: 'var(--sheet)', accent: 'var(--board)',
    cat: (i) => `var(--cat-${i})`,
  };

  const $ = (id) => document.getElementById(id);
  const val = (id) => $(id).value.trim();

  let entries = [];
  let editIndex = -1;
  let bildData = '';
  let draftWarned = false;
  let serverMode = false; // true, wenn die Seite vom Laptop der Lehrkraft kommt
  let sending = false;

  // Farbwahl der Lehrkraft-Ansicht übernehmen, falls auf demselben Gerät gesetzt
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* egal */ }

  /* ---------- Entwurf auf diesem Gerät ---------- */

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ thema: val('f-thema'), von: val('f-von'), entries }));
    } catch (e) {
      if (!draftWarned) {
        draftWarned = true;
        toast('Der Zwischenspeicher ist voll. Bitte die Datei bald speichern.');
      }
    }
  }

  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (d && Array.isArray(d.entries)) {
        entries = d.entries.filter((e) => e && typeof e.titel === 'string' && typeof e.datum === 'string');
        $('f-thema').value = typeof d.thema === 'string' ? d.thema : '';
        $('f-von').value = typeof d.von === 'string' ? d.von : '';
      }
    } catch (e) { /* kein Entwurf */ }
    // Das Thema kommt über den QR-Code der Lehrkraft (…/beitrag.html?thema=…)
    const thema = new URLSearchParams(location.search).get('thema');
    if (thema) $('f-thema').value = thema.slice(0, 140);
  }

  /* ---------- Formular ---------- */

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
    for (const id of ['f-datum', 'f-titel', 'f-kategorie', 'f-text', 'f-quelle']) $(id).value = '';
    showImage('');
    $('f-bild-check').textContent = '';
    $('form-msg').textContent = '';
    editIndex = -1;
    $('form-title').textContent = 'Neues Ereignis';
    $('f-submit').textContent = 'Zur Liste hinzufügen';
    $('f-cancel').hidden = true;
    checkDate();
    updateCounter();
  }

  function fillForm(e, i) {
    $('f-datum').value = e.datum;
    $('f-titel').value = e.titel;
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
    $('entry-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('f-datum').focus({ preventScroll: true });
  }

  function fail(id, msg) {
    $('form-msg').textContent = msg;
    $(id).focus();
    return false;
  }

  function submitForm(ev) {
    ev.preventDefault();
    const datum = val('f-datum');
    const titel = val('f-titel');
    if (!datum) return fail('f-datum', 'Bitte ein Datum eintragen.');
    const info = dateInfo(datum);
    if (!info.ok) return fail('f-datum', info.text);
    if (!titel) return fail('f-titel', 'Bitte das Ereignis benennen.');
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
    if (wasEdit) entries[editIndex] = e;
    else entries.push(e);
    $('sent-msg').hidden = true;
    resetForm();
    saveDraft();
    renderList();
    toast(wasEdit ? 'Änderungen übernommen.' : `„${e.titel}“ steht jetzt in deiner Liste.`);
    $('f-datum').focus();
    return true;
  }

  /* ---------- Liste und Vorschau ---------- */

  function renderList() {
    const ul = $('entries');
    ul.textContent = '';
    entries.forEach((e, i) => {
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
      edit.addEventListener('click', () => fillForm(e, i));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'linkbtn danger';
      del.textContent = 'Entfernen';
      del.addEventListener('click', () => {
        entries.splice(i, 1);
        if (editIndex === i) resetForm();
        else if (editIndex > i) editIndex--;
        saveDraft();
        renderList();
      });
      actions.append(edit, del);
      box.append(t, d, actions);
      li.append(pic, box);
      ul.append(li);
    });
    $('list-title').textContent = entries.length ? `Deine Beiträge (${entries.length})` : 'Deine Beiträge';
    $('empty-list').hidden = entries.length > 0 || !$('sent-msg').hidden;
    $('btn-save').disabled = entries.length === 0 || sending;
    $('btn-clear').hidden = entries.length === 0;
    renderPreview();
  }

  const mctx = document.createElement('canvas').getContext('2d');
  function measure(text, weight, size, fam) {
    mctx.font = `${weight} ${size.toFixed(2)}px ${fam}`;
    return mctx.measureText(text).width;
  }

  // Kleine Vorschau: so erscheinen die Beiträge später im Zeitstrahl
  function renderPreview() {
    const box = $('preview');
    if (!entries.length) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    const src = entries.map((e) => Parser.buildLine({ ...e, bild: e.bild ? 'vorschau' : '' })).join('\n');
    const { items } = Parser.parseSource(src, NOW);
    const W = box.clientWidth || 300;
    if (!items.length) { box.textContent = ''; return; }
    let lo = Infinity;
    let hi = -Infinity;
    for (const it of items) { lo = Math.min(lo, it.start); hi = Math.max(hi, it.end); }
    if (hi - lo < 2) { lo -= 5; hi += 5; }
    const pad = (hi - lo) * 0.06;
    const g = Layout.layout(items, { v0: lo - pad, v1: hi + pad }, W, { scale: 0.9, family: FAM, measure, blank: false });
    const H = Math.ceil(g.H);
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="font-family:${FAM}" role="img" aria-label="Vorschau deiner Beiträge auf dem Zeitstrahl">`
      + Layout.svgBody(g, PAINT, { selectedId: null, interactive: false, todayPos: null }) + '</svg>';
  }

  /* ---------- Speichern ---------- */

  function slug(s) {
    return (s || '').toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  function payload() {
    const von = val('f-von');
    return {
      typ: 'zeitstrahl-beitrag',
      version: 1,
      thema: val('f-thema'),
      von,
      erstellt: new Date().toISOString(),
      beitraege: entries.map((e) => ({
        datum: e.datum,
        titel: e.titel,
        kategorie: e.kategorie,
        beschreibung: e.beschreibung,
        von,
        bildquelle: e.quelle,
        bild: e.bild,
      })),
    };
  }

  // Direkt an den Laptop der Lehrkraft senden
  async function sendToTeacher() {
    if (!entries.length || sending) return;
    if (!val('f-von')) {
      toast('Bitte bei „Erstellt von“ eure Vornamen eintragen.');
      $('f-von').focus();
      return;
    }
    sending = true;
    const btn = $('btn-save');
    btn.disabled = true;
    btn.textContent = 'Wird gesendet …';
    try {
      const res = await fetch('api/beitraege', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.fehler || 'Senden hat nicht geklappt. Bitte noch einmal versuchen.');
      const n = d.anzahl || entries.length;
      entries = [];
      resetForm();
      saveDraft();
      const msg = $('sent-msg');
      msg.textContent = n === 1
        ? 'Gesendet! Dein Beitrag ist bei deiner Lehrkraft angekommen.'
        : `Gesendet! ${n} Beiträge sind bei deiner Lehrkraft angekommen.`;
      msg.hidden = false;
    } catch (err) {
      toast(err instanceof TypeError
        ? 'Keine Verbindung zum Laptop der Lehrkraft. Ist das iPad im richtigen WLAN?'
        : err.message);
    } finally {
      sending = false;
      btn.textContent = 'An die Lehrkraft senden';
      renderList();
    }
  }

  function saveFile() {
    if (!entries.length) return;
    const thema = val('f-thema');
    const von = val('f-von');
    const data = payload();
    const name = ['beitrag', slug(thema), slug(von)].filter(Boolean).join('-') + '.json';
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

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }

  /* ---------- Start ---------- */

  $('entry-form').addEventListener('submit', submitForm);
  $('f-datum').addEventListener('input', checkDate);
  $('f-text').addEventListener('input', updateCounter);
  $('f-thema').addEventListener('input', saveDraft);
  $('f-von').addEventListener('input', saveDraft);
  $('f-cancel').addEventListener('click', resetForm);
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
  $('btn-save').addEventListener('click', () => (serverMode ? sendToTeacher() : saveFile()));

  // Läuft die Seite über den Klassenserver? Dann wird gesendet statt gespeichert.
  async function detectServer() {
    if (!/^https?:$/.test(location.protocol)) return;
    try {
      const res = await fetch('api/status', { cache: 'no-store' });
      const d = await res.json();
      if (!res.ok || !d || d.app !== 'zeitstrahl-werkstatt') return;
    } catch (e) {
      return;
    }
    serverMode = true;
    $('step-3').textContent = 'An die Lehrkraft senden – fertig';
    $('btn-save').textContent = 'An die Lehrkraft senden';
    $('save-note').textContent = 'Alle Beiträge dieser Liste gehen direkt an den Laptop deiner Lehrkraft. Bis dahin bleiben sie auf diesem iPad.';
    $('f-von-note').textContent = 'Pflichtfeld beim Senden. Nur Vornamen angeben.';
  }

  let clearArmed = 0;
  $('btn-clear').addEventListener('click', () => {
    const b = $('btn-clear');
    if (!clearArmed) {
      b.textContent = 'Wirklich alles löschen?';
      b.classList.add('armed');
      clearArmed = setTimeout(() => {
        clearArmed = 0;
        b.textContent = 'Liste leeren';
        b.classList.remove('armed');
      }, 4000);
      return;
    }
    clearTimeout(clearArmed);
    clearArmed = 0;
    b.textContent = 'Liste leeren';
    b.classList.remove('armed');
    entries = [];
    resetForm();
    saveDraft();
    renderList();
  });

  new ResizeObserver(() => renderPreview()).observe($('preview'));
  if (document.fonts) document.fonts.ready.then(renderPreview);

  loadDraft();
  resetForm();
  renderList();
  detectServer();
})();
