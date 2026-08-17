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
async function getNextRechnungNum() {
  const c = await Counter.findByIdAndUpdate('rechnungNum', { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `RE-${new Date().getFullYear()}-${String(c.seq).padStart(4,'0')}`;
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
const PDF_M  = 50;
const PDF_W  = 495;
const PDF_PW = 595;
const PDF_FT = 810;
const PDF_SV = 0.99;
const PDF_PR = 0.05;
const PRIMARY_COLOR = '#C41230';
const pdfFmt = n => n.toFixed(2).replace('.', ',') + ' €';

function generatePdf(buildFn) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildFn(doc);
    doc.end();
  });
}
function getWeekNum(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return Math.ceil((((date - new Date(Date.UTC(date.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7);
}
function pdfColorBox(doc, title, sub, color = PRIMARY_COLOR, h = 70) {
  doc.rect(0, 0, PDF_PW, h).fill(color);
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#fff').text(title, PDF_M, 18);
  if (sub) doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.75)').text(sub, PDF_M, 44);
  doc.y = h + 14;
}
function pdfHr(doc, color = '#ddd', lw = 0.5) {
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M + PDF_W, doc.y).strokeColor(color).lineWidth(lw).stroke();
  doc.y += 6;
}
function pdfKacheln(doc, items) {
  const kW = Math.floor((PDF_W - (items.length - 1) * 8) / items.length);
  items.forEach(([label, val, color], i) => {
    const x = PDF_M + i * (kW + 8);
    doc.rect(x, doc.y, kW, 52).fill(color);
    doc.font('Helvetica').fontSize(8).fillColor('rgba(255,255,255,0.75)').text(label, x + 8, doc.y + 8, { width: kW - 16 });
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#fff').text(val, x + 8, doc.y + 22, { width: kW - 16 });
  });
  doc.y += 62;
}
function pdfTableRow(doc, cells, shade, bold = false) {
  const top = doc.y;
  if (shade) doc.rect(PDF_M, top, PDF_W, 20).fill('#f5f7fa');
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#222');
  cells.forEach(([text, x, w, align]) => doc.text(text, x, top + 5, { width: w, align }));
  doc.y = top + 20;
}
function pdfKundenliste(doc, orders) {
  [
    { label: 'Barzahlung', color: PRIMARY_COLOR,  list: orders.filter(o => o.payment === 'bar') },
    { label: 'Stripe',     color: '#276749',       list: orders.filter(o => o.payment !== 'bar') },
  ].forEach(({ label, color, list }) => {
    if (!list.length) return;
    const gy = doc.y; if (gy > PDF_FT - 60) { doc.addPage(); doc.y = PDF_M; }
    doc.rect(PDF_M, gy, PDF_W, 22).fill(color);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#fff').text(`${label} (${list.length})`, PDF_M + 8, gy + 6, { width: PDF_W - 16 });
    doc.y = gy + 22;
    const hy = doc.y;
    doc.rect(PDF_M, hy, PDF_W, 16).fill('#eaeef3');
    [['#', PDF_M+2, 30, 'left'], ['Datum', PDF_M+34, 40, 'left'], ['Kunde', PDF_M+76, 190, 'left'],
     ['Art', PDF_M+268, 80, 'left'], ['Betrag', PDF_M+2, PDF_W-4, 'right']
    ].forEach(([t, x, w, a]) => doc.font('Helvetica-Bold').fontSize(8).fillColor('#444').text(t, x, hy+4, { width:w, align:a }));
    doc.y = hy + 16;
    let sub = 0;
    list.forEach((o, i) => {
      if (doc.y > PDF_FT - 24) { doc.addPage(); doc.y = PDF_M; }
      const ry   = doc.y;
      const name = `${o.customer?.first||''} ${o.customer?.last||''}`.trim() || '–';
      const date = new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' });
      const ms   = o.mode === 'lieferung' ? 'Lieferung' : 'Abholung';
      sub += o.total || 0;
      if (i % 2 === 0) doc.rect(PDF_M, ry, PDF_W, 18).fill('#fafafa');
      doc.font('Helvetica').fontSize(8.5).fillColor('#222')
        .text(`${o.orderNum}`, PDF_M+2,   ry+4, { width:30 })
        .text(date,            PDF_M+34,  ry+4, { width:40 })
        .text(name,            PDF_M+76,  ry+4, { width:188 })
        .text(ms,              PDF_M+268, ry+4, { width:80 });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1a1a2e')
        .text(pdfFmt(o.total||0), PDF_M+2, ry+4, { width:PDF_W-4, align:'right' });
      doc.y = ry + 18;
    });
    const sy = doc.y;
    doc.rect(PDF_M, sy, PDF_W, 20).fill(color + '28');
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Summe ${label}:`, PDF_M+8, sy+5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text(pdfFmt(sub), PDF_M+2, sy+5, { width:PDF_W-4, align:'right' });
    doc.y = sy + 24;
  });
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
      const refund = await getStripe().refunds.create({ payment_intent: order.stripePaymentIntentId });
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

// Tagesbericht (22:00)
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
    const total  = orders.reduce((s, o) => s + (o.total || 0), 0);
    const datum  = now.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
    const pdf    = await generatePdf(doc => {
      pdfColorBox(doc, `Tagesbericht – ${datum}`, `Pizzeria Parma · ${orders.length} Bestellungen · ${pdfFmt(total)}`, PRIMARY_COLOR);
      pdfKacheln(doc, [
        ['Bestellungen', `${orders.length}`,                                       '#1a1a2e'],
        ['Barzahlung',   `${orders.filter(o => o.payment === 'bar').length}`,      '#2c5282'],
        ['Stripe',       `${orders.filter(o => o.payment !== 'bar').length}`,      '#276749'],
        ['Tagesumsatz',  pdfFmt(total),                                            '#744210'],
      ]);
      pdfHr(doc);
      orders.forEach((o, i) => {
        if (doc.y > PDF_FT - 40) { doc.addPage(); doc.y = PDF_M; }
        const name = `${o.customer?.first || ''} ${o.customer?.last || ''}`.trim();
        const time = new Date(o.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        pdfTableRow(doc, [
          [`#${o.orderNum}`, PDF_M, 40, 'left'],
          [time, PDF_M + 42, 40, 'left'],
          [name, PDF_M + 84, 160, 'left'],
          [o.mode === 'lieferung' ? 'Lief.' : 'Abh.', PDF_M + 246, 50, 'left'],
          [o.payment === 'stripe' ? 'Stripe' : 'Bar', PDF_M + 298, 50, 'left'],
          [pdfFmt(o.total || 0), PDF_M + 2, PDF_W - 4, 'right'],
        ], i % 2 === 0);
      });
    });
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM,
      to:   process.env.RESTAURANT_EMAIL,
      subject: `📊 Tagesbericht ${datum} · Pizzeria Parma`,
      html: `<p style="font-family:Arial;color:#555">Tagesbericht im Anhang.<br><b>${orders.length} Bestellungen · ${pdfFmt(total)}</b></p>`,
      attachments: [{ filename: `Tagesbericht_${now.toISOString().slice(0, 10)}_PizzeriaParma.pdf`, content: pdf.toString('base64') }],
    });
  } catch(e) { console.error('Tagesbericht:', e); }
});

// Wochenbericht (Sonntag 22:00)
cron.schedule('0 22 * * 0', async () => {
  try {
    const now    = new Date();
    const wStart = new Date(now); wStart.setDate(now.getDate() - 6); wStart.setHours(0, 0, 0, 0);
    const wEnd   = new Date(now); wEnd.setHours(23, 59, 59, 999);
    const kw     = getWeekNum(now);
    const datum  = now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const vonBis = `${wStart.toLocaleDateString('de-DE')} – ${datum}`;
    const orders = await Order.find({
      status: { $in: ['confirmed','preparing','ready','delivered'] },
      createdAt: { $gte: wStart, $lte: wEnd }
    });
    const brutto     = orders.reduce((s, o) => s + (o.total || 0), 0);
    const svcFees    = orders.reduce((s, o) => s + (o.serviceFee || PDF_SV), 0);
    const nettoBase  = brutto - svcFees;
    const provision  = nettoBase * PDF_PR;
    const meinBetrag = svcFees + provision;
    const auszahlung = brutto - meinBetrag;
    const barOrders  = orders.filter(o => o.payment === 'bar');
    const barSvc     = barOrders.reduce((s, o) => s + (o.serviceFee || PDF_SV), 0);
    const barNetto   = barOrders.reduce((s, o) => s + (o.total || 0), 0) - barSvc;
    const barProv    = barNetto * PDF_PR;
    const barBetrag  = barSvc + barProv;
    const rgnr       = await getNextRechnungNum();
    const pdf        = await generatePdf(doc => {
      pdfColorBox(doc, `Wochenbericht KW ${kw} / ${now.getFullYear()}`, `Pizzeria Parma  ·  ${vonBis}`, PRIMARY_COLOR);
      pdfKacheln(doc, [
        ['Bestellungen',  `${orders.length}`,                                       '#1a1a2e'],
        ['Davon Bar',     `${barOrders.length}`,                                    '#2c5282'],
        ['Davon Stripe',  `${orders.filter(o => o.payment !== 'bar').length}`,      '#276749'],
        ['Brutto-Umsatz', pdfFmt(brutto),                                           '#744210'],
      ]);
      doc.moveDown(0.4); pdfHr(doc);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ABRECHNUNG', PDF_M, doc.y);
      doc.y += 14;
      pdfTableRow(doc, [[`Servicegebühren (${pdfFmt(PDF_SV)} × ${orders.length})`, PDF_M+8, PDF_W-80, 'left'], [pdfFmt(svcFees), PDF_M+2, PDF_W-4, 'right']], false);
      pdfTableRow(doc, [[`Systemprovision (5 % auf ${pdfFmt(nettoBase)})`, PDF_M+8, PDF_W-80, 'left'], [pdfFmt(provision), PDF_M+2, PDF_W-4, 'right']], true);
      pdfTableRow(doc, [['Mein Gesamtbetrag', PDF_M+8, PDF_W-80, 'left'], [pdfFmt(meinBetrag), PDF_M+2, PDF_W-4, 'right']], false, true);
      doc.y += 4;
      const ay = doc.y;
      doc.rect(PDF_M, ay, PDF_W, 28).fill('#e8f5e9');
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#2e7d32').text('Auszahlung an Pizzeria Parma', PDF_M+10, ay+8, { width: PDF_W * 0.65 });
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#2e7d32').text(pdfFmt(auszahlung), PDF_M+2, ay+8, { width: PDF_W-4, align: 'right' });
      doc.y = ay + 28 + 12;
      pdfHr(doc, '#bbb');
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('KUNDENLISTE', PDF_M, doc.y);
      doc.y += 12;
      pdfKundenliste(doc, orders);
    });
    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM,
        to:   process.env.RESTAURANT_EMAIL,
        subject: `📊 Wochenbericht KW ${kw} / ${now.getFullYear()} · Pizzeria Parma`,
        html: `<p style="font-family:Arial;color:#555">Wochenbericht KW ${kw} im Anhang.<br><b>${orders.length} Bestellungen · ${pdfFmt(brutto)}</b></p>`,
        attachments: [{ filename: `KW${kw}_${now.getFullYear()}_PizzeriaParma_Wochenbericht.pdf`, content: pdf.toString('base64') }],
      });
    }
    if (process.env.OWNER_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM,
        to:   process.env.OWNER_EMAIL,
        subject: `🧾 ${rgnr} + Wochenbericht KW ${kw} · Pizzeria Parma`,
        html: `<p style="font-family:Arial;color:#555">Wochenbericht KW ${kw} + Rechnung ${rgnr}.<br>Verdienst: ${pdfFmt(meinBetrag)}</p>`,
        attachments: [{ filename: `KW${kw}_${now.getFullYear()}_PizzeriaParma_Wochenbericht.pdf`, content: pdf.toString('base64') }],
      });
    }
    console.log(`📊 Wochenbericht KW ${kw} versendet`);
  } catch(e) { console.error('Wochenbericht:', e); }
});

// Monatsbericht (letzter Tag 22:00)
cron.schedule('0 22 * * *', async () => {
  const now      = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (tomorrow.getDate() !== 1) return;
  try {
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const mEnd   = new Date(now); mEnd.setHours(23, 59, 59, 999);
    const monat  = now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    const orders = await Order.find({ status: { $in: ['confirmed','preparing','ready','delivered'] }, createdAt: { $gte: mStart, $lte: mEnd } });
    const brutto = orders.reduce((s, o) => s + (o.total || 0), 0);
    const rgnr   = await getNextRechnungNum();
    const pdf    = await generatePdf(doc => {
      pdfColorBox(doc, `Monatsbericht ${monat}`, `Pizzeria Parma  ·  ${orders.length} Bestellungen`, PRIMARY_COLOR);
      pdfKacheln(doc, [
        ['Bestellungen',  `${orders.length}`,                                  '#1a1a2e'],
        ['Barzahlung',    `${orders.filter(o => o.payment === 'bar').length}`, '#2c5282'],
        ['Stripe',        `${orders.filter(o => o.payment !== 'bar').length}`, '#276749'],
        ['Brutto-Umsatz', pdfFmt(brutto),                                     '#744210'],
      ]);
      pdfHr(doc);
      pdfKundenliste(doc, orders);
    });
    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM,
        to:   process.env.RESTAURANT_EMAIL,
        subject: `📅 Monatsbericht ${monat} · Pizzeria Parma`,
        html: `<p style="font-family:Arial;color:#555">Monatsbericht ${monat} im Anhang.<br><b>${orders.length} Bestellungen · ${pdfFmt(brutto)}</b></p>`,
        attachments: [{ filename: `${monat.replace(' ','_')}_PizzeriaParma_Monatsbericht.pdf`, content: pdf.toString('base64') }],
      });
    }
    console.log(`📅 Monatsbericht ${monat} versendet`);
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
