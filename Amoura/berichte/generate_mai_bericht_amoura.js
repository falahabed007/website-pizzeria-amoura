/**
 * Lokaler Generator: Amoura Monatsbericht + Rechnung Mai 2026
 * Ausführen: node generate_mai_bericht_amoura.js
 * Benötigt: Amoura/Amoura/.env mit MONGODB_URI
 */

require('dotenv').config({ path: './Amoura/Amoura/.env' });
const mongoose   = require('mongoose');
const PDFDocument = require('pdfkit');
const fs         = require('fs');
const path       = require('path');

// ── Rechnungsnummer manuell (zähler NICHT erhöhen) ───────────────
const RECHNUNGS_NR = 'RE-2026-0010';

// ── Monat: Mai 2026 ───────────────────────────────────────────────
const MONAT_YEAR = 2026;
const MONAT_MONTH = 4; // 0-basiert: 4 = Mai

// ── Schemas (minimal) ────────────────────────────────────────────
const orderSchema = new mongoose.Schema({
  orderNum:      Number,
  status:        String,
  payment:       String,
  paymentStatus: String,
  mode:          String,
  items:         [{ name: String, price: Number, qty: Number, note: String, extraDetails: [{ name: String, price: Number }] }],
  customer:      { first: String, last: String, email: String, phone: String, street: String, house: String, city: String },
  subtotal:      Number,
  deliveryFee:   Number,
  serviceFee:    { type: Number, default: 0.99 },
  total:         Number,
  note:          String,
}, { timestamps: true });
const Order = mongoose.model('Order', orderSchema);

// ── PDF-Konstanten ────────────────────────────────────────────────
const PDF_M  = 50;
const PDF_W  = 495;
const PDF_PW = 595;
const PDF_FT = 810;
const PDF_SV = 0.99;
const PDF_PR = 0.05;
const pdfFmt = n => n.toFixed(2).replace('.', ',') + ' €';
// DSGVO-Datenminimierung: nur Vorname + erster Buchstabe des Nachnamens (z. B. "Nadien F.")
const pdfMaskName = o => {
  const f = (o.customer?.first || '').trim();
  const l = (o.customer?.last  || '').trim();
  return (l ? `${f} ${l.charAt(0)}.` : f).trim() || '–';
};
// Testbestellungen aus Berichten ausschließen: Kundenname enthält "Test" ODER Servicegebühr = Schema-Default 0,50 €
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
  [['#', PDF_M+2, 34, 'left'], ['Datum', PDF_M+38, 40, 'left'], ['Kunde', PDF_M+80, 170, 'left'],
   ['Umsatz', PDF_M+252, 64, 'right'], ['Gebühr', PDF_M+318, 60, 'right'], ['5% Prov', PDF_M+380, 58, 'right'], ['Gesamt', PDF_M+2, PDF_W-4, 'right']
  ].forEach(([h, x, w, a]) => doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff').text(h, x, th+4, { width:w, align:a }));
  doc.y = th + 16 + 2;
  barOrders.forEach((o, i) => {
    if (doc.y > PDF_FT - 20) { doc.addPage(); doc.y = PDF_M; }
    const sf   = o.serviceFee || PDF_SV;
    const prov = (o.total - sf) * PDF_PR;
    const ges  = sf + prov;
    const date = new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) + '.';
    const name = pdfMaskName(o);
    const ry = doc.y;
    if (i % 2 === 0) doc.rect(PDF_M, ry, PDF_W, 16).fill('#f8f9fc');
    doc.font('Helvetica').fontSize(8.5).fillColor('#222')
      .text(`${o.orderNum}`, PDF_M+2,  ry+4, { width:34 })
      .text(date,            PDF_M+38, ry+4, { width:40 })
      .text(name,            PDF_M+80, ry+4, { width:168 })
      .text(pdfFmt(o.total), PDF_M+252, ry+4, { width:64,  align:'right' })
      .text(pdfFmt(sf),      PDF_M+318, ry+4, { width:60,  align:'right' })
      .text(pdfFmt(prov),    PDF_M+380, ry+4, { width:58,  align:'right' });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1a1a2e').text(pdfFmt(ges), PDF_M+2, ry+4, { width:PDF_W-4, align:'right' });
    doc.y = ry + 16;
  });
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M+PDF_W, doc.y).strokeColor('#333').lineWidth(1).stroke(); doc.y += 4;
  const s1y = doc.y;
  doc.rect(PDF_M, s1y, PDF_W, 18).fill('#f0f4f8');
  doc.font('Helvetica').fontSize(9).fillColor('#333').text('Servicegebühren', PDF_M+8, s1y+5).text(`${barOrders.length} Bestellungen`, PDF_M+200, s1y+5, { width:140, align:'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#222').text(pdfFmt(barStats.barSvc), PDF_M+2, s1y+5, { width:PDF_W-4, align:'right' });
  doc.y = s1y + 18;
  const s2y = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor('#333').text('Systemprovision (5 %)', PDF_M+8, s2y+5).text(`5 % von ${pdfFmt(barStats.barNetto)}`, PDF_M+200, s2y+5, { width:140, align:'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#222').text(pdfFmt(barStats.barProv), PDF_M+2, s2y+5, { width:PDF_W-4, align:'right' });
  doc.y = s2y + 18 + 4;
  const gy = doc.y;
  doc.rect(PDF_M, gy, PDF_W, 30).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff').text('Summe Gebühren (Bar)', PDF_M+10, gy+9, { width:PDF_W*0.6 });
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

// ── Hauptprogramm ─────────────────────────────────────────────────
async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI fehlt in Amoura/Amoura/.env');
    process.exit(1);
  }

  console.log('🔌 Verbinde mit MongoDB…');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Verbunden');

  const mStart = new Date(MONAT_YEAR, MONAT_MONTH, 1, 0, 0, 0, 0);
  const mEnd   = new Date(MONAT_YEAR, MONAT_MONTH + 1, 0, 23, 59, 59, 999);
  const refDate = mEnd;

  const monat  = refDate.toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' });
  const datum  = mEnd.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', timeZone: 'Europe/Berlin' });
  const vonBis = `${mStart.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })} – ${datum}`;
  const rechnungNr = RECHNUNGS_NR;

  console.log(`📅 Lade Bestellungen für ${monat} (${vonBis})…`);

  const orders = (await Order.find({
    status: { $in: ['confirmed','preparing','ready','delivered'] },
    createdAt: { $gte: mStart, $lte: mEnd }
  }).sort({ createdAt: 1 })).filter(o => !isTestOrder(o));

  console.log(`📦 ${orders.length} Bestellungen gefunden`);

  if (orders.length === 0) {
    console.warn('⚠️  Keine Bestellungen – PDFs werden trotzdem generiert');
  }

  const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
  const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const nettoBase  = brutto - svcFees;
  const provision  = nettoBase * PDF_PR;
  const meinBetrag = svcFees + provision;
  const auszahlung = brutto - meinBetrag;
  const barOrdersM = orders.filter(o => o.payment === 'bar');
  const barSvcM    = barOrdersM.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const barNettoM  = barOrdersM.reduce((s,o) => s+(o.total||0), 0) - barSvcM;
  const barProvM   = barNettoM * PDF_PR;
  const barBetragM = barSvcM + barProvM;
  const weeksMap   = {};
  orders.forEach(o => {
    const kw2 = getWeekNum(new Date(o.createdAt));
    if (!weeksMap[kw2]) weeksMap[kw2] = { n:0, brutto:0 };
    weeksMap[kw2].n++; weeksMap[kw2].brutto += o.total||0;
  });
  const weekRows = Object.entries(weeksMap).sort((a,b)=>+a[0]-+b[0]);

  console.log(`💶 Brutto: ${pdfFmt(brutto)} | Mein Betrag: ${pdfFmt(meinBetrag)} | Auszahlung: ${pdfFmt(auszahlung)}`);

  // ── PDF 1: Monatsbericht ─────────────────────────────────────
  console.log('📄 Generiere Monatsbericht PDF…');
  const monatsPdf = await generatePdf(doc => {
    pdfColorBox(doc, `Monatsbericht ${monat}`, `Pizzeria Amoura  ·  ${vonBis}`, '#8b1d1d');
    pdfKacheln(doc, [
      ['Bestellungen gesamt', `${orders.length}`,                              '#1a1a2e'],
      ['Davon Bar',           `${barOrdersM.length}`,                          '#2c5282'],
      ['Davon Stripe',        `${orders.filter(o=>o.payment!=='bar').length}`, '#276749'],
      ['Brutto-Umsatz',       pdfFmt(brutto),                                  '#744210'],
    ]);
    doc.moveDown(0.4);
    pdfHr(doc);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ABRECHNUNG', PDF_M, doc.y);
    doc.y += 14;
    pdfTableRow(doc, [[`Servicegebühren  (${orders.length} Bestellungen)`, PDF_M+8, PDF_W-80, 'left'], [pdfFmt(svcFees),    PDF_M+2, PDF_W-4, 'right']], false);
    pdfTableRow(doc, [[`Systemprovision  (5 % auf ${pdfFmt(nettoBase)})`,          PDF_M+8, PDF_W-80, 'left'], [pdfFmt(provision),  PDF_M+2, PDF_W-4, 'right']], true);
    pdfTableRow(doc, [['Mein Gesamtbetrag',                                        PDF_M+8, PDF_W-80, 'left'], [pdfFmt(meinBetrag), PDF_M+2, PDF_W-4, 'right']], false, true);
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
      pdfBarRechnung(doc, barOrdersM, { barSvc:barSvcM, barNetto:barNettoM, barProv:barProvM, barBetrag:barBetragM }, vonBis);
    }
    doc.font('Helvetica').fontSize(7).fillColor('#bbb')
      .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  Monatsbericht ${monat}`, PDF_M, 820, { width: PDF_W, align: 'center' });
  });

  // PDF 2 (FlueVate-Rechnung) wird nicht mehr erzeugt – die Rechnung wird separat in Lexware geschrieben.

  // ── Speichern ─────────────────────────────────────────────────
  const outDir = path.join(__dirname, '..', 'PDFs'); // Berichte weiterhin ins Repo-Root/PDFs
  const file1  = path.join(outDir, `Mai_2026_Amoura_Monatsbericht.pdf`);

  fs.writeFileSync(file1, monatsPdf);

  console.log(`\n✅ Fertig!`);
  console.log(`   📄 ${file1}`);

  await mongoose.disconnect();
}

main().catch(e => { console.error('❌ Fehler:', e.message); process.exit(1); });
