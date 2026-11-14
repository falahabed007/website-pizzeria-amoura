// Tests fuer stripe-direkt.js - laufen ohne node_modules: node --test
const test   = require('node:test');
const assert = require('node:assert/strict');
const sd     = require('./stripe-direkt');

const FIX = { sv: 0.99, grund: 150, domain: 20 };

// ─── Stichtag ────────────────────────────────────────────────────

test('Stichtag: Winterzeit, 00:00 Berlin ist 23:00 UTC am Vortag', () => {
  assert.equal(sd.stichtagAusText('2026-12-01').toISOString(), '2026-11-30T23:00:00.000Z');
});

test('Stichtag: Sommerzeit, 00:00 Berlin ist 22:00 UTC am Vortag', () => {
  assert.equal(sd.stichtagAusText('2026-07-01').toISOString(), '2026-06-30T22:00:00.000Z');
});

test('Stichtag: Tage der Zeitumstellung (29.03. und 25.10.2026)', () => {
  // Umstellung erst um 2 bzw. 3 Uhr: Mitternacht gilt noch die alte Zeit
  assert.equal(sd.stichtagAusText('2026-03-29').toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(sd.stichtagAusText('2026-03-30').toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(sd.stichtagAusText('2026-10-25').toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(sd.stichtagAusText('2026-10-26').toISOString(), '2026-10-25T23:00:00.000Z');
});

test('Stichtag: leer heisst kein Stichtag, Unsinn heisst ungueltig', () => {
  assert.equal(sd.stichtagAusText(undefined), undefined);
  assert.equal(sd.stichtagAusText(''), undefined);
  assert.equal(sd.stichtagAusText('  '), undefined);
  for (const x of ['01.12.2026', '2026-2-1', '2026-02-31', '2026-13-01', 'morgen', '2026-12-01T00:00']) {
    assert.equal(sd.stichtagAusText(x), null, x);
  }
});

test('stichtagErreicht: genau an der Grenze, Winter und Sommer', () => {
  assert.equal(sd.stichtagErreicht('2026-12-01', new Date('2026-11-30T22:59:59.999Z')), false);
  assert.equal(sd.stichtagErreicht('2026-12-01', new Date('2026-11-30T23:00:00.000Z')), true);
  assert.equal(sd.stichtagErreicht('2026-07-01', new Date('2026-06-30T21:59:59.999Z')), false);
  assert.equal(sd.stichtagErreicht('2026-07-01', new Date('2026-06-30T22:00:00.000Z')), true);
  assert.equal(sd.stichtagErreicht(undefined, new Date(0)), true);
  assert.equal(sd.stichtagErreicht('kaputt', new Date('2099-01-01')), false);
});

// ─── Entscheidung direkt oder alt ───────────────────────────────

const bereit    = async () => true;
const nicht     = async () => false;
const kaputt    = async () => { throw new Error('Stripe weg'); };

test('direktKontoWaehlen: ohne Konto immer alter Weg, Stripe wird nicht gefragt', async () => {
  let gefragt = 0;
  const r = await sd.direktKontoWaehlen({ konto: undefined, istBereit: async () => { gefragt++; return true; } });
  assert.equal(r, null);
  assert.equal(gefragt, 0);
});

test('direktKontoWaehlen: Konto bereit und kein Stichtag -> direkt', async () => {
  assert.equal(await sd.direktKontoWaehlen({ konto: 'acct_1', istBereit: bereit }), 'acct_1');
});

test('direktKontoWaehlen: Konto nicht bereit oder Fehler -> alter Weg', async () => {
  assert.equal(await sd.direktKontoWaehlen({ konto: 'acct_1', istBereit: nicht }), null);
  assert.equal(await sd.direktKontoWaehlen({ konto: 'acct_1', istBereit: kaputt }), null);
});

test('direktKontoWaehlen: vor dem Stichtag alter Weg, ohne Stripe zu fragen', async () => {
  let gefragt = 0;
  const istBereit = async () => { gefragt++; return true; };
  const vorher  = await sd.direktKontoWaehlen({ konto: 'acct_1', ab: '2026-12-01', jetzt: new Date('2026-11-30T22:30:00Z'), istBereit });
  assert.equal(vorher, null);
  assert.equal(gefragt, 0);
  const danach  = await sd.direktKontoWaehlen({ konto: 'acct_1', ab: '2026-12-01', jetzt: new Date('2026-11-30T23:00:00Z'), istBereit });
  assert.equal(danach, 'acct_1');
  assert.equal(await sd.direktKontoWaehlen({ konto: 'acct_1', ab: '1.12.', istBereit }), null);
});

// ─── Zwischenspeicher fuer charges_enabled ──────────────────────

test('Kontopruefer: speichert das Ergebnis und fragt erst nach Ablauf neu', async () => {
  let jetzt = 0, aufrufe = 0, antwort = true;
  const istBereit = sd.erstelleKontoPruefer({ abrufen: async () => { aufrufe++; return antwort; }, ttlMs: 1000, uhr: () => jetzt });
  assert.equal(await istBereit('acct_1'), true);
  antwort = false;
  jetzt = 999;
  assert.equal(await istBereit('acct_1'), true);
  assert.equal(aufrufe, 1);
  jetzt = 1000;
  assert.equal(await istBereit('acct_1'), false);
  assert.equal(aufrufe, 2);
});

test('Kontopruefer: anderes Konto wird neu gefragt', async () => {
  let aufrufe = 0;
  const istBereit = sd.erstelleKontoPruefer({ abrufen: async k => { aufrufe++; return k === 'acct_a'; }, uhr: () => 0 });
  assert.equal(await istBereit('acct_a'), true);
  assert.equal(await istBereit('acct_b'), false);
  assert.equal(aufrufe, 2);
});

test('Kontopruefer: Fehler heisst nicht bereit, kurz gespeichert, nie geworfen', async () => {
  let jetzt = 0, aufrufe = 0, gemeldet = 0;
  const istBereit = sd.erstelleKontoPruefer({
    abrufen: async () => { aufrufe++; throw new Error('weg'); },
    ttlMs: 10000, fehlerTtlMs: 100, uhr: () => jetzt, melden: () => gemeldet++,
  });
  assert.equal(await istBereit('acct_1'), false);
  assert.equal(await istBereit('acct_1'), false);
  assert.equal(aufrufe, 1);
  jetzt = 100;
  assert.equal(await istBereit('acct_1'), false);
  assert.equal(aufrufe, 2);
  assert.equal(gemeldet, 2);
});

test('Kontopruefer: synchroner Wurf in abrufen ist auch nur "nicht bereit"', async () => {
  const istBereit = sd.erstelleKontoPruefer({ abrufen: () => { throw new Error('kein Schluessel'); } });
  assert.equal(await istBereit('acct_1'), false);
});

test('Kontopruefer: nur charges_enabled === true zaehlt', async () => {
  for (const wert of [1, 'true', {}, undefined, null]) {
    const istBereit = sd.erstelleKontoPruefer({ abrufen: async () => wert });
    assert.equal(await istBereit('acct_1'), false, String(wert));
  }
});

test('Kontopruefer: haengende Abfrage endet nach dem Zeitlimit als "nicht bereit"', async () => {
  const istBereit = sd.erstelleKontoPruefer({ abrufen: () => new Promise(() => {}), zeitlimitMs: 20 });
  const start = Date.now();
  assert.equal(await istBereit('acct_1'), false);
  assert.ok(Date.now() - start < 1000);
});

test('Kontopruefer: gleichzeitige Bestellungen teilen sich eine Abfrage', async () => {
  let aufrufe = 0;
  const istBereit = sd.erstelleKontoPruefer({ abrufen: async () => { aufrufe++; await new Promise(r => setTimeout(r, 10)); return true; } });
  const r = await Promise.all([istBereit('acct_1'), istBereit('acct_1'), istBereit('acct_1')]);
  assert.deepEqual(r, [true, true, true]);
  assert.equal(aufrufe, 1);
});

test('Kontopruefer: alsNichtBereitMerken schaltet sofort auf den alten Weg', async () => {
  let jetzt = 0;
  const istBereit = sd.erstelleKontoPruefer({ abrufen: async () => true, fehlerTtlMs: 50, uhr: () => jetzt });
  assert.equal(await istBereit('acct_1'), true);
  istBereit.alsNichtBereitMerken('acct_1');
  assert.equal(await istBereit('acct_1'), false);
  jetzt = 50;
  assert.equal(await istBereit('acct_1'), true);
});

// ─── Webhook ─────────────────────────────────────────────────────

test('Webhook-Signatur: erstes Geheimnis passt', () => {
  const ev = sd.webhookEreignisPruefen(g => { if (g !== 'whsec_a') throw new Error('falsch'); return { id: 'evt' }; }, ['whsec_a', 'whsec_b']);
  assert.deepEqual(ev, { id: 'evt' });
});

test('Webhook-Signatur: Connect-Geheimnis als zweiter Versuch', () => {
  const versucht = [];
  const ev = sd.webhookEreignisPruefen(g => { versucht.push(g); if (g !== 'whsec_b') throw new Error('falsch ' + g); return { id: 'evt' }; }, ['whsec_a', 'whsec_b']);
  assert.deepEqual(ev, { id: 'evt' });
  assert.deepEqual(versucht, ['whsec_a', 'whsec_b']);
});

test('Webhook-Signatur: ohne Connect-Geheimnis genau ein Versuch, erster Fehler fliegt', () => {
  const versucht = [];
  assert.throws(() => sd.webhookEreignisPruefen(g => { versucht.push(g); throw new Error('falsch ' + g); }, ['whsec_a', undefined]), /falsch whsec_a/);
  assert.deepEqual(versucht, ['whsec_a']);
});

test('Webhook-Signatur: beide falsch -> Fehler des ersten', () => {
  assert.throws(() => sd.webhookEreignisPruefen(g => { throw new Error('falsch ' + g); }, ['whsec_a', 'whsec_b']), /falsch whsec_a/);
});

test('Webhook-Signatur: fehlendes Hauptgeheimnis wird wie bisher versucht', () => {
  const versucht = [];
  assert.throws(() => sd.webhookEreignisPruefen(g => { versucht.push(g); throw new Error('kein Geheimnis'); }, [undefined, undefined]), /kein Geheimnis/);
  assert.deepEqual(versucht, [undefined]);
});

test('Kontofilter: Plattform-Ereignisse immer, Kontoereignisse nur vom eigenen Direktkonto', () => {
  assert.equal(sd.ereignisFuerUns({ type: 'checkout.session.completed' }, undefined), true);
  assert.equal(sd.ereignisFuerUns({ type: 'x', account: null }, 'acct_eigen'), true);
  assert.equal(sd.ereignisFuerUns({ type: 'x', account: 'acct_eigen' }, 'acct_eigen'), true);
  assert.equal(sd.ereignisFuerUns({ type: 'x', account: 'acct_fremd' }, 'acct_eigen'), false);
  assert.equal(sd.ereignisFuerUns({ type: 'x', account: 'acct_fremd' }, undefined), false);
  assert.equal(sd.ereignisFuerUns({ type: 'x', account: 'acct_fremd' }, ''), false);
});

// ─── Echte Gebuehr ───────────────────────────────────────────────

test('gebuehrCentAusPaymentIntent', () => {
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: { balance_transaction: { fee: 58 } } }), 58);
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: { balance_transaction: { fee: 0 } } }), 0);
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: { balance_transaction: 'txn_1' } }), null);
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: { balance_transaction: null } }), null);
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: 'ch_1' }), null);
  assert.equal(sd.gebuehrCentAusPaymentIntent({}), null);
  assert.equal(sd.gebuehrCentAusPaymentIntent(null), null);
});

// ─── Abrechnung ──────────────────────────────────────────────────

// Wortgleiche Kopie der Rechnung aus server.js vor der Umstellung (Stand 26623fa).
// Ohne Direct-Bestellungen muss die neue Rechnung exakt dasselbe liefern.
const PDF_SV = 0.99, PDF_BASE = 150, PDF_DOMAIN = 20;
const altePauschale = o => Math.round(((o.total || 0) * 0.015 + 0.25) * 100) / 100;
function alteAbrechnung(orders, mitFixkosten) {
  const summe  = (liste, f) => Math.round(liste.reduce((s, o) => s + f(o), 0) * 100) / 100;
  const online = orders.filter(o => o.payment === 'stripe');
  const laden  = orders.filter(o => o.payment !== 'stripe');
  const a = {
    n: orders.length, nOnline: online.length, nLaden: laden.length,
    umsatzOnline: summe(online, o => o.total || 0), umsatzLaden: summe(laden, o => o.total || 0),
    svc: summe(orders, o => o.serviceFee || PDF_SV), stripeGeb: summe(online, altePauschale),
    grund: mitFixkosten ? PDF_BASE : 0, domain: mitFixkosten ? PDF_DOMAIN : 0,
  };
  a.brutto    = a.umsatzOnline + a.umsatzLaden;
  a.fluevate  = a.grund + a.domain + a.svc;
  a.gebuehren = a.fluevate + a.stripeGeb;
  a.bleibt    = a.brutto - a.gebuehren;
  const rest  = Math.round((a.umsatzOnline - a.stripeGeb - a.fluevate) * 100) / 100;
  a.ueberweisung = Math.max(0, rest);
  a.offen        = Math.max(0, -rest);
  return a;
}

// Deterministischer Zufall, damit ein Fehlschlag reproduzierbar ist
function zufall(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function bestellungen(r, n, { direktAnteil = 0 } = {}) {
  const arten = ['bar', 'stripe', 'paypal', 'karte'];
  return Array.from({ length: n }, () => {
    const payment = arten[Math.floor(r() * arten.length)];
    const o = { payment, total: Math.round((5 + r() * 80) * 100) / 100 };
    if (r() < 0.1) o.serviceFee = 0;           // 0 faellt wie bisher auf 0,99 zurueck
    else if (r() < 0.8) o.serviceFee = 0.99;
    if (r() < 0.05) delete o.total;
    if (payment === 'stripe' && r() < direktAnteil) {
      o.stripeAccount = 'acct_direkt';
      if (r() < 0.7) o.stripeGebuehrCent = Math.round((o.total || 0) * 1.5 + 25);
    }
    return o;
  });
}

test('Abrechnung ohne Direct-Bestellungen: centgenau wie bisher (500 Zufallsmonate)', () => {
  const r = zufall(42);
  for (let i = 0; i < 500; i++) {
    const orders = bestellungen(r, Math.floor(r() * 120));
    for (const fix of [true, false]) {
      const neu = sd.berichtAbrechnung(orders, fix, FIX);
      const alt = alteAbrechnung(orders, fix);
      assert.equal(neu.nDirekt, 0);
      delete neu.nDirekt;
      assert.deepEqual(neu, alt);   // strikt: gleiche Felder, gleiche Gleitkommawerte
    }
  }
});

test('Abrechnung: leerer Zeitraum wie bisher', () => {
  const neu = sd.berichtAbrechnung([], true, FIX);
  delete neu.nDirekt;
  assert.deepEqual(neu, alteAbrechnung([], true));
});

test('Abrechnung gemischter Monat: alte Bestellungen unveraendert, Direct getrennt', () => {
  const r = zufall(7);
  for (let i = 0; i < 300; i++) {
    const orders = bestellungen(r, 1 + Math.floor(r() * 120), { direktAnteil: 0.6 });
    const direkt = orders.filter(o => o.stripeAccount);
    const rest   = orders.filter(o => !o.stripeAccount);
    const a   = sd.berichtAbrechnung(orders, true, FIX);
    const alt = alteAbrechnung(rest, true);
    for (const k of ['n', 'nOnline', 'nLaden', 'umsatzOnline', 'umsatzLaden', 'svc', 'stripeGeb', 'grund', 'domain',
                     'fluevate', 'gebuehren', 'ueberweisung', 'offen']) {
      assert.equal(a[k], alt[k], k);
    }
    assert.equal(a.nDirekt, direkt.length);
    if (!direkt.length) continue;
    const cent = n => Math.round(n * 100);
    assert.equal(cent(a.umsatzDirekt), cent(direkt.reduce((s, o) => s + (o.total || 0), 0)));
    assert.equal(cent(a.svcDirekt), cent(direkt.reduce((s, o) => s + (o.serviceFee || 0.99), 0)));
    const bekannt = direkt.filter(o => o.stripeGebuehrCent !== undefined);
    assert.equal(cent(a.stripeGebDirekt), bekannt.reduce((s, o) => s + o.stripeGebuehrCent, 0));
    assert.equal(a.nStripeGebUnbekannt, direkt.length - bekannt.length);
    assert.equal(cent(a.brutto), cent(alt.brutto) + cent(a.umsatzDirekt));
    assert.equal(cent(a.bleibt), cent(alt.bleibt) + cent(a.umsatzDirekt) - cent(a.stripeGebDirekt) - cent(a.svcDirekt));
  }
});

test('Abrechnung Beispiel: ein Monat mit beiden Arten, von Hand nachgerechnet', () => {
  const orders = [
    { payment: 'bar',    total: 20.99, serviceFee: 0.99 },
    { payment: 'stripe', total: 30.99, serviceFee: 0.99 },                                   // alt
    { payment: 'stripe', total: 40.99, serviceFee: 0.99, stripeAccount: 'acct_d', stripeGebuehrCent: 86 },
    { payment: 'stripe', total: 10.99, serviceFee: 0.99, stripeAccount: 'acct_d' },          // Gebuehr noch unbekannt
  ];
  const a = sd.berichtAbrechnung(orders, true, FIX);
  // alter Teil: Bar 20,99 + Stripe 30,99; Pauschale 30,99*1,5% + 0,25 = 0,71
  assert.equal(a.n, 2); assert.equal(a.nOnline, 1); assert.equal(a.nLaden, 1);
  assert.equal(a.umsatzOnline, 30.99); assert.equal(a.umsatzLaden, 20.99);
  assert.equal(a.svc, 1.98); assert.equal(a.stripeGeb, 0.71);
  assert.equal(a.fluevate, 171.98);
  assert.equal(a.ueberweisung, 0);
  assert.equal(a.offen, 141.70);          // 171,98 + 0,71 - 30,99
  // Direct-Teil
  assert.equal(a.nDirekt, 2);
  assert.equal(a.umsatzDirekt, 51.98);
  assert.equal(a.svcDirekt, 1.98);
  assert.equal(a.stripeGebDirekt, 0.86);
  assert.equal(a.nStripeGebUnbekannt, 1);
  assert.equal(a.verbleibtDirekt, 51.12);
  assert.equal(a.brutto.toFixed(2), '103.96');
  // 103,96 - 171,98 - 0,71 - 0,86 - 1,98 = -71,57
  assert.equal(a.bleibt.toFixed(2), '-71.57');
});

test('Abrechnung: PayPal oder Bar mit stripeAccount zaehlt nicht als Direct', () => {
  const a = sd.berichtAbrechnung([{ payment: 'bar', total: 10, stripeAccount: 'acct_x' }], false, FIX);
  assert.equal(a.nDirekt, 0);
  assert.equal(a.nLaden, 1);
});

test('stripePauschale wie bisher', () => {
  assert.equal(sd.stripePauschale({ total: 30.99 }), 0.71);
  assert.equal(sd.stripePauschale({}), 0.25);
});

// ─── gleichSicher ────────────────────────────────────────────────

test('gleichSicher', () => {
  assert.equal(sd.gleichSicher('abc', 'abc'), true);
  assert.equal(sd.gleichSicher('abc', 'abd'), false);
  assert.equal(sd.gleichSicher('abc', 'abcd'), false);
  assert.equal(sd.gleichSicher('', 'abc'), false);
  assert.equal(sd.gleichSicher(undefined, 'abc'), false);
  assert.equal(sd.gleichSicher('äöü', 'äöü'), true);
});
