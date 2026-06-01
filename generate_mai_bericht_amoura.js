'use strict';
const PDFDocument = require('pdfkit');
const fs          = require('fs');
const path        = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// ROHDATEN  (Quelle: Live-DB vom 01.06.2026, Status confirmed/preparing/ready/delivered)
// ─────────────────────────────────────────────────────────────────────────────
const ORDERS_MAI = [
  // KW 18  (01.–03. Mai)
  { orderNum:1083, date:'01.05.', kw:18, name:'Robert Rodjak',                      mode:'Lieferung', payment:'bar',    total:59.49 },
  { orderNum:1085, date:'02.05.', kw:18, name:'Kris Opperbeck',                     mode:'Lieferung', payment:'bar',    total:28.99 },
  { orderNum:1088, date:'03.05.', kw:18, name:'Chris Langhammer',                   mode:'Lieferung', payment:'stripe', total:18.99 },
  // KW 19  (04.–10. Mai)
  { orderNum:1089, date:'04.05.', kw:19, name:'Alexandra Kanwischer',               mode:'Abholung',  payment:'bar',    total:29.99 },
  { orderNum:1091, date:'04.05.', kw:19, name:'René Schindler',                     mode:'Lieferung', payment:'bar',    total:18.99 },
  { orderNum:1095, date:'04.05.', kw:19, name:'Sean Loeseke',                       mode:'Abholung',  payment:'bar',    total:19.99 },
  { orderNum:1097, date:'05.05.', kw:19, name:'Mario Salchert',                     mode:'Lieferung', payment:'bar',    total:21.49 },
  { orderNum:1099, date:'06.05.', kw:19, name:'Noel Wiegard',                       mode:'Lieferung', payment:'bar',    total:45.99 },
  { orderNum:1101, date:'06.05.', kw:19, name:'Nour Ramzi',                         mode:'Abholung',  payment:'bar',    total:24.99 },
  { orderNum:1103, date:'06.05.', kw:19, name:'Hisham Baadie',                      mode:'Lieferung', payment:'stripe', total:37.49 },
  { orderNum:1105, date:'07.05.', kw:19, name:'Sarah Coni',                         mode:'Abholung',  payment:'bar',    total:27.99 },
  { orderNum:1107, date:'08.05.', kw:19, name:'Elvira Hermes',                      mode:'Lieferung', payment:'stripe', total:43.49 },
  { orderNum:1111, date:'10.05.', kw:19, name:'Melanie Digulla',                    mode:'Lieferung', payment:'bar',    total:34.99 },
  { orderNum:1113, date:'10.05.', kw:19, name:'Kris Opperbeck',                     mode:'Lieferung', payment:'bar',    total:27.99 },
  // KW 20  (11.–17. Mai)
  { orderNum:1116, date:'11.05.', kw:20, name:'Thomas Wenzel',                      mode:'Lieferung', payment:'stripe', total:18.49 },
  { orderNum:1121, date:'12.05.', kw:20, name:'Kris Opperbeck c/o RP/07 GmbH',     mode:'Lieferung', payment:'bar',    total:30.99 },
  { orderNum:1123, date:'14.05.', kw:20, name:'Berk Sevik',                         mode:'Lieferung', payment:'stripe', total:20.99 },
  { orderNum:1124, date:'17.05.', kw:20, name:'Juliane Schmidt',                    mode:'Lieferung', payment:'bar',    total:22.49 },
  { orderNum:1126, date:'17.05.', kw:20, name:'Lydia Reiberger',                    mode:'Lieferung', payment:'bar',    total:25.99 },
  // KW 21  (18.–24. Mai)
  { orderNum:1128, date:'18.05.', kw:21, name:'Angelique Pawlik',                   mode:'Lieferung', payment:'stripe', total:23.99 },
  { orderNum:1129, date:'19.05.', kw:21, name:'Alen Mujabasic',                     mode:'Lieferung', payment:'stripe', total:24.49 },
  { orderNum:1131, date:'19.05.', kw:21, name:'Pascal Reichenbach',                 mode:'Lieferung', payment:'stripe', total:31.99 },
  { orderNum:1132, date:'19.05.', kw:21, name:'Tim Wunder',                         mode:'Lieferung', payment:'bar',    total:33.99 },
  { orderNum:1134, date:'19.05.', kw:21, name:'Angelique Pawlik',                   mode:'Lieferung', payment:'stripe', total:30.99 },
  { orderNum:1135, date:'19.05.', kw:21, name:'Sarah Coni',                         mode:'Abholung',  payment:'bar',    total:19.99 },
  { orderNum:1142, date:'22.05.', kw:21, name:'Dominik Horn',                       mode:'Lieferung', payment:'bar',    total:27.99 },
  { orderNum:1146, date:'23.05.', kw:21, name:'Uwe Schäfer',                        mode:'Lieferung', payment:'bar',    total:23.49 },
  { orderNum:1148, date:'23.05.', kw:21, name:'Felix Gretencord',                   mode:'Lieferung', payment:'stripe', total:21.49 },
  { orderNum:1149, date:'24.05.', kw:21, name:'Enrico Jabs',                        mode:'Abholung',  payment:'bar',    total:17.49 },
  { orderNum:1152, date:'24.05.', kw:21, name:'Julia Becker',                       mode:'Lieferung', payment:'bar',    total:23.49 },
  // KW 22  (25.–31. Mai)
  { orderNum:1154, date:'25.05.', kw:22, name:'Ute Gretencord',                     mode:'Lieferung', payment:'bar',    total:20.49 },
  { orderNum:1156, date:'25.05.', kw:22, name:'Katharina Wunderlich',               mode:'Lieferung', payment:'bar',    total:66.99 },
  { orderNum:1158, date:'25.05.', kw:22, name:'Tim Paul',                           mode:'Lieferung', payment:'stripe', total:38.49 },
  { orderNum:1159, date:'25.05.', kw:22, name:'Joel Wahner',                        mode:'Lieferung', payment:'stripe', total:38.99 },
  { orderNum:1160, date:'25.05.', kw:22, name:'Sabrina Vogt',                       mode:'Lieferung', payment:'stripe', total:47.99 },
  { orderNum:1161, date:'25.05.', kw:22, name:'Maximilian Peters',                  mode:'Lieferung', payment:'bar',    total:68.49 },
  { orderNum:1163, date:'25.05.', kw:22, name:'Bilal Taaibi',                       mode:'Lieferung', payment:'stripe', total:36.99 },
  { orderNum:1164, date:'27.05.', kw:22, name:'Stephan Ansahl',                     mode:'Lieferung', payment:'bar',    total:76.49 },
  { orderNum:1166, date:'27.05.', kw:22, name:'Juliane Kuhn',                       mode:'Lieferung', payment:'stripe', total:28.99 },
  { orderNum:1167, date:'27.05.', kw:22, name:'Katharina Wunderlich',               mode:'Lieferung', payment:'bar',    total:46.99 },
  { orderNum:1169, date:'27.05.', kw:22, name:'Marcel Engberding',                  mode:'Abholung',  payment:'bar',    total:30.49 },
  { orderNum:1171, date:'28.05.', kw:22, name:'Carola Harmes',                      mode:'Lieferung', payment:'bar',    total:21.49 },
  { orderNum:1173, date:'28.05.', kw:22, name:'Marcel Engberding',                  mode:'Abholung',  payment:'bar',    total:26.49 },
  { orderNum:1175, date:'29.05.', kw:22, name:'Christian Pfeiffer',                 mode:'Lieferung', payment:'bar',    total:83.49 },
  { orderNum:1177, date:'29.05.', kw:22, name:'Linda Horrey',                       mode:'Lieferung', payment:'bar',    total:28.49 },
  { orderNum:1179, date:'29.05.', kw:22, name:'Joel Wahner',                        mode:'Lieferung', payment:'stripe', total:37.49 },
  { orderNum:1180, date:'29.05.', kw:22, name:'Nour Ramzi',                         mode:'Abholung',  payment:'bar',    total:33.49 },
  { orderNum:1182, date:'30.05.', kw:22, name:'Dario Tyralla',                      mode:'Lieferung', payment:'stripe', total:21.49 },
  { orderNum:1183, date:'30.05.', kw:22, name:'Jessica Mance',                      mode:'Lieferung', payment:'bar',    total:69.99 },
  { orderNum:1185, date:'31.05.', kw:22, name:'Tobias Leifhelm',                    mode:'Lieferung', payment:'bar',    total:29.99 },
  { orderNum:1188, date:'31.05.', kw:22, name:'Thomas Geipel',                      mode:'Abholung',  payment:'bar',    total:19.49 },
  { orderNum:1190, date:'31.05.', kw:22, name:'Maya Höner-Hirdes',                  mode:'Lieferung', payment:'stripe', total:32.49 },
  { orderNum:1191, date:'31.05.', kw:22, name:'Tim Weinekötter',                    mode:'Lieferung', payment:'bar',    total:46.99 },
  { orderNum:1194, date:'31.05.', kw:22, name:'Julia Becker',                       mode:'Lieferung', payment:'bar',    total:28.49 },
  { orderNum:1196, date:'31.05.', kw:22, name:'Dominic Offers',                     mode:'Abholung',  payment:'stripe', total:28.49 },
  { orderNum:1197, date:'31.05.', kw:22, name:'Caroline Fernkorn',                  mode:'Abholung',  payment:'bar',    total:34.49 },
  { orderNum:1200, date:'31.05.', kw:22, name:'Sabine Ostbomke',                    mode:'Abholung',  payment:'bar',    total:49.49 },
  { orderNum:1202, date:'31.05.', kw:22, name:'Leonie Schmidt',                     mode:'Lieferung', payment:'bar',    total:22.99 },
  { orderNum:1204, date:'31.05.', kw:22, name:'Thomas Hagemann',                    mode:'Lieferung', payment:'bar',    total:28.49 },
];

// ─────────────────────────────────────────────────────────────────────────────
// BERECHNUNG
// ─────────────────────────────────────────────────────────────────────────────
const SVC  = 0.99;
const PROV = 0.05;
const fmt  = n => n.toFixed(2).replace('.', ',') + ' €';

function calcStats(orders) {
  const bar      = orders.filter(o => o.payment === 'bar');
  const stripe   = orders.filter(o => o.payment === 'stripe');
  const brutto   = orders.reduce((s, o) => s + o.total, 0);
  const svcFees  = orders.length * SVC;
  const netto    = brutto - svcFees;
  const prov     = netto * PROV;
  const mein     = svcFees + prov;
  const auszahl  = brutto - mein;
  const barBrutto = bar.reduce((s, o) => s + o.total, 0);
  const barSvc    = bar.length * SVC;
  const barNetto  = barBrutto - barSvc;
  const barProv   = barNetto * PROV;
  const barBetrag = barSvc + barProv;
  return { bar, stripe, brutto, svcFees, netto, prov, mein, auszahl, barBrutto, barSvc, barNetto, barProv, barBetrag };
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF HELPER
// ─────────────────────────────────────────────────────────────────────────────
const MARGIN = 50;
const PW     = 595;
const W      = PW - MARGIN * 2;
const FOOTER = 810;

function generatePdf(fn) {
  return new Promise((res, rej) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, autoFirstPage: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => res(Buffer.concat(chunks)));
    doc.on('error', rej);
    fn(doc);
    doc.end();
  });
}

function colorBox(doc, text, sub, color, h = 70) {
  doc.rect(0, 0, PW, h).fill(color);
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#fff').text(text, MARGIN, 18);
  if (sub) doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.75)').text(sub, MARGIN, 44);
  doc.y = h + 12;
}

function sectionBox(doc, text, sub, color) {
  doc.addPage();
  const h = 46;
  doc.rect(0, 0, PW, h).fill(color);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#fff').text(text, MARGIN, 12);
  if (sub) doc.font('Helvetica').fontSize(8.5).fillColor('rgba(255,255,255,0.75)').text(sub, MARGIN, 30);
  doc.y = h + 14;
}

function hr(doc, color = '#ddd', w = 1) {
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + W, doc.y).strokeColor(color).lineWidth(w).stroke();
  doc.y += w + 3;
}

function kacheln(doc, items) {
  const kW  = Math.floor((W - (items.length - 1) * 8) / items.length);
  const top = doc.y;
  items.forEach(([label, value, color], i) => {
    const x = MARGIN + i * (kW + 8);
    doc.rect(x, top, kW, 46).fill(color);
    doc.font('Helvetica').fontSize(7.5).fillColor('rgba(255,255,255,0.72)').text(label, x + 8, top + 8, { width: kW - 12 });
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#fff').text(value, x + 8, top + 22, { width: kW - 12 });
  });
  doc.y = top + 54;
}

function tableRow(doc, cells, shade, bold = false) {
  const top = doc.y;
  if (shade) doc.rect(MARGIN, top, W, 20).fill('#f5f7fa');
  cells.forEach(([txt, x, w, align]) => {
    const opts = align ? { width: w, align } : { width: w };
    (bold ? doc.font('Helvetica-Bold') : doc.font('Helvetica'))
      .fontSize(9.5).fillColor('#222').text(txt, x, top + 5, opts);
  });
  doc.y = top + 20;
}

function drawKundenliste(doc, orders) {
  const bar    = orders.filter(o => o.payment === 'bar');
  const stripe = orders.filter(o => o.payment === 'stripe');

  function drawGroup(label, groupColor, list) {
    if (!list.length) return;
    const gy = doc.y;
    doc.rect(MARGIN, gy, W, 22).fill(groupColor);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#fff').text(label, MARGIN + 8, gy + 6, { width: W - 16 });
    doc.y = gy + 22 + 2;

    const hy = doc.y;
    doc.rect(MARGIN, hy, W, 16).fill('#eaeef3');
    const cols = [
      ['#',      MARGIN + 2,   30, 'left'],
      ['Datum',  MARGIN + 34,  40, 'left'],
      ['Kunde',  MARGIN + 76, 190, 'left'],
      ['Art',    MARGIN + 268, 80, 'left'],
      ['Betrag', MARGIN + 2,  W-4, 'right'],
    ];
    cols.forEach(([h, x, w, a]) =>
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#444').text(h, x, hy + 4, { width: w, align: a })
    );
    doc.y = hy + 16;
    hr(doc, '#ccc', 0.5);

    let sub = 0;
    list.forEach((o, i) => {
      if (doc.y > FOOTER - 24) { doc.addPage(); doc.y = MARGIN; }
      const ry = doc.y;
      if (i % 2 === 0) doc.rect(MARGIN, ry, W, 18).fill('#fafafa');
      doc.font('Helvetica').fontSize(9).fillColor('#222')
        .text(`${o.orderNum}`, MARGIN + 2,  ry + 4, { width: 30 })
        .text(o.date,           MARGIN + 34, ry + 4, { width: 40 })
        .text(o.name.substring(0, 30), MARGIN + 76, ry + 4, { width: 188 })
        .text(o.mode,           MARGIN + 268, ry + 4, { width: 80 });
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#222')
        .text(fmt(o.total), MARGIN + 2, ry + 4, { width: W - 4, align: 'right' });
      doc.y = ry + 18;
      sub += o.total;
    });

    const sy = doc.y;
    doc.rect(MARGIN, sy, W, 20).fill(groupColor + '28');
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Summe ${label}:`, MARGIN + 8, sy + 5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text(fmt(sub), MARGIN + 2, sy + 5, { width: W - 4, align: 'right' });
    doc.y = sy + 20 + 10;
  }

  drawGroup('Barzahlung', '#2c5282', bar);
  drawGroup('Online-Zahlung (Stripe)', '#276749', stripe);
}

function drawBarRechnung(doc, barOrders, stats, zeitraum, rgnr) {
  if (!barOrders.length) return;
  if (doc.y > FOOTER - 120) { doc.addPage(); doc.y = MARGIN; }
  doc.moveDown(0.5);
  hr(doc, '#aaa', 1);

  const bh = doc.y;
  doc.rect(MARGIN, bh, W, 28).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#fff').text('RECHNUNG – Barzahlungen', MARGIN + 8, bh + 8, { width: W * 0.6 });
  doc.font('Helvetica').fontSize(8.5).fillColor('rgba(255,255,255,0.7)').text(rgnr, MARGIN + 8, bh + 10, { width: W - 16, align: 'right' });
  doc.y = bh + 28 + 6;

  const addrY = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Rechnungssteller:', MARGIN, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444')
    .text('Abed Rachman Falah · FlueVate', MARGIN, addrY + 12)
    .text('Zur Goldbrede 30, 59269 Beckum', MARGIN, addrY + 22);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Rechnungsempfänger:', MARGIN + 270, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444')
    .text('Pizzeria Amoura', MARGIN + 270, addrY + 12)
    .text('Oststraße 48, 59269 Beckum', MARGIN + 270, addrY + 22);
  doc.y = addrY + 38;
  doc.font('Helvetica').fontSize(8.5).fillColor('#888').text(`Zeitraum: ${zeitraum}`, MARGIN, doc.y);
  doc.y += 12;

  const hy = doc.y;
  doc.rect(MARGIN, hy, W, 16).fill('#fef9e7');
  doc.font('Helvetica').fontSize(7.5).fillColor('#7a5c00')
    .text('ℹ  Nur Barzahlungen – Stripe-Gebühren wurden bereits automatisch beim Checkout einbehalten.', MARGIN + 6, hy + 4, { width: W - 12 });
  doc.y = hy + 16 + 6;

  hr(doc, '#333', 1);
  const th = doc.y;
  doc.rect(MARGIN, th, W, 16).fill('#1a1a2e');
  [
    ['#Nr',      MARGIN + 2,   34, 'left'],
    ['Datum',    MARGIN + 38,  40, 'left'],
    ['Kunde',    MARGIN + 80, 170, 'left'],
    ['Umsatz',   MARGIN + 252, 64, 'right'],
    ['Gebühr',   MARGIN + 318, 60, 'right'],
    ['5 % Prov', MARGIN + 380, 58, 'right'],
    ['Gesamt',   MARGIN + 2,  W-4, 'right'],
  ].forEach(([h, x, w, a]) =>
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff').text(h, x, th + 4, { width: w, align: a })
  );
  doc.y = th + 16;

  barOrders.forEach((o, i) => {
    if (doc.y > FOOTER - 20) { doc.addPage(); doc.y = MARGIN; }
    const sf   = SVC;
    const prov = (o.total - sf) * PROV;
    const ges  = sf + prov;
    const ry   = doc.y;
    if (i % 2 === 0) doc.rect(MARGIN, ry, W, 16).fill('#f8f9fc');
    doc.font('Helvetica').fontSize(8.5).fillColor('#222')
      .text(`${o.orderNum}`, MARGIN + 2,  ry + 4, { width: 34 })
      .text(o.date,          MARGIN + 38, ry + 4, { width: 40 })
      .text(o.name.substring(0, 24), MARGIN + 80, ry + 4, { width: 168 })
      .text(fmt(o.total),    MARGIN + 252, ry + 4, { width: 64,  align: 'right' })
      .text(fmt(sf),         MARGIN + 318, ry + 4, { width: 60,  align: 'right' })
      .text(fmt(prov),       MARGIN + 380, ry + 4, { width: 58,  align: 'right' });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1a1a2e')
      .text(fmt(ges), MARGIN + 2, ry + 4, { width: W - 4, align: 'right' });
    doc.y = ry + 16;
  });

  hr(doc, '#333', 1);

  const s1y = doc.y;
  doc.rect(MARGIN, s1y, W, 18).fill('#f0f4f8');
  doc.font('Helvetica').fontSize(9).fillColor('#333')
    .text('Servicegebühren', MARGIN + 8, s1y + 5)
    .text(`${barOrders.length} × 0,99 €`, MARGIN + 200, s1y + 5, { width: 140, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#222')
    .text(fmt(stats.barSvc), MARGIN + 2, s1y + 5, { width: W - 4, align: 'right' });
  doc.y = s1y + 18;

  const s2y = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor('#333')
    .text('Systemprovision (5 %)', MARGIN + 8, s2y + 5)
    .text(`5 % von ${fmt(stats.barNetto)}`, MARGIN + 200, s2y + 5, { width: 140, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#222')
    .text(fmt(stats.barProv), MARGIN + 2, s2y + 5, { width: W - 4, align: 'right' });
  doc.y = s2y + 18 + 4;

  const gy = doc.y;
  doc.rect(MARGIN, gy, W, 30).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff').text('RECHNUNGSBETRAG (netto)', MARGIN + 10, gy + 9, { width: W * 0.6 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffd700').text(fmt(stats.barBetrag), MARGIN + 2, gy + 8, { width: W - 4, align: 'right' });
  doc.y = gy + 30 + 8;

  const uy = doc.y;
  doc.rect(MARGIN, uy, W, 14).fill('#fef9e7');
  doc.font('Helvetica').fontSize(7.5).fillColor('#7a5c00')
    .text('Gemäß § 19 UStG wird keine Umsatzsteuer ausgewiesen (Kleinunternehmerregelung).', MARGIN + 6, uy + 3, { width: W - 12 });
  doc.y = uy + 14 + 8;
}

function pageFooter(doc, text) {
  doc.font('Helvetica').fontSize(7).fillColor('#bbb')
    .text(text, MARGIN, FOOTER + 10, { width: W, align: 'center' });
}

// ─────────────────────────────────────────────────────────────────────────────
// MONATSBERICHT GENERATOR
// ─────────────────────────────────────────────────────────────────────────────
async function makeMonatsbericht({ monat, von, bis, orders, wochen, jahr = '2026' }) {
  const stats  = calcStats(orders);
  const vonBis = `${von} – ${bis}`;

  return generatePdf(doc => {
    colorBox(doc, `Monatsbericht ${monat} ${jahr}`, `Pizzeria Amoura  ·  ${vonBis}`, '#1a1a2e');

    kacheln(doc, [
      ['Bestellungen gesamt', `${orders.length}`,       '#1a1a2e'],
      ['Davon Bar',           `${stats.bar.length}`,    '#2c5282'],
      ['Davon Stripe',        `${stats.stripe.length}`, '#276749'],
      ['Brutto-Umsatz',       fmt(stats.brutto),        '#744210'],
    ]);

    doc.moveDown(0.4);
    hr(doc);

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ABRECHNUNG', MARGIN, doc.y);
    doc.y += 14;
    tableRow(doc, [
      [`Servicegebühren  (0,99 € × ${orders.length})`, MARGIN + 8, W - 80, 'left'],
      [fmt(stats.svcFees), MARGIN + 2, W - 4, 'right'],
    ], false);
    tableRow(doc, [
      [`Systemprovision  (5 % auf ${fmt(stats.netto)})`, MARGIN + 8, W - 80, 'left'],
      [fmt(stats.prov), MARGIN + 2, W - 4, 'right'],
    ], true);
    tableRow(doc, [
      ['Mein Gesamtbetrag', MARGIN + 8, W - 80, 'left'],
      [fmt(stats.mein), MARGIN + 2, W - 4, 'right'],
    ], false, true);

    doc.y += 4;
    const ay = doc.y;
    doc.rect(MARGIN, ay, W, 28).fill('#e8f5e9');
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#2e7d32').text('Auszahlung an Pizzeria Amoura', MARGIN + 10, ay + 8, { width: W * 0.65 });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#2e7d32').text(fmt(stats.auszahl), MARGIN + 2, ay + 8, { width: W - 4, align: 'right' });
    doc.y = ay + 28 + 12;

    hr(doc, '#bbb');

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('WOCHENÜBERSICHT', MARGIN, doc.y);
    doc.y += 10;

    const wh = doc.y;
    doc.rect(MARGIN, wh, W, 18).fill('#1a1a2e');
    [
      ['Woche',        MARGIN + 4,   44, 'left'],
      ['Zeitraum',     MARGIN + 50, 155, 'left'],
      ['Bestellungen', MARGIN + 207, 70, 'right'],
      ['Bar',          MARGIN + 279, 50, 'right'],
      ['Stripe',       MARGIN + 331, 50, 'right'],
      ['Umsatz',       MARGIN + 2,  W-4, 'right'],
    ].forEach(([h, x, w, a]) =>
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff').text(h, x, wh + 5, { width: w, align: a })
    );
    doc.y = wh + 18;

    wochen.forEach((woche, i) => {
      const ws = calcStats(woche.orders);
      const ry = doc.y;
      if (i % 2 === 0) doc.rect(MARGIN, ry, W, 18).fill('#f5f7fa');
      [
        [`KW ${woche.kw}`,              MARGIN + 4,   44, 'left'],
        [`${woche.von} – ${woche.bis}`, MARGIN + 50, 155, 'left'],
        [`${woche.orders.length}`,      MARGIN + 207, 70, 'right'],
        [`${ws.bar.length}`,            MARGIN + 279, 50, 'right'],
        [`${ws.stripe.length}`,         MARGIN + 331, 50, 'right'],
        [fmt(ws.brutto),                MARGIN + 2,  W-4, 'right'],
      ].forEach(([t, x, ww, a]) =>
        doc.font('Helvetica').fontSize(9).fillColor('#222').text(t, x, ry + 4, { width: ww, align: a })
      );
      doc.y = ry + 18;
    });

    const tr = doc.y;
    doc.rect(MARGIN, tr, W, 20).fill('#1a1a2e');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#fff').text('GESAMT', MARGIN + 4, tr + 6, { width: 100 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffd700').text(fmt(stats.brutto), MARGIN + 2, tr + 6, { width: W - 4, align: 'right' });
    doc.y = tr + 20;

    sectionBox(doc, `Kundenliste ${monat} ${jahr}`, 'Bar und Stripe getrennt · alle Bestellungen', '#1a1a2e');
    drawKundenliste(doc, orders);

    sectionBox(doc, `Bar-Rechnung ${monat} ${jahr}`, 'FlueVate Online-Bestellsystem · nur Barzahlungen', '#1a1a2e');
    drawBarRechnung(doc, stats.bar, stats, vonBis, `Rg. MAI-${jahr}-BAR`);

    pageFooter(doc, `FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  Monatsbericht ${monat} ${jahr}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const OUT = 'c:\\Users\\muham\\Downloads\\Website';

  console.log('📅 Monatsbericht Mai 2026...');
  const maiPdf = await makeMonatsbericht({
    monat: 'Mai', von: '01.05.2026', bis: '31.05.2026',
    orders: ORDERS_MAI,
    wochen: [
      { kw: 18, von: '01.05.', bis: '03.05.', orders: ORDERS_MAI.filter(o => o.kw === 18) },
      { kw: 19, von: '04.05.', bis: '10.05.', orders: ORDERS_MAI.filter(o => o.kw === 19) },
      { kw: 20, von: '11.05.', bis: '17.05.', orders: ORDERS_MAI.filter(o => o.kw === 20) },
      { kw: 21, von: '18.05.', bis: '24.05.', orders: ORDERS_MAI.filter(o => o.kw === 21) },
      { kw: 22, von: '25.05.', bis: '31.05.', orders: ORDERS_MAI.filter(o => o.kw === 22) },
    ],
  });
  fs.writeFileSync(path.join(OUT, 'Amoura_Mai2026_Monatsbericht.pdf'), maiPdf);
  console.log('   ✅ Amoura_Mai2026_Monatsbericht.pdf');

  console.log('\n🎉 Fertig in:', OUT);
})();
