// ═══════════════════════════════════════════════════════════════
// STRIPE DIRECT CHARGES (Abed, 15.11.2026)
// ═══════════════════════════════════════════════════════════════
// Bisher entsteht jede Online-Zahlung auf dem FlueVate-Plattformkonto und wird
// per transfer_data an das Connect-Konto des Ladens weitergereicht; FlueVate
// behaelt dabei Servicegebuehr und eine geschaetzte Stripe-Gebuehr ein
// ("Destination Charge").
//
// Neu: Der Laden hat ein eigenes Stripe-Konto mit vollem Dashboard
// (STRIPE_DIREKT_KONTO). Die Zahlung entsteht direkt dort ("Direct Charge",
// Option { stripeAccount }), ohne application_fee_amount und ohne
// transfer_data. Stripe zieht seine Gebuehr beim Laden selbst ab. FlueVate
// nimmt nichts aus der Zahlung und rechnet Servicegebuehr und Grundgebuehr per
// Rechnung und SEPA-Lastschrift ab (ausserhalb dieses Repos).
//
// Ohne STRIPE_DIREKT_KONTO bleibt alles wie bisher. Dieses Modul enthaelt nur,
// was sich ohne Express, Mongoose und Stripe rechnen laesst, damit es Tests ohne
// node_modules gibt (node --test). Einzige Abhaengigkeit ist Nodes eigenes crypto.

const crypto = require('crypto');

// ─── Stichtag (STRIPE_DIREKT_AB, JJJJ-MM-TT, Europe/Berlin) ──────

// Abstand Berliner Ortszeit zu UTC in Millisekunden fuer einen Zeitpunkt.
function berlinVersatzMs(zeitpunktMs) {
  const teile = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(zeitpunktMs));
  const w = {};
  for (const t of teile) if (t.type !== 'literal') w[t.type] = Number(t.value);
  const alsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return alsUtc - Math.floor(zeitpunktMs / 1000) * 1000;
}

// "2026-12-01" -> Zeitpunkt 01.12.2026 00:00 in Berlin (als Date), sonst null.
// Leere Angabe -> undefined (kein Stichtag). Ungueltige Angabe -> null.
function stichtagAusText(text) {
  if (text === undefined || text === null || String(text).trim() === '') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const j = Number(m[1]), mo = Number(m[2]), t = Number(m[3]);
  const mitternachtUtc = Date.UTC(j, mo - 1, t);
  const probe = new Date(mitternachtUtc);
  // 2026-02-31 o. Ae. nicht still in den Maerz rollen lassen
  if (probe.getUTCFullYear() !== j || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== t) return null;
  // Mitternacht liegt in Berlin nie in einer Zeitumstellung (die ist um 2 bzw. 3 Uhr),
  // der Versatz am Vortag-Abend UTC ist also der richtige. Zur Sicherheit zweimal angleichen.
  let ms = mitternachtUtc - berlinVersatzMs(mitternachtUtc);
  ms = mitternachtUtc - berlinVersatzMs(ms);
  return new Date(ms);
}

// true: Stichtag erreicht oder keiner gesetzt. false: noch nicht erreicht oder ungueltig.
function stichtagErreicht(ab, jetzt = new Date()) {
  const s = stichtagAusText(ab);
  if (s === undefined) return true;
  if (s === null) return false;   // Tippfehler im Datum: lieber der alte Weg als ein falscher Start
  return jetzt.getTime() >= s.getTime();
}

// ─── Konto bereit? (charges_enabled, mit Zwischenspeicher) ───────

// Liefert eine Funktion istBereit(konto) -> Promise<boolean>. Sie fragt hoechstens
// alle `ttlMs` bei Stripe nach (Fehler: alle `fehlerTtlMs`), wartet nie laenger als
// `zeitlimitMs` und wirft nie: Jeder Fehler heisst "nicht bereit", also alter Weg.
// `abrufen(konto)` muss true liefern, wenn charges_enabled === true ist.
function erstelleKontoPruefer({ abrufen, ttlMs = 5 * 60 * 1000, fehlerTtlMs = 60 * 1000,
                                zeitlimitMs = 4000, uhr = () => Date.now(), melden = () => {} }) {
  let speicher = null;   // { konto, bereit, bis }
  let laufend  = null;   // { konto, promise } - gleichzeitige Bestellungen teilen sich eine Abfrage

  async function frageStripe(konto) {
    let timer;
    try {
      const ergebnis = await Promise.race([
        Promise.resolve().then(() => abrufen(konto)),
        new Promise((_, nein) => { timer = setTimeout(() => nein(new Error('Zeitlimit')), zeitlimitMs); }),
      ]);
      const bereit = ergebnis === true;
      speicher = { konto, bereit, bis: uhr() + ttlMs };
      return bereit;
    } catch (e) {
      melden(e);
      speicher = { konto, bereit: false, bis: uhr() + fehlerTtlMs };
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function istBereit(konto) {
    if (!konto) return false;
    if (speicher && speicher.konto === konto && uhr() < speicher.bis) return speicher.bereit;
    if (laufend && laufend.konto === konto) return laufend.promise;
    const promise = frageStripe(konto);
    laufend = { konto, promise };
    try { return await promise; } finally { if (laufend && laufend.promise === promise) laufend = null; }
  }
  // Nach einem gescheiterten Direct-Checkout sofort wieder fragen statt 5 Minuten weiter zu versuchen.
  istBereit.vergessen = () => { speicher = null; };
  istBereit.alsNichtBereitMerken = konto => { speicher = { konto, bereit: false, bis: uhr() + fehlerTtlMs }; };
  return istBereit;
}

// Entscheidung fuer einen Checkout: das Direktkonto (acct_...) oder null fuer den alten Weg.
// Fragt Stripe nur, wenn ein Konto gesetzt und der Stichtag erreicht ist. Wirft nie.
async function direktKontoWaehlen({ konto, ab, jetzt = new Date(), istBereit }) {
  try {
    if (!konto) return null;
    if (!stichtagErreicht(ab, jetzt)) return null;
    return (await istBereit(konto)) === true ? konto : null;
  } catch {
    return null;
  }
}

// ─── Webhook ─────────────────────────────────────────────────────

// Prueft die Signatur nacheinander mit jedem Geheimnis. Das erste wird immer
// versucht (auch leer, damit der Fehler ohne neue Variablen derselbe bleibt wie
// bisher), weitere nur, wenn gesetzt. Scheitern alle, fliegt der erste Fehler.
// `konstruiere(geheimnis)` ist stripe.webhooks.constructEvent mit festem Body.
function webhookEreignisPruefen(konstruiere, geheimnisse) {
  const [erstes, ...weitere] = geheimnisse;
  try {
    return konstruiere(erstes);
  } catch (ersterFehler) {
    for (const g of weitere) {
      if (!g) continue;
      try { return konstruiere(g); } catch { /* naechstes */ }
    }
    throw ersterFehler;
  }
}

// Ereignisse eines verbundenen Kontos tragen oben `account`. Der Connect-Endpunkt
// bekommt die Ereignisse ALLER Laeden der Plattform, verarbeitet wird nur das eigene
// Direktkonto. Plattform-Ereignisse (ohne `account`) laufen wie bisher.
function ereignisFuerUns(event, direktKonto) {
  if (!event || !event.account) return true;
  return !!direktKonto && event.account === direktKonto;
}

// ─── Echte Stripe-Gebuehr ────────────────────────────────────────

// Aus einem PaymentIntent mit expand ['latest_charge.balance_transaction'] die
// Gebuehr in Cent. null, solange Stripe sie noch nicht kennt.
function gebuehrCentAusPaymentIntent(pi) {
  const bt = pi && pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge.balance_transaction : null;
  const fee = bt && typeof bt === 'object' ? bt.fee : undefined;
  return Number.isInteger(fee) && fee >= 0 ? fee : null;
}

// ─── Abrechnung ──────────────────────────────────────────────────

const istDirektBestellung = o => !!o && o.payment === 'stripe' && !!o.stripeAccount;

// Die Pauschale, die der alte Checkout je Online-Zahlung einbehaelt (1,5 % + 0,25 €).
const stripePauschale = o => Math.round(((o.total || 0) * 0.015 + 0.25) * 100) / 100;

// Abrechnung fuer Wochen- und Monatsbericht. Der erste Teil ist die bisherige
// Rechnung unveraendert, angewandt auf alle Bestellungen ausser den Direct-
// Bestellungen. Ohne Direct-Bestellungen ist das Ergebnis also centgenau das alte.
//
// Direct-Bestellungen kommen getrennt dazu: Ihr Umsatz landet vollstaendig auf dem
// eigenen Stripe-Konto des Ladens, Stripe zieht dort seine echte Gebuehr ab (nur
// gespeicherte Werte, nichts geschaetzt), und die FlueVate-Servicegebuehr wird per
// Rechnung und SEPA-Lastschrift eingezogen, nicht von der Auszahlung abgezogen.
//
// fix: { sv, grund, domain } - Standard-Servicegebuehr, Grundgebuehr, Domain.
function berichtAbrechnung(orders, mitFixkosten, fix) {
  const { sv, grund, domain } = fix;
  const alle   = orders;
  const direkt = alle.filter(istDirektBestellung);
  orders       = direkt.length ? alle.filter(o => !istDirektBestellung(o)) : alle;

  // ── unveraendert seit 01.11.2026 ──
  const summe  = (liste, f) => Math.round(liste.reduce((s, o) => s + f(o), 0) * 100) / 100;
  const online = orders.filter(o => o.payment === 'stripe');
  const laden  = orders.filter(o => o.payment !== 'stripe');
  const a = {
    n: orders.length, nOnline: online.length, nLaden: laden.length,
    umsatzOnline: summe(online, o => o.total || 0), umsatzLaden: summe(laden, o => o.total || 0),
    svc: summe(orders, o => o.serviceFee || sv), stripeGeb: summe(online, stripePauschale),
    grund: mitFixkosten ? grund : 0, domain: mitFixkosten ? domain : 0,
  };
  a.brutto    = a.umsatzOnline + a.umsatzLaden;
  a.fluevate  = a.grund + a.domain + a.svc;
  a.gebuehren = a.fluevate + a.stripeGeb;
  a.bleibt    = a.brutto - a.gebuehren;
  const rest  = Math.round((a.umsatzOnline - a.stripeGeb - a.fluevate) * 100) / 100;
  a.ueberweisung = Math.max(0, rest);
  a.offen        = Math.max(0, -rest);
  // ── Ende alte Rechnung ──

  a.nDirekt = direkt.length;
  if (!direkt.length) return a;

  const bekannt = direkt.filter(o => Number.isInteger(o.stripeGebuehrCent) && o.stripeGebuehrCent >= 0);
  a.umsatzDirekt         = summe(direkt, o => o.total || 0);
  a.svcDirekt            = summe(direkt, o => o.serviceFee || sv);
  a.stripeGebDirekt      = Math.round(bekannt.reduce((s, o) => s + o.stripeGebuehrCent, 0)) / 100;
  a.nStripeGebUnbekannt  = direkt.length - bekannt.length;
  a.verbleibtDirekt      = Math.round((a.umsatzDirekt - a.stripeGebDirekt) * 100) / 100;
  a.brutto   += a.umsatzDirekt;
  a.bleibt   += a.umsatzDirekt - a.stripeGebDirekt - a.svcDirekt;
  return a;
}

// ─── Hilfen ──────────────────────────────────────────────────────

// Zeitkonstanter Vergleich (wie gleichSicher in Nordkirchen): ein normales ===
// verraet ueber die Laufzeit, wie viele Zeichen am Anfang schon stimmen.
function gleichSicher(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  stichtagAusText, stichtagErreicht, erstelleKontoPruefer, direktKontoWaehlen,
  webhookEreignisPruefen, ereignisFuerUns, gebuehrCentAusPaymentIntent,
  istDirektBestellung, stripePauschale, berichtAbrechnung, gleichSicher,
};
