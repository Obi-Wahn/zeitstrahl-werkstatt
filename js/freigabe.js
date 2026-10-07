/*
 * Zeitstrahl-Werkstatt · Zeitstrahl der Lehrkraft auf der Schülerseite
 *
 * Die Lehrkraft kann einen ihrer Zeitstrahlen für die iPads sichtbar machen
 * (Dialog „Unterricht“). Die Schüler sehen ihn hier nur an,
 * drucken ihn oder speichern ihn als Bild. Er wird nie in den eigenen Zeitstrahl,
 * den Speicher des iPads oder die Abgabe geschrieben.
 */
(() => {
  'use strict';

  const Parser = window.ZeitstrahlParser;
  const Layout = window.ZeitstrahlLayout;
  const { slug, toast, measure, savePng, printSvg } = window.ZeitstrahlGemeinsam;

  const POLL_MS = 20000;
  const MIN_W = 760; // schmaler wird der Zeitstrahl nicht, auf dem Handy lässt er sich seitlich schieben
  const NOW = new Date();
  const FAM = '"Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif';
  const PAINT = {
    ink: 'var(--ink)', soft: 'var(--ink-soft)', grid: 'var(--grid)', sheet: 'var(--sheet)', accent: 'var(--board)',
    cat: (i) => `var(--cat-${i})`,
  };

  const $ = (id) => document.getElementById(id);
  const dlg = $('freigabe');

  let shown = null; // { hash, name, images, items, cats }
  let selectedId = null;
  // Ganzer Zeitraum der Einträge mit etwas Rand
  function fullView(items) {
    let lo = Math.min(...items.map((i) => i.start));
    let hi = Math.max(...items.map((i) => i.end));
    if (hi - lo < 2) { lo -= 5; hi += 5; }
    const pad = (hi - lo) * 0.05;
    return { v0: lo - pad, v1: hi + pad };
  }

  let checked = false; // schon einmal nachgefragt: Erst danach ist eine Freigabe neu

  function renderCard() {
    $('freigabe-card').hidden = !shown;
    if (shown) $('freigabe-name').textContent = shown.name;
  }

  function renderTimeline() {
    const box = $('freigabe-preview');
    const items = shown ? shown.items : [];
    if (!items.length) {
      box.innerHTML = '<p class="empty-list">Dieser Zeitstrahl hat noch keine Einträge.</p>';
      return;
    }
    const W = Math.max(MIN_W, box.clientWidth || 0);
    const g = Layout.layout(items, fullView(items), W, { scale: 1, family: FAM, measure, blank: false });
    const H = Math.ceil(g.H);
    box.innerHTML = `<svg class="tl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="Zeitstrahl eurer Lehrkraft">`
      + Layout.svgBody(g, PAINT, { selectedId, interactive: true, todayPos: null }) + '</svg>';
  }

  function renderDetail() {
    const it = shown && shown.items.find((i) => i.id === selectedId);
    $('freigabe-detail').hidden = !it;
    if (!it) return;
    $('fd-swatch').style.background = `var(--cat-${it.ci})`;
    $('fd-cat').textContent = it.cat;
    $('fd-title').textContent = it.title;
    $('fd-when').textContent = it.kind === 'span' ? `${it.longDate} · ${Parser.durationText(it)}` : it.longDate;
    $('fd-desc').textContent = it.desc;
    $('fd-desc').hidden = !it.desc;
    const src = it.img ? shown.images[it.img] : '';
    const img = $('fd-img');
    if (src) {
      img.src = src;
      img.alt = it.title;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
    $('fd-meta').textContent = it.quelle ? 'Bildquelle: ' + it.quelle : '';
    $('fd-meta').hidden = !it.quelle;
  }

  function render() {
    if (!dlg.open) return;
    $('freigabe-title').textContent = shown.name;
    renderTimeline();
    renderDetail();
  }

  function open() {
    if (!shown) return;
    selectedId = null;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    render();
  }

  function select(e) {
    const hit = e.target.closest('[data-id]');
    if (!hit) return;
    const id = hit.getAttribute('data-id');
    selectedId = selectedId === id ? null : id;
    renderTimeline();
    renderDetail();
    if (selectedId) $('freigabe-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Dieselbe Seite A4 quer wie bei der Lehrkraft (js/layout.js)
  function page() {
    return Layout.pageSvg(shown.items, fullView(shown.items), shown.cats, {
      title: shown.name, measure, day: new Date().toLocaleDateString('de-DE'),
    });
  }

  function saveImage() {
    if (!shown || !shown.items.length) return toast('Dieser Zeitstrahl hat noch keine Einträge.');
    const { markup, w, h } = page();
    savePng(markup, w, h, slug(shown.name), 'Bild gespeichert.');
  }

  function printPage() {
    if (!shown || !shown.items.length) return toast('Dieser Zeitstrahl hat noch keine Einträge.');
    printSvg(page().markup);
  }

  // Fragt beim Laptop nach. Unverändert: nur kurze Antwort, die Bilder kommen nicht erneut.
  async function poll() {
    try {
      const res = await fetch('api/freigabe?hash=' + encodeURIComponent(shown ? shown.hash : ''), { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();
      if (d.unveraendert) return;
      const neu = checked && !shown;
      checked = true;
      if (d.leer) {
        if (!shown) return;
        shown = null;
        if (dlg.open) {
          dlg.close();
          toast('Eure Lehrkraft zeigt diesen Zeitstrahl gerade nicht mehr.');
        }
        renderCard();
        return;
      }
      const { items, cats } = Parser.parseSource(String(d.source || ''), NOW);
      shown = { hash: d.hash, name: d.name || 'Zeitstrahl', images: d.images || {}, items, cats };
      if (!shown.items.some((i) => i.id === selectedId)) selectedId = null;
      renderCard();
      render();
      if (neu) toast('Eure Lehrkraft hat einen Zeitstrahl zum Ansehen freigegeben.');
    } catch (e) {
      /* keine Verbindung: Die Schülerseite meldet das selbst */
    }
  }

  if (!/^https?:$/.test(location.protocol)) return; // ohne Server gibt es nichts freizugeben

  $('freigabe-open').addEventListener('click', open);
  $('freigabe-close').addEventListener('click', () => dlg.close());
  $('freigabe-print').addEventListener('click', printPage);
  $('freigabe-png').addEventListener('click', saveImage);
  $('freigabe-preview').addEventListener('click', select);
  $('freigabe-preview').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(e); }
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (dlg.open) renderTimeline(); }, 150);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  poll();
  setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
})();
