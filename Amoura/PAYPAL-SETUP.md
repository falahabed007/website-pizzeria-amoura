# PayPal-Setup (Amoura)

PayPal läuft **zusätzlich** zu Stripe und stört es nicht (eigene ENV-Keys, eigene
Endpunkte, eigene Webhook-Route). Modell: Standard-PayPal-Checkout (Orders v2),
ein PayPal-Empfängerkonto.

## 1. Neue ENV-Variablen
In `Amoura/.env` (lokal) **und** in Render (Service-ENV) ergänzen:

```
PAYPAL_CLIENT_ID=...        # developer.paypal.com → App → Client ID
PAYPAL_CLIENT_SECRET=...    # developer.paypal.com → App → Secret
PAYPAL_WEBHOOK_ID=...       # Webhook-ID aus dem PayPal-Dashboard
PAYPAL_ENV=sandbox          # zum Testen "sandbox", live dann "live"
```

`.env` ist bereits in `.gitignore` → Keys nie committen.

## 2. PayPal-Dashboard
1. developer.paypal.com → **Apps & Credentials** → App anlegen → Client ID + Secret.
2. **Webhooks** → URL `https://pizzeria-amoura.de/api/paypal-webhook` hinzufügen,
   Events abonnieren: `PAYMENT.CAPTURE.COMPLETED`, `CHECKOUT.ORDER.APPROVED`
   → die generierte **Webhook-ID** als `PAYPAL_WEBHOOK_ID` setzen.
3. Sandbox: unter **Testing Tools → Sandbox Accounts** einen Käufer-Testaccount nutzen.

## 3. Was im Code passiert (Übersicht)
- `server.js`
  - Helper `getPaypalAccessToken()` / `paypalApi()` (REST v2, lazy)
  - `POST /api/create-paypal-order` → erstellt PayPal-Order, gibt Approval-URL zurück
  - `POST /api/paypal-capture` → zieht nach Rückkehr die Zahlung ein (Fallback/Primär)
  - `POST /api/paypal-webhook` → Signatur-Verifizierung + Capture-Bestätigung
  - Order-Schema: `paypalOrderId`, `paypalCaptureId`
  - Storno-Endpunkt `DELETE /api/admin/orders/:id`: Auto-Refund auch für PayPal
- `index.html`
  - Zahlart "💙 Online bezahlen (PayPal)" + Logo
  - Redirect über die bestehende `redirectToOnlinePayment()`-Funktion
  - Rückkehr-Capture via `?paypal=1&token=<orderId>`

## 4. Testen (Sandbox)
1. `PAYPAL_ENV=sandbox` + Sandbox-Keys setzen, Server starten.
2. Im Frontend "PayPal" wählen → durchbezahlen (Sandbox-Käufer).
3. Order erscheint im Dashboard unter Online/PayPal, Status `paid`/`pending`.
4. Storno im Admin → Refund in Sandbox sichtbar, Status `refunded`.
5. Stripe-Bestellung gegentesten (Regression) → unverändert.
6. Dann `PAYPAL_ENV=live` + Live-Keys in Render, eine echte Klein-Bestellung testen.

## Phase 2 (später) — "PayPal Connect"-Pendant
Geld direkt ans Restaurant + Plattformgebühr für FlueVate (Gegenstück zu
`STRIPE_CONNECT_ACCOUNT`) braucht die **PayPal-Partner-Freischaltung** (PayPal Complete
Payments für Plattformen/Marktplätze, kein Self-Service). Dann: Restaurant-Onboarding per
Partner Referrals API, `PAYPAL_MERCHANT_ID` pro Restaurant, und in `create-paypal-order`
`purchase_units[].payee.merchant_id` + `payment_instruction.platform_fees` setzen.
