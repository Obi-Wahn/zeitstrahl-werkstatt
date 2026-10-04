/*
 * Zeitstrahl-Werkstatt · Bilder
 * Verkleinert hochgeladene Bilder im Browser, damit Beitragsdateien klein bleiben.
 * Die Bilder verlassen dabei nie das Gerät.
 */
window.ZeitstrahlBild = (() => {
  'use strict';

  const MAX_FILE = 20 * 1024 * 1024; // größere Dateien werden abgelehnt
  const MAX_SIDE = 1000;             // längste Bildseite in Pixeln
  const QUALITY = 0.8;               // JPEG-Qualität

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unlesbar')); };
      img.src = url;
    });
  }

  // Liefert eine data:-URL (JPEG) oder wirft einen Fehler mit verständlicher Meldung
  async function verkleinern(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error('Bitte eine Bilddatei wählen (JPG, PNG, WebP oder GIF).');
    if (file.size > MAX_FILE) throw new Error('Das Bild ist größer als 20 MB. Bitte ein kleineres Bild wählen.');
    let img;
    try {
      img = await loadImage(file);
    } catch (e) {
      throw new Error('Das Bild lässt sich nicht öffnen. Bitte ein JPG oder PNG versuchen.');
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; // transparente PNGs bekommen weißen Grund
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', QUALITY);
  }

  // Kurzer, eindeutiger Schlüssel für ein Bild im Zeitstrahl
  function neuerSchluessel(vorhanden) {
    let k;
    do { k = 'b' + Math.random().toString(36).slice(2, 7); } while (vorhanden && vorhanden[k]);
    return k;
  }

  return { verkleinern, neuerSchluessel };
})();
