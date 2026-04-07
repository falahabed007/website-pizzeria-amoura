# 🥙 ATAS Döner & Pizza Beckum – Setup Anleitung

## Projektdateien

| Datei | Beschreibung |
|---|---|
| `atas-doener-pizza.html` | Speisekarte + Checkout (Kundenwebseite) |
| `atas-admin.html` | Admin Dashboard für den Wirt |
| `server.js` | Backend (Node.js/Express/MongoDB) |
| `printnode-helper.js` | Bondrucker-Logik (ESC/POS) |
| `package.json` | Node.js Abhängigkeiten |
| `.env.example` | Vorlage für Umgebungsvariablen |
| `.gitignore` | Schützt .env vor GitHub |

---

## Schritt 1 – GitHub Repository erstellen

1. Gehe auf **github.com** → New Repository
2. Name: `atas-doener-pizza`
3. Sichtbarkeit: **Privat**
4. `.gitignore`: Node auswählen
5. „Repository erstellen" klicken
6. Alle Dateien hochladen (**OHNE `.env`!**):
   - `atas-doener-pizza.html`
   - `atas-admin.html`
   - `server.js`
   - `printnode-helper.js`
   - `package.json`
   - `.env.example`
   - `.gitignore`
   - `SETUP.md`

---

## Schritt 2 – MongoDB Atlas

1. **mongodb.com/atlas** → Kostenlos registrieren (einmalig)
2. Cluster0 → „Browse Collections" → „Add My Own Data"
3. Database Name: `atas-doener`
4. Collection Name: `orders`
5. „Create" klicken
6. Connection String holen:
   - Cluster0 → „Connect" → „Drivers"
   - Node.js Version wählen
   - String kopieren: `mongodb+srv://...`
   - `/atas-doener` am Ende eintragen

---

## Schritt 3 – Stripe einrichten

1. **stripe.com** → Registrieren (Konto des Restaurants)
2. Dashboard → Entwickler → **API-Schlüssel**
   - `pk_live_...` → in `atas-doener-pizza.html` eintragen (STRIPE_PK)
   - `sk_live_...` → in Render als `STRIPE_SECRET_KEY`
3. Dashboard → Entwickler → **Webhooks** → „Endpunkt hinzufügen"
   - URL: `https://atas-backend.onrender.com/api/stripe-webhook`
   - Events: `checkout.session.completed` + `checkout.session.expired`
   - Webhook Secret `whsec_...` → in Render als `STRIPE_WEBHOOK_SECRET`

> ⚠️ Stripe berechnet: 1,5 % + 0,25 € pro Kartenzahlung.

---

## Schritt 4 – Resend (E-Mail) einrichten

1. **resend.com** → Kostenlos registrieren (3.000 E-Mails/Monat gratis)
2. API Key erstellen → in Render als `RESEND_API_KEY`
3. Domain verifizieren (z.B. `atas-beckum.de`) oder Testdomain nutzen
4. `EMAIL_FROM` = z.B. `bestellungen@atas-beckum.de`
5. `RESTAURANT_EMAIL` = E-Mail des Wirts für Kopie jeder Bestellung

---

## Schritt 5 – Render Web Service (Backend)

1. **render.com** → New → Web Service
2. GitHub verbinden → `atas-doener-pizza` auswählen
3. Einstellungen:
   - **Name**: `atas-backend`
   - **Language**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
   - **Health Check Path**: `/api/health`
4. Environment Variables eintragen:

| Variable | Wert |
|---|---|
| `MONGODB_URI` | Von MongoDB Atlas (`/atas-doener` am Ende!) |
| `STRIPE_SECRET_KEY` | Von stripe.com |
| `STRIPE_WEBHOOK_SECRET` | Von stripe.com Webhooks |
| `RESEND_API_KEY` | Von resend.com |
| `EMAIL_FROM` | z.B. bestellungen@atas-beckum.de |
| `RESTAURANT_EMAIL` | E-Mail des Wirts |
| `PRINTNODE_API_KEY` | Von printnode.com (optional) |
| `PRINTNODE_PRINTER_ID` | Von printnode.com (optional) |
| `ADMIN_PASSWORD` | Passwort für den Wirt (mind. 12 Zeichen) |
| `ADMIN_TOKEN_SECRET` | Geheimer Token (mind. 40 Zeichen, zufällig) |
| `WHATSAPP_NUMBER` | z.B. `4915123456789` |
| `FRONTEND_URL` | URL der Speisekarte (nach Deploy eintragen) |
| `PORT` | `3001` |

5. „Deploy Web Service" klicken
6. Warten bis „Live" erscheint (~3 Minuten)
7. Testen: `https://atas-backend.onrender.com/api/health` → muss `{"status":"ok"}` zeigen

---

## Schritt 6 – Render Static Site (Speisekarte)

1. render.com → New → **Static Site**
2. Gleiches GitHub Repository auswählen
3. Einstellungen:
   - **Publish Directory**: `.` (Punkt)
   - **Build Command**: leer lassen
4. „Deploy" klicken
5. Nach dem Deploy: URL in `FRONTEND_URL` in Render eintragen

---

## Schritt 7 – atas-admin.html anpassen

Diese 3 Zeilen in `atas-admin.html` ändern (ganz unten im `<script>`-Block):

```javascript
const API_BASE           = 'https://atas-backend.onrender.com/api';
const DASHBOARD_PASSWORD = 'DEIN_ADMIN_PASSWORT';       // mind. 12 Zeichen
const ADMIN_API_TOKEN    = 'DEIN_GEHEIMER_TOKEN';        // mind. 40 Zeichen, zufällig
```

> ⚠️ Niemals echte Passwörter oder Tokens in diese Datei eintragen – diese Datei liegt auf GitHub!

Und in `atas-doener-pizza.html` den Stripe Public Key eintragen:
```javascript
const STRIPE_PK = 'pk_live_DEIN_STRIPE_KEY';
const API_BASE  = 'https://atas-backend.onrender.com/api';
```

> ⚠️ `ADMIN_API_TOKEN` muss **exakt gleich** sein wie `ADMIN_TOKEN_SECRET` in Render!

---

## Schritt 8 – Test

1. Speisekarte öffnen → Artikel in Warenkorb
2. Checkout → Barzahlung aufgeben
3. `atas-admin.html` öffnen → Bestellung erscheint mit Alarm-Ton
4. Bestellung annehmen (Zeit wählen) → E-Mail prüfen
5. Test-Storno: Ablehnen mit Grund → Storno-E-Mail prüfen (bei Stripe-Zahlung wird Betrag automatisch zurückerstattet)
6. Speisekarte-Tab im Dashboard → Artikel ausschalten → Website neu laden

---

## Schritt 9 – PrintNode Bondrucker (optional)

1. **printnode.com** → Kostenlos registrieren
2. API Key erstellen → in Render als `PRINTNODE_API_KEY`
3. PrintNode Client-Software auf PC/Laptop im Restaurant installieren
4. Mit PrintNode Account anmelden → Drucker wird automatisch erkannt
5. Drucker-ID im Dashboard ablesen → in Render als `PRINTNODE_PRINTER_ID`

**Empfohlene Drucker:**
- Epson TM-T20III (~150 €) – USB oder LAN
- Epson TM-T88VII (~300 €) – USB, LAN, Bluetooth

---

## Kosten-Übersicht

| Dienst | Kostenlos bis | Dann |
|---|---|---|
| MongoDB Atlas | 512 MB | ab 9 $/Monat |
| Render | 750h/Monat | ab 7 $/Monat |
| Resend | 3.000 E-Mails/Monat | ab 20 $/Monat |
| PrintNode | 50 Prints/Monat | ab 9 $/Monat |
| Stripe | Kostenlos | 1,5 % + 0,25 € / Zahlung |

> ✅ Start komplett kostenlos möglich!

---

## Häufige Fehler

**Backend startet nicht:**
→ `MONGODB_URI` prüfen – `/atas-doener` am Ende eintragen

**Login im Dashboard funktioniert nicht:**
→ `ADMIN_TOKEN_SECRET` in Render muss gleich sein wie `ADMIN_API_TOKEN` in `atas-admin.html`

**Stripe Webhook funktioniert nicht:**
→ URL in Stripe: `https://atas-backend.onrender.com/api/stripe-webhook`
→ Event `checkout.session.completed` aktivieren

**E-Mails kommen nicht an:**
→ Domain bei Resend verifizieren
→ `EMAIL_FROM` muss verifizierte Domain nutzen

**WhatsApp-Button erscheint nicht:**
→ `WHATSAPP_NUMBER` in Render eintragen (Format: `4915123456789`)

---

*ATAS Döner & Pizza · Nordstr. 45a · 59269 Beckum*
