# Fluevate Website – Assets

Hier liegen die Medien der Website. Platzhalter werden automatisch genutzt,
solange die echten Dateien fehlen – einfach mit gleichem Dateinamen ablegen.

## Logo
- **`fluevate-logo.png`** – das echte Logo (grüner Schriftzug auf transparentem/weißem Grund).
  Solange diese Datei fehlt, rendert die Seite den Schriftzug automatisch als
  eleganten CSS-Serif-Wordmark in Markengrün. Sobald die PNG hier liegt, wird sie
  im Header angezeigt. Empfohlen: PNG mit transparentem Hintergrund, Höhe ≥ 200 px.

## Portrait (Über-mich / Werdegang)
- **`abed-portrait.jpg`** – Foto von Abed Rachman Falah für die „Über mich"-Sektion.
  Solange es fehlt, zeigt die Sektion einen Initialen-Platzhalter. Empfohlen: Hochformat (4:5).

## Videos (Platzhalter zum Späterfüllen)
Lege MP4-Dateien mit diesen Namen ab – die Video-Bereiche schalten dann automatisch
vom Platzhalter auf das echte Video um (`<video>`-Quellen sind bereits eingebaut,
nur auskommentiert/markiert in `index.html`):
- `video-hero.mp4` – kurzer Stimmungsclip im Hero (Loop, stumm)
- `video-speisekarten.mp4` – Speisekarten / Druck
- `video-voicebot.mp4` – VoiceBot / Telefon-KI
- `video-webseite.mp4` – Website + Bestellsystem

Optional Poster-Standbilder (werden vor dem Abspielen gezeigt):
- `poster-hero.jpg`, `poster-speisekarten.jpg`, `poster-voicebot.jpg`, `poster-webseite.jpg`

## Vorher / Nachher (Speisekarten – später)
Für die Vorher/Nachher-Galerie:
- `speisekarte-vorher-1.jpg`, `speisekarte-nachher-1.jpg`
- `speisekarte-vorher-2.jpg`, `speisekarte-nachher-2.jpg`

Die Stellen sind in `index.html` mit `<!-- SLOT: ... -->` klar markiert.
