/**
 * Lokaler Generator: Amoura Monatsbericht Juli 2026 (voller Monat 01.–31.07.)
 * Datenquelle: Live-Admin-API (kein lokaler DB-Zugang nötig)
 * Ausführen: NODE_PATH=<pfad-zu-node_modules> node berichte/generate_juli_bericht_amoura.js
 * Benötigt: Amoura/.env mit ADMIN_PASSWORD (+ API_BASE)
 */

require('dotenv').config({ path: './.env' });
const PDFDocument = require('pdfkit');
const fs   = require('fs');
const path = require('path');

// ── Zeitraum: 01.–31. Juli 2026 ──────────────────────────────────
const JAHR  = 2026;
const MONAT = 6;          // 0-basiert: 6 = Juli
const TAG_VON = 1;
const TAG_BIS = 31;

const API_BASE = (process.env.API_BASE || 'https://website-pizzeria-amoura.onrender.com/api').trim();
const ADMIN_PW = (process.env.ADMIN_PASSWORD || '').trim();

// ── PDF-Konstanten ────────────────────────────────────────────────
const PDF_M  = 50;
const PDF_W  = 495;
const PDF_PW = 595;
const PDF_FT = 810;
const PDF_SV = 0.99;                 // Servicegebühr pro Bestellung
const GRUNDGEBUEHR = 150;            // monatliche Grundgebühr (Juli 2026, Standard) – KEINE Provision
const pdfFmt = n => n.toFixed(2).replace('.', ',') + ' €';
// DSGVO-Datenminimierung: nur Vorname + erster Buchstabe des Nachnamens
const pdfMaskName = o => {
  const f = (o.customer?.first || '').trim();
  const l = (o.customer?.last  || '').trim();
  return (l ? `${f} ${l.charAt(0)}.` : f).trim() || '–';
};
// Testbestellungen ausschließen: Name enthält "Test" ODER Servicegebühr = Schema-Default 0,50 €
const isTestOrder = o => {
  const name = `${o.customer?.first || ''} ${o.customer?.last || ''}`;
  return /\btest\b/i.test(name) || o.serviceFee === 0.5;
};

function generatePdf(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildFn(doc);
    doc.end();
  });
}

function pdfColorBox(doc, title, sub, color = '#8b1d1d', h = 70) {
  doc.rect(0, 0, PDF_PW, h).fill(color);
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#fff').text(title, PDF_M, 18);
  if (sub) doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.75)').text(sub, PDF_M, 44);
  doc.y = h + 12;
}

function pdfHr(doc, color = '#ddd', lw = 0.5) {
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M + PDF_W, doc.y).strokeColor(color).lineWidth(lw).stroke();
  doc.y += lw + 3;
}

function pdfKacheln(doc, items) {
  const kW = Math.floor((PDF_W - (items.length - 1) * 8) / items.length);
  const top = doc.y;
  items.forEach(([label, value, color], i) => {
    const x = PDF_M + i * (kW + 8);
    doc.rect(x, top, kW, 46).fill(color);
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#fff').text(value, x + 8, top + 6, { width: kW - 16 });
    doc.font('Helvetica').fontSize(8).fillColor('rgba(255,255,255,0.75)').text(label, x + 8, top + 28, { width: kW - 16 });
  });
  doc.y = top + 46 + 12;
}

function pdfTableRow(doc, cells, shade, bold = false) {
  const top = doc.y;
  if (shade) doc.rect(PDF_M, top, PDF_W, 20).fill('#f5f7fa');
  cells.forEach(([txt, x, w, align]) => {
    const fn = bold ? 'Helvetica-Bold' : 'Helvetica';
    doc.font(fn).fontSize(10).fillColor('#222').text(txt, x, top + 4, { width: w, align: align || 'left' });
  });
  doc.y = top + 20;
}

function pdfKundenliste(doc, orders) {
  function drawGroup(label, color, list) {
    if (!list.length) return;
    const gy = doc.y;
    doc.rect(PDF_M, gy, PDF_W, 22).fill(color);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#fff').text(label, PDF_M + 8, gy + 6, { width: PDF_W - 16 });
    doc.y = gy + 22 + 2;
    const hy = doc.y;
    doc.rect(PDF_M, hy, PDF_W, 16).fill('#eaeef3');
    [['#', PDF_M+2, 30, 'left'], ['Datum', PDF_M+34, 40, 'left'], ['Kunde', PDF_M+76, 190, 'left'],
     ['Art', PDF_M+268, 80, 'left'], ['Betrag', PDF_M+2, PDF_W-4, 'right']
    ].forEach(([h, x, w, a]) => doc.font('Helvetica-Bold').fontSize(8).fillColor('#444').text(h, x, hy+4, { width:w, align:a }));
    doc.y = hy + 16 + 2;
    let sub = 0;
    list.forEach((o, i) => {
      if (doc.y > PDF_FT - 24) { doc.addPage(); doc.y = PDF_M; }
      const date = new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) + '.';
      const name = pdfMaskName(o);
      const modeStr = o.mode === 'lieferung' ? 'Lieferung' : 'Abholung';
      sub += o.total || 0;
      const ry = doc.y;
      if (i % 2 === 0) doc.rect(PDF_M, ry, PDF_W, 18).fill('#fafafa');
      doc.font('Helvetica').fontSize(9).fillColor('#222')
        .text(`${o.orderNum}`, PDF_M+2,   ry+4, { width:30 })
        .text(date,            PDF_M+34,  ry+4, { width:40 })
        .text(name,            PDF_M+76,  ry+4, { width:188 })
        .text(modeStr,         PDF_M+268, ry+4, { width:80 });
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#222')
        .text(pdfFmt(o.total||0), PDF_M+2, ry+4, { width:PDF_W-4, align:'right' });
      doc.y = ry + 18;
    });
    const sy = doc.y;
    doc.rect(PDF_M, sy, PDF_W, 20).fill(color + '28');
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Summe ${label}:`, PDF_M+8, sy+5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text(pdfFmt(sub), PDF_M+2, sy+5, { width:PDF_W-4, align:'right' });
    doc.y = sy + 20 + 10;
  }
  drawGroup('Lieferungen',  '#2c5282', orders.filter(o => o.mode === 'lieferung'));
  drawGroup('Abholungen',   '#276749', orders.filter(o => o.mode === 'abholung'));
}

function pdfBarRechnung(doc, barOrders, barStats, zeitraum) {
  if (!barOrders.length) return;
  doc.addPage(); doc.y = PDF_M;
  doc.rect(0, 0, PDF_PW, 50).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#fff').text('Bar-Zahlungen – Übersicht', PDF_M, 14);
  doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.7)').text(`FlueVate Online-Bestellsystem  ·  ${zeitraum}`, PDF_M, 33);
  doc.y = 62;
  const addrY = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Anbieter:', PDF_M, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Abed Rachman Falah · FlueVate', PDF_M, addrY+12).text('Zur Goldbrede 30, 59269 Beckum', PDF_M, addrY+22);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Restaurant:', PDF_M+270, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Pizzeria Amoura', PDF_M+270, addrY+12).text('Oststraße 48, 59269 Beckum', PDF_M+270, addrY+22);
  doc.y = addrY + 38;
  doc.font('Helvetica').fontSize(8.5).fillColor('#888').text(`Zeitraum: ${zeitraum}`, PDF_M, doc.y);
  doc.y += 12;
  const hy = doc.y;
  doc.rect(PDF_M, hy, PDF_W, 16).fill('#fef9e7');
  doc.font('Helvetica').fontSize(7.5).fillColor('#7a5c00').text('ℹ  Interne Übersicht – keine Rechnung. Nur Barzahlungen; Stripe-Gebühren wurden bereits beim Checkout einbehalten.', PDF_M+6, hy+4, { width:PDF_W-12 });
  doc.y = hy + 16 + 6;
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M+PDF_W, doc.y).strokeColor('#333').lineWidth(1).stroke(); doc.y += 4;
  const th = doc.y;
  doc.rect(PDF_M, th, PDF_W, 16).fill('#1a1a2e');
  [['#', PDF_M+2, 34, 'left'], ['Datum', PDF_M+38, 40, 'left'], ['Kunde', PDF_M+80, 190, 'left'],
   ['Umsatz', PDF_M+272, 70, 'right'], ['Servicegebühr', PDF_M+342, 96, 'right'], ['Gesamt', PDF_M+2, PDF_W-4, 'right']
  ].forEach(([h, x, w, a]) => doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff').text(h, x, th+4, { width:w, align:a }));
  doc.y = th + 16 + 2;
  barOrders.forEach((o, i) => {
    if (doc.y > PDF_FT - 20) { doc.addPage(); doc.y = PDF_M; }
    const sf   = o.serviceFee || PDF_SV;
    const date = new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) + '.';
    const name = pdfMaskName(o);
    const ry = doc.y;
    if (i % 2 === 0) doc.rect(PDF_M, ry, PDF_W, 16).fill('#f8f9fc');
    doc.font('Helvetica').fontSize(8.5).fillColor('#222')
      .text(`${o.orderNum}`, PDF_M+2,  ry+4, { width:34 })
      .text(date,            PDF_M+38, ry+4, { width:40 })
      .text(name,            PDF_M+80, ry+4, { width:185 })
      .text(pdfFmt(o.total), PDF_M+272, ry+4, { width:70,  align:'right' })
      .text(pdfFmt(sf),      PDF_M+342, ry+4, { width:96,  align:'right' });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1a1a2e').text(pdfFmt(sf), PDF_M+2, ry+4, { width:PDF_W-4, align:'right' });
    doc.y = ry + 16;
  });
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M+PDF_W, doc.y).strokeColor('#333').lineWidth(1).stroke(); doc.y += 4;
  const s1y = doc.y;
  doc.rect(PDF_M, s1y, PDF_W, 18).fill('#f0f4f8');
  doc.font('Helvetica').fontSize(9).fillColor('#333').text('Servicegebühren', PDF_M+8, s1y+5).text(`${barOrders.length} × ${pdfFmt(PDF_SV)}`, PDF_M+200, s1y+5, { width:140, align:'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#222').text(pdfFmt(barStats.barSvc), PDF_M+2, s1y+5, { width:PDF_W-4, align:'right' });
  doc.y = s1y + 18 + 4;
  const gy = doc.y;
  doc.rect(PDF_M, gy, PDF_W, 30).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff').text('Summe Servicegebühren (Bar)', PDF_M+10, gy+9, { width:PDF_W*0.6 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffd700').text(pdfFmt(barStats.barBetrag), PDF_M+2, gy+8, { width:PDF_W-4, align:'right' });
  doc.y = gy + 30 + 8;
  const uy = doc.y;
  doc.rect(PDF_M, uy, PDF_W, 14).fill('#fef9e7');
  doc.font('Helvetica').fontSize(7.5).fillColor('#7a5c00').text('Grundlage für die separate Gebühren-Rechnung – dieses Dokument ist keine Rechnung.', PDF_M+6, uy+3, { width:PDF_W-12 });
  doc.y = uy + 14;
}

function getWeekNum(d) {
  const dt = new Date(d); dt.setHours(0,0,0,0);
  const w1 = new Date(dt.getFullYear(),0,4);
  return 1+Math.round(((dt-w1)/86400000-3+(w1.getDay()+6)%7)/7);
}

// ── Datenabruf über Admin-API ─────────────────────────────────────
async function login() {
  const r = await fetch(API_BASE + '/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PW })
  });
  if (!r.ok) throw new Error(`Login fehlgeschlagen (HTTP ${r.status})`);
  const j = await r.json();
  if (!j.token) throw new Error('Kein Token erhalten');
  return j.token;
}

async function fetchOrdersForDay(token, dateStr) {
  const r = await fetch(`${API_BASE}/admin/orders?date=${dateStr}`, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) throw new Error(`Abruf ${dateStr} fehlgeschlagen (HTTP ${r.status})`);
  const j = await r.json();
  return Array.isArray(j.orders) ? j.orders : [];
}

// ── Hauptprogramm ─────────────────────────────────────────────────
async function main() {
  if (!ADMIN_PW) { console.error('❌ ADMIN_PASSWORD fehlt in Amoura/.env'); process.exit(1); }

  console.log('🔐 Login bei Admin-API…');
  const token = await login();
  console.log('✅ Eingeloggt');

  const mStart = new Date(JAHR, MONAT, TAG_VON, 0, 0, 0, 0);
  const mEnd   = new Date(JAHR, MONAT, TAG_BIS, 23, 59, 59, 999);

  const monat  = mStart.toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' });
  const datum  = mEnd.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', timeZone: 'Europe/Berlin' });
  const vonBis = `${mStart.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })} – ${datum}`;

  console.log(`📅 Lade Bestellungen Tag für Tag (${vonBis})…`);
  const seen = new Set();
  let raw = [];
  for (let d = TAG_VON; d <= TAG_BIS; d++) {
    const dateStr = `${JAHR}-${String(MONAT+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayOrders = await fetchOrdersForDay(token, dateStr);
    for (const o of dayOrders) {
      const id = o._id || `${o.orderNum}`;
      if (seen.has(id)) continue;
      seen.add(id);
      raw.push(o);
    }
    process.stdout.write(`   ${dateStr}: ${dayOrders.length}\n`);
  }

  // Gleiche Filterlogik wie der Monatsbericht (server.js / Mai-Skript)
  const orders = raw
    .filter(o => ['confirmed','preparing','ready','delivered'].includes(o.status))
    .filter(o => !isTestOrder(o))
    .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));

  console.log(`📦 ${orders.length} gültige Bestellungen (von ${raw.length} abgerufen)`);

  const base       = GRUNDGEBUEHR;   // monatliche Grundgebühr
  const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
  const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const gesamtGeb  = svcFees + base; // Gesamt FlueVate-Gebühren (Service + Grundgebühr)
  const auszahlung = brutto - svcFees; // Grundgebühr wird separat in Rechnung gestellt, nicht vom Payout abgezogen
  const barOrdersM = orders.filter(o => o.payment === 'bar');
  const onlineM    = orders.filter(o => ['stripe','paypal'].includes(o.payment));
  const barSvcM    = barOrdersM.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const barBetragM = barSvcM;        // keine Provision
  const weeksMap   = {};
  orders.forEach(o => {
    const kw2 = getWeekNum(new Date(o.createdAt));
    if (!weeksMap[kw2]) weeksMap[kw2] = { n:0, brutto:0 };
    weeksMap[kw2].n++; weeksMap[kw2].brutto += o.total||0;
  });
  const weekRows = Object.entries(weeksMap).sort((a,b)=>+a[0]-+b[0]);

  console.log(`💶 Brutto: ${pdfFmt(brutto)} | FlueVate-Gebühren: ${pdfFmt(gesamtGeb)} (Service ${pdfFmt(svcFees)} + Grundgebühr ${pdfFmt(base)}) | Auszahlung: ${pdfFmt(auszahlung)}`);

  console.log('📄 Generiere Monatsbericht PDF…');
  const titelZeitraum = `Pizzeria Amoura  ·  ${vonBis}`;
  const monatsPdf = await generatePdf(doc => {
    pdfColorBox(doc, `Monatsbericht ${monat}`, titelZeitraum, '#8b1d1d');
    pdfKacheln(doc, [
      ['Bestellungen gesamt', `${orders.length}`,      '#1a1a2e'],
      ['Davon Bar',           `${barOrdersM.length}`,   '#2c5282'],
      ['Davon Online',        `${onlineM.length}`,      '#276749'],
      ['Brutto-Umsatz',       pdfFmt(brutto),           '#744210'],
    ]);
    doc.moveDown(0.4);
    pdfHr(doc);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ABRECHNUNG', PDF_M, doc.y);
    doc.y += 14;
    pdfTableRow(doc, [[`Servicegebühren  (${pdfFmt(PDF_SV)} × ${orders.length} Bestellungen)`, PDF_M+8, PDF_W-80, 'left'], [pdfFmt(svcFees),   PDF_M+2, PDF_W-4, 'right']], false);
    pdfTableRow(doc, [['Grundgebühr (monatlich)',                                              PDF_M+8, PDF_W-80, 'left'], [pdfFmt(base),      PDF_M+2, PDF_W-4, 'right']], true);
    pdfTableRow(doc, [['Gesamt FlueVate-Gebühren',                                             PDF_M+8, PDF_W-80, 'left'], [pdfFmt(gesamtGeb), PDF_M+2, PDF_W-4, 'right']], false, true);
    doc.y += 4;
    const ay = doc.y;
    doc.rect(PDF_M, ay, PDF_W, 28).fill('#e8f5e9');
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#2e7d32').text('Auszahlung an Pizzeria Amoura', PDF_M+10, ay+8, { width: PDF_W*0.65 });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#2e7d32').text(pdfFmt(auszahlung), PDF_M+2, ay+8, { width: PDF_W-4, align: 'right' });
    doc.y = ay + 28 + 16;
    pdfHr(doc, '#bbb');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('WOCHENÜBERSICHT', PDF_M, doc.y);
    doc.y += 14;
    weekRows.forEach(([kw2, d], i) => {
      pdfTableRow(doc, [
        [`KW ${kw2}`,           PDF_M+8,  70,        'left'],
        [`${d.n} Bestellungen`, PDF_M+90, PDF_W-170, 'left'],
        [pdfFmt(d.brutto),      PDF_M+2,  PDF_W-4,   'right'],
      ], i % 2 === 1);
    });
    doc.y += 8;
    pdfHr(doc, '#bbb');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('KUNDENLISTE', PDF_M, doc.y);
    doc.y += 12;
    pdfKundenliste(doc, orders);
    if (barOrdersM.length > 0) {
      pdfBarRechnung(doc, barOrdersM, { barSvc:barSvcM, barBetrag:barBetragM }, vonBis);
    }
    doc.font('Helvetica').fontSize(7).fillColor('#bbb')
      .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  Monatsbericht ${monat}`, PDF_M, 820, { width: PDF_W, align: 'center' });
  });

  const outDir = path.join(__dirname, '..', 'PDFs'); // Berichte weiterhin ins Repo-Root/PDFs
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const file1 = path.join(outDir, `Juli_2026_Amoura_Monatsbericht.pdf`);
  fs.writeFileSync(file1, monatsPdf);

  console.log(`\n✅ Fertig!`);
  console.log(`   📄 ${file1}`);
}

main().catch(e => { console.error('❌ Fehler:', e.message); process.exit(1); });
