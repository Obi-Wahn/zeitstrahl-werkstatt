# Zeitstrahl-Werkstatt

Interaktive Zeitstrahlen für Geschichte und Religion. Die Lehrkraft pflegt die Einträge als einfachen Text, zeigt sie als Tafelbild am Beamer und sichert sie als Bild fürs Arbeitsblatt. Schülerinnen und Schüler schicken eigene Ereignisse mit Foto direkt vom iPad an den Laptop der Lehrkraft.

Der Laptop der Lehrkraft ist dabei der Server. Es gibt keine Cloud und keine Konten, alle Daten bleiben auf dem Laptop.

## Einrichten (einmalig)

1. **Node.js installieren:** Von https://nodejs.org die Version „LTS“ herunterladen und installieren. Das Programm ist kostenlos, weitere Pakete braucht die Werkstatt nicht.
2. **Projekt herunterladen:** Auf GitHub über **Code → Download ZIP** herunterladen und auf dem Laptop entpacken, z. B. in „Dokumente“.

## Im Unterricht

1. **Server starten:** Im Ordner doppelklicken auf
   - Windows: `Server starten (Windows).bat`
   - Mac: `Server starten (Mac).command` (beim ersten Mal: Rechtsklick → Öffnen)

   Es öffnet sich ein Fenster mit den Adressen, und der Browser zeigt die Lehrkraft-Ansicht unter `http://localhost:8080`. **Das Fenster während der Stunde offen lassen.**
2. **iPads verbinden:** Auf **iPads verbinden** klicken. Am Beamer erscheint ein großer QR-Code. Die Schülerinnen und Schüler scannen ihn mit der Kamera-App und landen direkt auf der Beitragsseite. Das Thema ist dort schon eingetragen, es kommt vom gerade geöffneten Zeitstrahl.
3. **Beiträge schreiben:** Auf dem iPad tragen sie Vornamen, Datum, Ereignis, Kategorie und Beschreibung ein. Ein Bild können sie direkt fotografieren oder aus der Mediathek wählen, die Bildquelle ist dann Pflicht. Das Formular zeigt sofort, wie das Datum verstanden wurde („Erkannt: 24. Oktober 1648 · vor 378 Jahren“). Am Ende tippen sie auf **An die Lehrkraft senden**.
4. **Beiträge prüfen:** Bei der Lehrkraft zählt der Knopf **Eingang (3)** mit, neue Beiträge werden kurz angezeigt. Ein Klick öffnet die Prüfung. Ausgewählte Beiträge kommen mit Bild in den aktuellen Zeitstrahl, die übrigen werden verworfen.
5. **Präsentieren:** Mit **Tafelbild** geht es in den Vollbildmodus, mit **Schrittweise aufdecken** blättert man Eintrag für Eintrag durch.
6. **Beenden:** Das Server-Fenster schließen.

### Wenn die iPads die Seite nicht erreichen

- Laptop und iPads müssen im **selben WLAN** sein.
- **Windows** fragt beim ersten Start, ob Node.js im Netzwerk kommunizieren darf. Dann „Private Netzwerke“ erlauben. Bei einem Schul-WLAN, das Windows als „öffentlich“ einstuft, muss auch „Öffentliche Netzwerke“ erlaubt werden.
- Viele Schul-WLANs verbieten Verbindungen zwischen Geräten („Client-Isolation“). Dann hilft ein eigenes WLAN: entweder der **mobile Hotspot** des Laptops (Windows: Einstellungen → Netzwerk → Mobiler Hotspot) oder ein Hotspot vom Diensthandy, mit dem sich Laptop und iPads verbinden. Alternativ kann die IT-Betreuung den Laptop freischalten.
- Zeigt der Dialog mehrere Adressen, die anderen nacheinander ausprobieren.
- Die Adresse lässt sich auch in Safari eintippen, z. B. `192.168.178.23:8080`.

### Port ändern

Die Werkstatt nutzt standardmäßig Port **8080**. Ist er belegt oder soll ein anderer genutzt werden, in der Datei `einstellungen.txt` die Zeile ändern, z. B.:

```
port = 8090
```

Danach das Server-Fenster schließen und neu starten. Die neue Adresse steht im Server-Fenster und im QR-Code. Für einen einzelnen Start geht es auch ohne die Datei: `node server.js 8090`.

Bei Port **80** brauchen die iPads gar keine Portnummer (`192.168.178.23` genügt). Auf Mac und Linux braucht Port 80 allerdings Administratorrechte.

Der Browser merkt sich Daten getrennt je Port. Nach einem Wechsel holt die Lehrkraft-Ansicht die Zeitstrahlen deshalb automatisch aus `daten/sicherung.json` zurück.

## Ohne Server

`index.html` funktioniert auch per Doppelklick, ganz ohne Server, z. B. zum Vorbereiten zu Hause. Dann fehlen nur „iPads verbinden“ und der Eingang. Schülerbeiträge lassen sich trotzdem als Datei austauschen: Die Schülerseite `beitrag.html` speichert dann eine Datei, die man über **Datei → Öffnen** einliest.

**Wichtig:** Der Browser speichert die Zeitstrahlen getrennt nach Adresse. Was unter `http://localhost:8080` angelegt wurde, erscheint nicht beim Doppelklick auf `index.html` und umgekehrt. Zum Übertragen **Datei → Alle Zeitstrahlen sichern** und auf der anderen Seite **Datei → Öffnen** verwenden.

## Funktionen

| Bereich | Was es kann |
| --- | --- |
| Zeitstrahl | Zoomen (Mausrad, zwei Finger, `+` `−`), Verschieben (Ziehen, `←` `→`), „Alles zeigen“ (`0`). Ereignisse als Fähnchen, Zeiträume als Balken, Linie für „heute“. |
| Kategorien | Farbig, per Klick ein- und ausblendbar. |
| Details | Klick auf einen Eintrag zeigt Datum, „vor … Jahren“, Dauer, Beschreibung, Bild, Verfasser und Bildquelle. Bilder lassen sich dort auch selbst hinzufügen. |
| Tafelbild | Vollbild für den Beamer, große Schrift. **Schrittweise aufdecken** blättert in zeitlicher Reihenfolge (Pfeiltasten, Leertaste oder Presenter). |
| Farben | Automatisch, hell oder „Tafel“ (dunkel mit Kreidefarben). |
| Arbeitsblatt | Sichtbaren Ausschnitt als PNG sichern. Das **Lückenbild** zeigt nur die Daten mit Leerzeilen zum Ausfüllen. |
| Speichern | Automatisch im Browser und, wenn der Server läuft, zusätzlich in `daten/sicherung.json`. |

## Schreibweise der Einträge

Eine Zeile pro Eintrag:

```
Datum | Titel | Kategorie | Beschreibung
```

| Datum | Bedeutung |
| --- | --- |
| `1517` | Jahr |
| `31.10.1517` oder `9. November 1918` | genauer Tag |
| `September 1522` | Monat |
| `1618–1648`, `1618-1648` oder `1618 bis 1648` | Zeitraum (Balken) |
| `44 v. Chr.` | vor Christus. Ein Jahr 0 gibt es nicht. |
| `7–4 v. Chr.` | Zeitraum vor Christus |
| `um 1450` oder `ca. 1450` | ungefähre Angabe |
| `1949–heute` | bis zum heutigen Tag |
| `# Notiz` | Kommentar, erscheint nicht im Zeitstrahl |

Feste Farben haben die Kategorien Politik, Religion, Kultur, Technik, Wirtschaft, Gesellschaft, Personen und Epoche. Eigene Kategorien bekommen automatisch eine freie Farbe.

Übernommene Schülerbeiträge tragen Zusatzangaben in geschweiften Klammern: `{von:Lena}` `{quelle:Wikimedia Commons}` `{bild:b1k9x}`.

## Datenschutz

- **Keine Cloud, keine Konten:** Der Server läuft nur auf dem Laptop und nur, solange das Fenster offen ist.
- **Daten im Ordner `daten/`:**
  - `eingang/`: noch nicht geprüfte Beiträge
  - `archiv/`: geprüfte Beiträge
  - `sicherung.json`: die Zeitstrahlen

  Nach Abschluss einer Unterrichtseinheit können `eingang/` und `archiv/` gelöscht werden.
- **Nur Vornamen:** Die Schülerseite fragt ausschließlich nach Vornamen.
- **Getrennte Zugänge:** Lehrkraft-Ansicht, Eingang und Sicherung sind nur am Laptop selbst erreichbar (`localhost`). Die iPads sehen ausschließlich die Beitragsseite und können nur senden, nichts lesen.
- **Keine externen Verbindungen:** Die Schriften liegen im Ordner `fonts/`, es wird nichts aus dem Internet geladen.
- **Nicht ins Repository:** Der Ordner `daten/` ist in `.gitignore` eingetragen und landet nie auf GitHub.

## Aufbau (auch für den Informatikunterricht)

```
server.js            Klassenserver (Node.js, ohne Zusatzpakete)
einstellungen.txt    Port des Servers
index.html           Lehrkraft-Ansicht
beitrag.html         Schülerseite
css/                 Gestaltung, lokale Schriften
fonts/               Alegreya, Atkinson Hyperlegible, IBM Plex Mono (SIL Open Font License)
js/parser.js         Text → Einträge: Datumsformate, v. Chr., Zeiträume, Kategorien
js/layout.js         Einträge → Positionen: Skala, Spuren gegen Überlappung, SVG
js/bild.js           Bilder im Browser verkleinern (höchstens 1000 px)
js/app.js            Lehrkraft-Ansicht
js/beitrag.js        Schülerseite
js/beispiele.js      Beispiel-Zeitstrahlen
js/vendor/qrcode.js  QR-Code-Erzeugung (Kazuhiko Arase, MIT-Lizenz)
tests/               node tests/parser.test.js
```

Mögliche Anknüpfungspunkte im Unterricht:

- **Client und Server:** Was schickt das iPad an `/api/beitraege`? Warum darf nur `localhost` den Eingang lesen?
- **Parser und reguläre Ausdrücke:** Wie erkennt `parseDate()` „9. November 1918“? Welche Eingaben scheitern?
- **Zeitrechnung ohne Jahr 0:** Intern zählt der Parser „astronomisch“ (1 v. Chr. = 0). Warum ist das praktisch?
- **Greedy-Algorithmus:** `layout()` verteilt Beschriftungen auf Spuren, damit sich nichts überlappt.
- **Testen:** Neue Testfälle in `tests/parser.test.js` schreiben, z. B. für Jahrhunderte („15. Jh.“) als Erweiterung.

## Beispiele

Beim ersten Start sind drei Beispiele geladen: Reformation und Konfessionalisierung, Weimarer Republik sowie Kirchengeschichte im Überblick (mit Daten vor Christus). Über **Datei → Beispiele hinzufügen** lassen sie sich jederzeit wieder einfügen.
