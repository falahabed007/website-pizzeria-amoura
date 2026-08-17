const express     = require('express');
const mongoose    = require('mongoose');
const cors        = require('cors');
const Stripe      = require('stripe');
const { Resend }  = require('resend');
const cron        = require('node-cron');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY nicht gesetzt');
  return Stripe(key);
}
function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('⚠️  RESEND_API_KEY fehlt'); return null; }
  return new Resend(key);
}

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://falahabed007.github.io',
  'https://pizzeria-parma-hamm.de',
  'https://www.pizzeria-parma-hamm.de',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, origin);
    cb(new Error('CORS nicht erlaubt: ' + origin));
  },
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));
app.options('*', cors());

app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const path = require('path');
app.use(express.static(path.join(__dirname), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// ═══════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════
const orderSchema = new mongoose.Schema({
  orderNum:              { type: Number, unique: true },
  mode:                  { type: String, enum: ['lieferung','abholung'], required: true },
  status:                { type: String, default: 'pending',
                           enum: ['awaiting_payment','pending','confirmed','preparing','ready','delivered','cancelled'] },
  payment:               { type: String, enum: ['bar','stripe','karte'], required: true },
  paymentStatus:         { type: String, default: 'unpaid', enum: ['unpaid','paid','pending','refunded'] },
  source:                { type: String, default: 'web', enum: ['web','pos'] },
  items:                 [{ name: String, price: Number, qty: Number, note: String, extraDetails: [{ name: String, price: Number }] }],
  customer:              { first: String, last: String, email: String, phone: String, street: String, house: String, city: String },
  subtotal:              Number,
  deliveryFee:           { type: Number, default: 0 },
  serviceFee:            { type: Number, default: 0.99 },
  total:                 Number,
  note:                  String,
  prepTime:              Number,
  cancelReason:          String,
  stripeSessionId:       String,
  stripePaymentIntentId: String,
}, { timestamps: true });

const counterSchema      = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const settingsSchema     = new mongoose.Schema({
  _id:            String,
  mode:           { type: String, default: 'online' },
  manualOverride: { type: Boolean, default: false },
  isOpen:         { type: Boolean, default: true },
});
const availabilitySchema = new mongoose.Schema({
  itemName:  { type: String, required: true, unique: true },
  available: { type: Boolean, default: false },
}, { timestamps: true });

const Order        = mongoose.model('Order', orderSchema);
const Counter      = mongoose.model('Counter', counterSchema);
const Settings     = mongoose.model('Settings', settingsSchema);
const Availability = mongoose.model('Availability', availabilitySchema);

async function getNextOrderNum() {
  const c = await Counter.findByIdAndUpdate('orderNum', { $inc: { seq: 1 } }, { new: true, upsert: true });
  return c.seq + 1000;
}
function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ message: 'Nicht autorisiert' });
  if (h.split(' ')[1] !== process.env.ADMIN_TOKEN_SECRET) return res.status(401).json({ message: 'Token ungültig' });
  next();
}

const cleanName = n => n.replace(/[A-Z0-9](,[A-Z0-9])+$/g, '').trimEnd();

// ═══════════════════════════════════════════════════════════════
// PDF HELPERS
// ═══════════════════════════════════════════════════════════════
// In E-Mail-Templates weiterverwendet:
const PRIMARY_COLOR = '#C41230';

function getWeekNum(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return Math.ceil((((date - new Date(Date.UTC(date.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7);
}

// ── FlueVate-Berichts-Design-System ───────────────────────────────
const FLUEVATE = { name: 'FlueVate', inhaber: 'Abed Rachman Falah', strasse: 'Zur Goldbrede 30', ort: '59269 Beckum' };
const REPORT   = { dark:'#1a1a1a', boxGray:'#595959', sumGray:'#cfcfcf', zebra:'#f4f4f4', rule:'#dddddd', text:'#222222', muted:'#888888' };
const RESTAURANT_NAME    = () => process.env.RESTAURANT_NAME    || 'Pizzeria Parma';
const RESTAURANT_ADRESSE = () => process.env.RESTAURANT_ADRESSE || 'Bahnhofstr. 37, 59065 Hamm';

const eur = n => (Number(n) || 0).toFixed(2).replace('.', ',') + ' €';

// Kennzahlen – datengetrieben, identisch zur Finance-calc
function reportTotals(orders) {
  const brutto    = orders.reduce((s, o) => s + (o.total || 0), 0);
  const svcFees   = orders.reduce((s, o) => s + (o.serviceFee || 0.99), 0);
  const nBar      = orders.filter(o => o.payment === 'bar').length;
  const nStripe   = orders.filter(o => o.payment === 'stripe' || o.payment === 'karte').length;
  return { count: orders.length, brutto, svcFees, nBar, nStripe };
}

// Wie generatePdf, aber mit bufferPages + Footer-Zeile auf allen Seiten.
function generateReportPdf(footerLabel, buildFn) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildFn(doc);
    const range = doc.bufferedPageRange();
    const txt = `${FLUEVATE.name} · ${FLUEVATE.inhaber} · ${FLUEVATE.strasse} · ${FLUEVATE.ort} · ${footerLabel}`;
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // im unteren Rand schreiben, sonst fügt PDFKit leere Seiten ein
      doc.fillColor(REPORT.muted).font('Helvetica').fontSize(7)
         .text(txt, 50, doc.page.height - 35, { width: doc.page.width - 100, align: 'center', lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

const CW = doc => doc.page.width - 100; // Inhaltsbreite (Margin 50 links/rechts)
function ensureSpace(doc, needed) { if (doc.y + needed > doc.page.height - 60) doc.addPage(); }

// Dunkles Vollbreiten-Header-Band mit Titel + Untertitel
function drawHeaderBand(doc, title, subtitle) {
  doc.save().rect(0, 0, doc.page.width, 96).fill(REPORT.dark).restore();
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(26).text(title, 50, 28);
  doc.fillColor('#cfcfcf').font('Helvetica').fontSize(10).text(subtitle, 50, 66);
  doc.fillColor(REPORT.text); doc.y = 120;
}

// 4 KPI-Kacheln (erste schwarz, Rest grau): boxes = [{ value, label }]
function drawKpiBoxes(doc, boxes) {
  const x0 = 50, top = doc.y, gap = 12, w = CW(doc), bw = (w - gap * 3) / 4, bh = 56;
  boxes.slice(0, 4).forEach((b, i) => {
    const x = x0 + i * (bw + gap);
    doc.save().rect(x, top, bw, bh).fill(i === 0 ? REPORT.dark : REPORT.boxGray).restore();
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(17).text(String(b.value), x + 12, top + 11, { width: bw - 24 });
    if (b.label) doc.font('Helvetica').fontSize(8).fillColor('#dddddd').text(b.label, x + 12, top + 38, { width: bw - 24 });
  });
  doc.fillColor(REPORT.text); doc.y = top + bh + 24;
}

// Section-Titel: uppercase + dünne Trennlinie
function drawSectionTitle(doc, text) {
  doc.moveDown(0.3);
  const y = doc.y;
  doc.fillColor(REPORT.text).font('Helvetica-Bold').fontSize(11).text(text.toUpperCase(), 50, y);
  doc.moveTo(50, doc.y + 3).lineTo(50 + CW(doc), doc.y + 3).lineWidth(0.7).strokeColor(REPORT.rule).stroke();
  doc.y += 14;
}

// Label-links / Wert-rechts Zeile
function drawKeyValueRow(doc, label, value, opts = {}) {
  const x = 50, w = CW(doc), h = 22, y = doc.y;
  if (opts.zebra) doc.save().rect(x, y, w, h).fill(REPORT.zebra).restore();
  doc.fillColor(REPORT.text).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
  doc.text(label, x + 10, y + 6, { width: w * 0.72 });
  doc.text(value, x, y + 6, { width: w - 10, align: 'right' });
  doc.y = y + h;
}

// Generische Tabelle: cols = [{ key, label, w, align }], rows = [{ key:value }]
function drawTableHeader(doc, cols) {
  const x = 50, w = CW(doc), y = doc.y, h = 20;
  doc.save().rect(x, y, w, h).fill(REPORT.zebra).restore();
  let cx = x; doc.fillColor('#666').font('Helvetica-Bold').fontSize(8);
  cols.forEach(c => { doc.text(c.label, cx + 6, y + 6, { width: c.w - 12, align: c.align || 'left' }); cx += c.w; });
  doc.y = y + h;
}
function drawTableRows(doc, cols, rows, fett = []) {
  const x = 50, w = CW(doc);
  rows.forEach((r, i) => {
    ensureSpace(doc, 18);
    const y = doc.y, h = 18;
    if (i % 2) doc.save().rect(x, y, w, h).fill(REPORT.zebra).restore();
    let cx = x;
    cols.forEach(c => {
      doc.fillColor(REPORT.text).font(fett.includes(c.key) ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      doc.text(r[c.key] == null ? '' : String(r[c.key]), cx + 6, y + 5, { width: c.w - 12, align: c.align || 'left' });
      cx += c.w;
    });
    doc.y = y + h;
  });
}

// Gruppierte Tabelle (KUNDENLISTE): groups = [{ title, rows, sumLabel, sumValue }]
function drawGroupedTable(doc, cols, groups, fett = ['betrag']) {
  const x = 50, w = CW(doc);
  groups.forEach(g => {
    ensureSpace(doc, 70);
    const ty = doc.y, th = 22;
    doc.save().rect(x, ty, w, th).fill(REPORT.boxGray).restore();
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text(g.title, x + 8, ty + 6);
    doc.y = ty + th;
    drawTableHeader(doc, cols);
    drawTableRows(doc, cols, g.rows, fett);
    const sy = doc.y, sh = 20;
    doc.save().rect(x, sy, w, sh).fill(REPORT.sumGray).restore();
    doc.fillColor(REPORT.text).font('Helvetica-Bold').fontSize(9).text(g.sumLabel, x + 8, sy + 6, { width: w * 0.6 });
    doc.text(g.sumValue, x, sy + 6, { width: w - 10, align: 'right' });
    doc.y = sy + sh + 14;
  });
}

// KUNDENLISTE: Bestellungen nach Zahlart gruppiert (Bar / Online-Stripe)
function drawKundenliste(doc, orders) {
  const cols = [
    { key:'nr', label:'#', w:50 }, { key:'datum', label:'Datum', w:60 },
    { key:'kunde', label:'Kunde', w:215 }, { key:'art', label:'Art', w:90 },
    { key:'betrag', label:'Betrag', w:80, align:'right' },
  ];
  const toRow = o => ({
    nr: o.orderNum,
    datum: new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }),
    kunde: `${o.customer?.first || ''} ${o.customer?.last || ''}`.trim(),
    art:   o.mode === 'lieferung' ? 'Lieferung' : 'Abholung',
    betrag: eur(o.total),
  });
  const bar    = orders.filter(o => o.payment === 'bar');
  const stripe = orders.filter(o => o.payment === 'stripe' || o.payment === 'karte');
  const groups = [];
  if (bar.length)    groups.push({ title:'Barzahlung', rows: bar.map(toRow),
    sumLabel:'Summe Barzahlung:', sumValue: eur(bar.reduce((s, o) => s + (o.total || 0), 0)) });
  if (stripe.length) groups.push({ title:'Online-Zahlung (Stripe)', rows: stripe.map(toRow),
    sumLabel:'Summe Online-Zahlung (Stripe):', sumValue: eur(stripe.reduce((s, o) => s + (o.total || 0), 0)) });
  drawGroupedTable(doc, cols, groups);
}

// Tagesbericht — Header + KPI + Kundenliste
function buildTagesbericht(doc, orders, dateStr) {
  const t = reportTotals(orders);
  drawHeaderBand(doc, 'Tagesbericht', `${RESTAURANT_NAME()} · ${dateStr}`);
  drawKpiBoxes(doc, [
    { value: t.count,        label: 'Bestellungen' },    { value: t.nBar,    label: 'Barzahlung' },
    { value: t.nStripe,      label: 'Online (Stripe)' }, { value: eur(t.brutto), label: 'Umsatz' },
  ]);
  drawSectionTitle(doc, 'Kundenliste');
  drawKundenliste(doc, orders);
}

// Monatsbericht — Header + KPI + Wochenübersicht + Kundenliste (reine Verkaufs-Zusammenfassung; Rechnung läuft über Lexware)
function buildMonatsbericht(doc, orders, range) {
  const t = reportTotals(orders);
  drawHeaderBand(doc, `Monatsbericht ${range.label}`, `${RESTAURANT_NAME()} · ${range.von} – ${range.bis}`);
  drawKpiBoxes(doc, [
    { value: t.count,        label: 'Bestellungen' },    { value: t.nBar,    label: 'Barzahlung' },
    { value: t.nStripe,      label: 'Online (Stripe)' }, { value: eur(t.brutto), label: 'Umsatz' },
  ]);
  drawSectionTitle(doc, 'Wochenübersicht');
  const byWeek = {};
  orders.forEach(o => { const kw = getWeekNum(new Date(o.createdAt));
    (byWeek[kw] = byWeek[kw] || { n: 0, sum: 0 }); byWeek[kw].n++; byWeek[kw].sum += o.total || 0; });
  Object.keys(byWeek).sort((a, b) => a - b).forEach((kw, i) =>
    drawKeyValueRow(doc, `KW ${kw}  ·  ${byWeek[kw].n} Bestellungen`, eur(byWeek[kw].sum), { zebra: i % 2 === 0 }));
  drawSectionTitle(doc, 'Kundenliste');
  drawKundenliste(doc, orders);
}

// ═══════════════════════════════════════════════════════════════
// E-MAIL HELPERS
// ═══════════════════════════════════════════════════════════════
async function sendConfirmationEmail(order, mins) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const m    = mins || order.prepTime || (order.mode === 'lieferung' ? 45 : 20);
  const addr = order.mode === 'lieferung'
    ? `${order.customer.street} ${order.customer.house}, ${order.customer.city}`
    : 'Bahnhofstr. 37, 59065 Hamm (Abholung)';
  const rows = (order.items || []).map(i =>
    `<tr><td>${i.qty}×</td><td>${cleanName(i.name)}${i.note ? ' <em>(' + i.note + ')</em>' : ''}</td><td style="text-align:right">${(i.price * i.qty).toFixed(2).replace('.', ',')} €</td></tr>`
  ).join('');
  await getResend()?.emails.send({
    from: process.env.EMAIL_FROM,
    to:   order.customer.email,
    subject: `✅ Bestellung #${order.orderNum} bestätigt – Pizzeria Parma`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:${PRIMARY_COLOR};color:#fff;padding:22px;text-align:center">
        <h1 style="margin:0">🍕 Pizzeria Parma</h1>
        <p style="margin:4px 0 0;opacity:.8;font-size:13px">Bahnhofstr. 37 · 59065 Hamm</p>
      </div>
      <div style="padding:26px 22px">
        <h2 style="color:${PRIMARY_COLOR}">Bestellung #${order.orderNum} bestätigt ✅</h2>
        <p>Hallo <strong>${order.customer.first}</strong>, deine Bestellung ist in der Küche!</p>
        <div style="background:#fff8f0;border-left:4px solid #C8A851;padding:12px 16px;border-radius:0 8px 8px 0;margin:14px 0">
          <p style="margin:0 0 4px;font-weight:bold">${order.mode === 'lieferung' ? '🛵 Lieferung' : '🏃 Abholung'}</p>
          <p style="margin:0;font-size:13px;color:#666">${addr}</p>
          <p style="margin:4px 0 0;font-size:15px;font-weight:bold;color:${PRIMARY_COLOR}">⏱ Voraussichtlich ~${m} Minuten</p>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin:14px 0">
          <thead><tr style="border-bottom:2px solid #eee"><th align="left">Menge</th><th align="left">Artikel</th><th align="right">Preis</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="border-top:1px solid #eee;padding-top:10px;font-size:13px">
          ${order.deliveryFee > 0 ? `<div style="display:flex;justify-content:space-between;color:#666"><span>Liefergebühr</span><span>${order.deliveryFee.toFixed(2).replace('.', ',')} €</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;color:#666"><span>Servicegebühr</span><span>${(order.serviceFee || 0.99).toFixed(2).replace('.', ',')} €</span></div>
          <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:15px;border-top:2px solid ${PRIMARY_COLOR};padding-top:8px;margin-top:6px">
            <span>Gesamt</span><span style="color:${PRIMARY_COLOR}">${(order.total || 0).toFixed(2).replace('.', ',')} €</span>
          </div>
        </div>
      </div>
      <div style="background:#f7f3ee;padding:14px;text-align:center;font-size:11px;color:#999">Pizzeria Parma · Bahnhofstr. 37 · Tel: (02381) 94 107 02</div>
    </div>`
  });
}

async function sendRestaurantEmail(order) {
  if (!process.env.RESTAURANT_EMAIL) return;
  const items = (order.items || []).map(i => {
    const base   = `${i.qty}× ${cleanName(i.name)}${i.note ? ' (' + i.note + ')' : ''}`;
    const extras = (i.extraDetails || []).map(e => `   ↳ ${e.name}${e.price > 0 ? ' (+' + e.price.toFixed(2) + '€)' : ''}`).join('\n');
    return extras ? base + '\n' + extras : base;
  }).join('\n');
  await getResend()?.emails.send({
    from: process.env.EMAIL_FROM,
    to:   process.env.RESTAURANT_EMAIL,
    subject: `🔔 Bestellung #${order.orderNum} – ${order.mode === 'lieferung' ? 'Lieferung' : 'Abholung'}`,
    html: `<pre style="font-family:monospace;font-size:13px">BESTELLUNG #${order.orderNum} · ${order.source === 'pos' ? 'POS' : 'ONLINE'}
Art:    ${order.mode === 'lieferung' ? '🛵 LIEFERUNG' : '🏃 ABHOLUNG'}
Kunde:  ${order.customer?.first} ${order.customer?.last}
Tel:    ${order.customer?.phone || '–'}
${order.mode === 'lieferung' ? `Adresse: ${order.customer?.street} ${order.customer?.house}, ${order.customer?.city}` : ''}

ARTIKEL:
${items}

Zwischensumme: ${(order.subtotal || 0).toFixed(2)} €
${order.deliveryFee ? `Liefergebühr:  ${order.deliveryFee.toFixed(2)} €` : ''}
Servicegebühr: ${(order.serviceFee || 0.99).toFixed(2)} €
GESAMT:        ${(order.total || 0).toFixed(2)} €

Zahlung: ${order.payment === 'stripe' ? 'KREDITKARTE' : order.payment === 'karte' ? 'EC-KARTE' : 'BAR'} – ${order.paymentStatus === 'paid' ? '✅ BEZAHLT' : '❌ NOCH OFFEN'}
${order.note ? `Anmerkung: ${order.note}` : ''}</pre>`
  });
}

async function sendCancellationEmail(order, reason, refundStatus) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const refundHtml = (order.payment === 'stripe' && refundStatus === 'succeeded')
    ? `<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px;margin:14px 0">
        <strong style="color:#2e7d32">💸 Rückerstattung eingeleitet</strong><br>
        <span style="font-size:13px;color:#555">Der Betrag von ${(order.total || 0).toFixed(2).replace('.', ',')} € wird in 5–10 Werktagen zurückgebucht.</span>
       </div>` : '';
  await getResend()?.emails.send({
    from: process.env.EMAIL_FROM,
    to:   order.customer.email,
    subject: `❌ Bestellung #${order.orderNum} storniert – Pizzeria Parma`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:${PRIMARY_COLOR};color:#fff;padding:22px;text-align:center"><h1 style="margin:0">🍕 Pizzeria Parma</h1></div>
      <div style="padding:26px 22px">
        <h2>Bestellung #${order.orderNum} storniert</h2>
        <p>Hallo <strong>${order.customer.first}</strong>, deine Bestellung wurde leider storniert.</p>
        ${reason ? `<div style="background:#fff3ea;border-radius:8px;padding:12px;margin:14px 0"><strong>Grund:</strong> ${reason}</div>` : ''}
        ${refundHtml}
        <p>Bei Fragen: <strong>(02381) 94 107 02</strong></p>
      </div>
    </div>`
  });
}

async function triggerPrint(order) {
  if (!process.env.PRINTNODE_API_KEY || !process.env.PRINTNODE_PRINTER_ID) return;
  try { const p = require('./printnode-helper'); await p.printOrder(order); }
  catch(e) { console.error('PrintNode:', e); }
}

// ═══════════════════════════════════════════════════════════════
// AUTO-MODUS
// ═══════════════════════════════════════════════════════════════
function calcAutoMode() {
  const now = new Date();
  const str = now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const m   = str.match(/(\d+)\.(\d+)\.(\d+),\s*(\d+):(\d+)/);
  if (!m) return 'geschlossen';
  const h    = parseInt(m[4]);
  const min  = parseInt(m[5]);
  const mins = h * 60 + min;
  // Pizzeria Parma: Täglich 11:30 – 24:00
  if (mins >= 11 * 60 + 30) return 'online';
  return 'geschlossen';
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// Status
app.get('/api/status', async (req, res) => {
  try {
    let s = await Settings.findById('main');
    if (!s) s = await Settings.findByIdAndUpdate('main', { mode: calcAutoMode(), manualOverride: false }, { new: true, upsert: true });
    res.json({ mode: s.mode, manualOverride: s.manualOverride, isOpen: s.mode === 'online' });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Verfügbarkeit (public)
app.get('/api/availability', async (req, res) => {
  try {
    const items    = await Availability.find({});
    const disabled = items.filter(i => !i.available).map(i => i.itemName);
    res.json({ disabled });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Bestellung aufgeben
app.post('/api/orders', async (req, res) => {
  try {
    const body      = req.body;
    const orderNum  = await getNextOrderNum();
    const isPOS     = body.source === 'pos';
    const order     = new Order({
      ...body,
      orderNum,
      status:        isPOS ? 'confirmed' : 'pending',
      paymentStatus: body.paymentStatus || (body.payment === 'stripe' ? 'pending' : 'unpaid'),
    });
    await order.save();
    if (isPOS) {
      await sendConfirmationEmail(order, order.prepTime || 20);
      await sendRestaurantEmail(order);
      await triggerPrint(order);
    }
    res.json({ orderNum, _id: order._id });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Stripe Checkout
app.post('/api/create-stripe-checkout', async (req, res) => {
  try {
    const body     = req.body;
    const orderNum = await getNextOrderNum();
    const stripe   = getStripe();
    const items    = body.items || [];
    const stripeFee = Math.round((body.total * 0.015 + 0.25) * 100);
    const appFee    = Math.round((body.serviceFee + body.subtotal * 0.05) * 100) + stripeFee;
    const sessionOpts = {
      line_items: [
        ...items.filter(i => i.price > 0).map(i => ({
          price_data: { currency: 'eur', product_data: { name: `${i.qty}× ${cleanName(i.name)}` }, unit_amount: Math.round(i.price * 100) },
          quantity: i.qty,
        })),
        { price_data: { currency:'eur', product_data:{ name:'Servicegebühr' }, unit_amount: Math.round(body.serviceFee * 100) }, quantity: 1 },
        ...(body.deliveryFee > 0 ? [{ price_data:{ currency:'eur', product_data:{ name:'Liefergebühr' }, unit_amount: Math.round(body.deliveryFee * 100) }, quantity:1 }] : []),
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}?order=${orderNum}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}?payment=cancelled`,
      metadata: { orderNum: String(orderNum) },
    };
    if (process.env.STRIPE_CONNECT_ACCOUNT) {
      sessionOpts.payment_method_types = ['card'];
      sessionOpts.payment_intent_data  = { application_fee_amount: appFee, transfer_data: { destination: process.env.STRIPE_CONNECT_ACCOUNT } };
    } else {
      sessionOpts.automatic_payment_methods = { enabled: true };
    }
    const session = await stripe.checkout.sessions.create(sessionOpts);
    const order   = new Order({
      ...body, orderNum, status: 'awaiting_payment',
      paymentStatus: 'pending', stripeSessionId: session.id,
    });
    await order.save();
    res.json({ url: session.url, orderNum });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Stripe Webhook
app.post('/api/stripe-webhook', async (req, res) => {
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) { return res.status(400).send(`Webhook Error: ${e.message}`); }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const order   = await Order.findOne({ stripeSessionId: session.id });
    if (order && order.status === 'awaiting_payment') {
      order.paymentStatus         = 'paid';
      order.status                = 'pending';
      order.stripePaymentIntentId = session.payment_intent;
      await order.save();
    }
  }
  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    const order   = await Order.findOne({ stripeSessionId: session.id });
    if (order && order.status === 'awaiting_payment') { order.status = 'cancelled'; await order.save(); }
  }
  res.json({ received: true });
});

// Verify Payment (Fallback)
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false });
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') return res.json({ ok: false });
    const order = await Order.findOne({ stripeSessionId: sessionId });
    if (!order) return res.status(404).json({ ok: false });
    if (order.status === 'awaiting_payment') {
      order.paymentStatus         = 'paid';
      order.status                = 'pending';
      order.stripePaymentIntentId = session.payment_intent;
      await order.save();
    }
    res.json({ ok: true, orderNum: order.orderNum });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// Admin Login
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD)
    return res.json({ token: process.env.ADMIN_TOKEN_SECRET });
  res.status(401).json({ message: 'Falsches Passwort' });
});

// Admin Status
app.get('/api/admin/status', authMiddleware, async (req, res) => {
  try {
    const s = await Settings.findById('main') || { mode: calcAutoMode(), manualOverride: false };
    res.json({ mode: s.mode, manualOverride: s.manualOverride, autoMode: calcAutoMode() });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

app.patch('/api/admin/status', authMiddleware, async (req, res) => {
  try {
    const update = {};
    if (req.body.mode !== undefined) update.mode = req.body.mode;
    if (req.body.manualOverride !== undefined) {
      update.manualOverride = req.body.manualOverride;
      if (req.body.manualOverride === false) update.mode = calcAutoMode();
    }
    const s = await Settings.findByIdAndUpdate('main', update, { new: true, upsert: true });
    res.json({ mode: s.mode, manualOverride: s.manualOverride });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Pending orders
app.get('/api/admin/orders/pending', authMiddleware, async (req, res) => {
  try { res.json({ pending: await Order.find({ status: 'pending' }).sort({ createdAt: 1 }) }); }
  catch(e) { res.status(500).json({ message: 'Fehler' }); }
});

// All orders
app.get('/api/admin/orders', authMiddleware, async (req, res) => {
  try {
    const dateParam = req.query.date;
    if (dateParam) {
      const from = new Date(dateParam + 'T00:00:00+02:00');
      const to   = new Date(dateParam + 'T23:59:59+02:00');
      const orders = await Order.find({ status: { $nin: ['pending','awaiting_payment'] }, createdAt: { $gte: from, $lte: to } }).sort({ createdAt: -1 });
      const valid  = orders.filter(o => o.status !== 'cancelled');
      return res.json({
        orders,
        stats: {
          todayCount:   orders.length,
          todayRevenue: valid.reduce((s, o) => s + (o.total || 0), 0),
          active:       orders.filter(o => ['confirmed','preparing'].includes(o.status)).length,
          done:         orders.filter(o => ['ready','delivered'].includes(o.status)).length,
          cancelled:    orders.filter(o => o.status === 'cancelled').length,
          unpaid:       orders.filter(o => o.paymentStatus !== 'paid' && o.status !== 'cancelled').length,
        }
      });
    }
    const orders = await Order.find({ status: { $nin: ['pending'] } }).sort({ createdAt: -1 });
    const today  = new Date(); today.setHours(0, 0, 0, 0);
    const tod    = orders.filter(o => new Date(o.createdAt) >= today && o.status !== 'awaiting_payment');
    res.json({
      orders,
      stats: {
        todayCount:   tod.length,
        todayRevenue: tod.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (o.total || 0), 0),
        active:       tod.filter(o => ['confirmed','preparing'].includes(o.status)).length,
        done:         tod.filter(o => ['ready','delivered'].includes(o.status)).length,
        cancelled:    tod.filter(o => o.status === 'cancelled').length,
        unpaid:       orders.filter(o => o.paymentStatus !== 'paid' && o.status !== 'cancelled' && o.status !== 'awaiting_payment').length,
      }
    });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Order by ID
app.get('/api/admin/orders/:id', authMiddleware, async (req, res) => {
  try { res.json(await Order.findById(req.params.id)); }
  catch(e) { res.status(500).json({ message: e.message }); }
});

// Confirm order
app.patch('/api/admin/orders/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id,
      { status: 'confirmed', prepTime: req.body.estimatedMinutes }, { new: true });
    await sendConfirmationEmail(order, req.body.estimatedMinutes);
    await sendRestaurantEmail(order);
    await triggerPrint(order);
    res.json(order);
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Status update
app.patch('/api/admin/orders/:id/status', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    res.json(order);
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Payment toggle
app.patch('/api/admin/orders/:id/payment', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, { paymentStatus: req.body.paymentStatus }, { new: true });
    res.json(order);
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Print
app.post('/api/admin/orders/:id/print', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Nicht gefunden' });
    await triggerPrint(order);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ message: 'Druckfehler' }); }
});

// Cancel / Storno
app.delete('/api/admin/orders/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Nicht gefunden' });
    let refundStatus = null;
    if (order.payment === 'stripe' && order.paymentStatus === 'paid' && order.stripePaymentIntentId) {
      // Bei Connect: reverse_transfer zieht die Erstattung vom verbundenen Konto (Restaurant) zurück statt von der Plattform
      const refundParams = { payment_intent: order.stripePaymentIntentId };
      if (process.env.STRIPE_CONNECT_ACCOUNT) refundParams.reverse_transfer = true;
      const refund = await getStripe().refunds.create(refundParams);
      refundStatus      = refund.status;
      order.paymentStatus = 'refunded';
    }
    order.status       = 'cancelled';
    order.cancelReason = req.body.cancelReason || '';
    await order.save();
    await sendCancellationEmail(order, req.body.cancelReason, refundStatus);
    res.json({ success: true, refundStatus });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Finance
app.get('/api/admin/finance', authMiddleware, async (req, res) => {
  try {
    const today  = new Date(); today.setHours(0, 0, 0, 0);
    const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const calc   = list => {
      const brutto    = list.reduce((s, o) => s + (o.total || 0), 0);
      const svcFees   = list.reduce((s, o) => s + (o.serviceFee || 0.99), 0);
      const provision = (brutto - svcFees) * 0.05;
      return { count: list.length, brutto, svcFees, provision, auszahlung: brutto - svcFees - provision };
    };
    const filter  = { status: { $in: ['confirmed','preparing','ready','delivered'] } };
    const todayO  = await Order.find({ ...filter, createdAt: { $gte: today } });
    const weekO   = await Order.find({ ...filter, createdAt: { $gte: monday } });
    res.json({ today: calc(todayO), week: calc(weekO) });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Availability Admin
app.get('/api/admin/availability', authMiddleware, async (req, res) => {
  try { res.json({ items: await Availability.find({}) }); }
  catch(e) { res.status(500).json({ message: e.message }); }
});

app.patch('/api/admin/availability', authMiddleware, async (req, res) => {
  try {
    const { itemName, available } = req.body;
    await Availability.findOneAndUpdate({ itemName }, { available }, { upsert: true, new: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// Recover Stripe Orders
app.post('/api/admin/recover-stripe-orders', authMiddleware, async (req, res) => {
  try {
    const stuck     = await Order.find({ status: 'awaiting_payment', payment: 'stripe' });
    const recovered = [];
    for (const order of stuck) {
      const session = await getStripe().checkout.sessions.retrieve(order.stripeSessionId);
      if (session.payment_status === 'paid') {
        order.paymentStatus         = 'paid';
        order.status                = 'pending';
        order.stripePaymentIntentId = session.payment_intent;
        await order.save();
        recovered.push(order.orderNum);
      }
    }
    res.json({ recovered, total: stuck.length });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════════════════════════

// Auto-Modus (jede Minute)
cron.schedule('* * * * *', async () => {
  const s = await Settings.findById('main');
  if (s?.manualOverride) return;
  await Settings.findByIdAndUpdate('main', { mode: calcAutoMode() }, { upsert: true });
});

// Tagesbericht (täglich 22:00) — FlueVate-Design, an RESTAURANT_EMAIL
cron.schedule('0 22 * * *', async () => {
  try {
    const now   = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end   = new Date(now); end.setHours(23, 59, 59, 999);
    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: { $nin: ['cancelled', 'awaiting_payment'] }
    }).sort({ orderNum: 1 });
    if (!orders.length) return;
    if (!process.env.RESTAURANT_EMAIL) return;
    const total   = orders.reduce((s, o) => s + (o.total || 0), 0);
    const dateStr = now.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
    const pdf     = await generateReportPdf(`Tagesbericht ${now.toLocaleDateString('de-DE')}`,
      d => buildTagesbericht(d, orders, dateStr));
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM,
      to:   process.env.RESTAURANT_EMAIL,
      subject: `📊 Tagesbericht ${dateStr} · ${RESTAURANT_NAME()}`,
      html: `<p style="font-family:Arial;color:#555">Tagesbericht im Anhang.<br><b>${orders.length} Bestellungen · ${eur(total)}</b></p>`,
      attachments: [{ filename: `Tagesbericht_${now.toISOString().slice(0, 10)}_PizzeriaParma.pdf`, content: pdf.toString('base64') }],
    });
    console.log(`📊 Tagesbericht ${dateStr} versendet`);
  } catch(e) { console.error('Tagesbericht:', e); }
});

// Monatsbericht (letzter Tag des Monats 23:58) — FlueVate-Design, an OWNER_EMAIL
// Rechnungsstellung läuft separat über Lexware → kein Bar-Rechnungs-PDF.
cron.schedule('58 23 * * *', async () => {
  const now      = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (tomorrow.getDate() !== 1) return; // nur am letzten Tag
  try {
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const mEnd   = new Date(now); mEnd.setHours(23, 59, 59, 999);
    const orders = await Order.find({
      status: { $in: ['confirmed','preparing','ready','delivered'] },
      createdAt: { $gte: mStart, $lte: mEnd }
    }).sort({ orderNum: 1 });
    if (!orders.length) return;
    const brutto = orders.reduce((s, o) => s + (o.total || 0), 0);
    const range  = {
      label: now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }),
      von:   mStart.toLocaleDateString('de-DE'),
      bis:   now.toLocaleDateString('de-DE'),
    };
    const pdf = await generateReportPdf(`Monatsbericht ${range.label}`,
      d => buildMonatsbericht(d, orders, range));
    const recipient = process.env.OWNER_EMAIL || process.env.RESTAURANT_EMAIL;
    if (recipient) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM,
        to:   recipient,
        subject: `📅 Monatsbericht ${range.label} · ${RESTAURANT_NAME()}`,
        html: `<p style="font-family:Arial;color:#555">Monatsbericht ${range.label} im Anhang.<br><b>${orders.length} Bestellungen · ${eur(brutto)}</b></p>`,
        attachments: [{ filename: `${range.label.replace(' ', '_')}_PizzeriaParma_Monatsbericht.pdf`, content: pdf.toString('base64') }],
      });
    }
    console.log(`📅 Monatsbericht ${range.label} versendet`);
  } catch(e) { console.error('Monatsbericht:', e); }
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// HISTORIE & AUSWERTUNG  (für die Fluevate-Kasse-App)
// ═══════════════════════════════════════════════════════════════
// GET /api/admin/history?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Liefert Kennzahlen, Tageswerte UND die Bestellungen eines Zeitraums in einer Antwort.
// /api/admin/finance kennt nur "heute" und "diese Woche" – für Monatsumsatz und
// Bestellhistorie reicht das nicht.
//
// Zeitzone: die Tagesgrenzen richten sich nach Europe/Berlin, nicht nach UTC. Sonst
// landen Bestellungen zwischen 22:00 und 24:00 im falschen Tag.
app.get('/api/admin/history', authMiddleware, async (req, res) => {
  try {
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const berlinDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });

    const from = isDate(req.query.from) ? req.query.from : berlinDay(new Date());
    const to   = isDate(req.query.to)   ? req.query.to   : from;
    if (to < from) return res.status(400).json({ message: 'Zeitraum ist verdreht' });

    // Grosszuegiges UTC-Fenster laden und danach exakt nach Berliner Tagen filtern –
    // das ist auch bei der Sommerzeitumstellung korrekt.
    const padFrom = new Date(from + 'T00:00:00Z'); padFrom.setUTCDate(padFrom.getUTCDate() - 1);
    const padTo   = new Date(to   + 'T23:59:59Z'); padTo.setUTCDate(padTo.getUTCDate() + 1);

    const raw = await Order.find({
      status:    { $nin: ['awaiting_payment'] },
      createdAt: { $gte: padFrom, $lte: padTo }
    }).sort({ createdAt: -1 }).limit(3000);

    const all = raw.filter(o => {
      const k = berlinDay(o.createdAt);
      return k >= from && k <= to;
    });

    // Stornierte Bestellungen zaehlen nicht zum Umsatz, aber sehr wohl zur Statistik.
    const valid = all.filter(o => o.status !== 'cancelled');
    const r2  = n => Math.round((n + Number.EPSILON) * 100) / 100;
    const sum = pick => valid.reduce((s, o) => s + (pick(o) || 0), 0);

    const brutto  = sum(o => o.total);
    const svcFees = sum(o => o.serviceFee);

    const byPayment = {};
    valid.forEach(o => {
      const k = o.payment || 'unbekannt';
      byPayment[k] = (byPayment[k] || 0) + 1;
    });

    const days = {};
    valid.forEach(o => {
      const k = berlinDay(o.createdAt);
      if (!days[k]) days[k] = { date: k, count: 0, brutto: 0 };
      days[k].count  += 1;
      days[k].brutto += (o.total || 0);
    });

    res.json({
      from, to,
      stats: {
        count:        valid.length,
        brutto:       r2(brutto),
        svcFees:      r2(svcFees),
        deliveryFees: r2(sum(o => o.deliveryFee)),
        auszahlung:   r2(brutto - svcFees),
        cancelled:    all.length - valid.length,
        unpaid:       valid.filter(o => o.paymentStatus !== 'paid').length,
        byPayment
      },
      byDay: Object.values(days)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(d => ({ date: d.date, count: d.count, brutto: r2(d.brutto) })),
      // Begrenzt, damit die Antwort auf einem Kassengeraet handhabbar bleibt.
      orders: all.slice(0, 500)
    });
  } catch (e) {
    console.error('history:', e);
    res.status(500).json({ message: 'Fehler' });
  }
});


mongoose.connect(process.env.MONGODB_URI).then(() => {
  app.listen(PORT, () => console.log(`🚀 Pizzeria Parma Server läuft auf Port ${PORT}`));
}).catch(err => console.error('MongoDB Verbindung fehlgeschlagen:', err));
