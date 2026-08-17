const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const cron       = require('node-cron');
const PDFDocument = require('pdfkit');
const path       = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── LAZY INIT ───────────────────────────────────────────────
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY nicht gesetzt');
  return require('stripe')(key);
}
function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('⚠️  RESEND_API_KEY fehlt'); return null; }
  return new (require('resend').Resend)(key);
}

// ─── CORS ────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://pinocchio-ennigerloh.de',
  'https://www.pinocchio-ennigerloh.de',
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

// Stripe Webhook braucht raw body VOR express.json()
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Statische Dateien
app.use(express.static(path.join(__dirname), {
  etag: false,
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) res.setHeader('Cache-Control','no-store,no-cache,must-revalidate');
  }
}));

// ─── MONGODB ─────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB verbunden'))
  .catch(err => { console.error('❌ MongoDB:', err); process.exit(1); });

// ─── SCHEMAS ─────────────────────────────────────────────────
const orderSchema = new mongoose.Schema({
  orderNum:              { type: Number, unique: true },
  status:                { type: String, enum: ['awaiting_payment','pending','confirmed','preparing','ready','delivered','cancelled'], default: 'pending' },
  mode:                  { type: String, enum: ['lieferung','abholung'], required: true },
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
const Order = mongoose.model('Order', orderSchema);

const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const Counter = mongoose.model('Counter', counterSchema);

const availabilitySchema = new mongoose.Schema({
  itemName:  { type: String, required: true, unique: true },
  available: { type: Boolean, default: true },
}, { timestamps: true });
const Availability = mongoose.model('Availability', availabilitySchema);

const settingsSchema = new mongoose.Schema({
  _id:            String,
  mode:           { type: String, default: 'online', enum: ['online','neutral','geschlossen'] },
  manualOverride: { type: Boolean, default: false },
  isOpen:         { type: Boolean, default: true },
});
const Settings = mongoose.model('Settings', settingsSchema);

// ─── HELPERS ─────────────────────────────────────────────────
async function getNextOrderNum() {
  const c = await Counter.findByIdAndUpdate('orderNum', { $inc: { seq: 1 } }, { new: true, upsert: true });
  return c.seq + 1000;
}
async function getNextRechnungNum() {
  const c = await Counter.findByIdAndUpdate('rechnungNum', { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `RE-${new Date().getFullYear()}-${String(c.seq).padStart(4,'0')}`;
}

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ message: 'Nicht autorisiert' });
  if (h.split(' ')[1] !== process.env.ADMIN_TOKEN_SECRET) return res.status(401).json({ message: 'Token ungültig' });
  next();
}

const cleanName = n => n.replace(/[A-Z0-9](,[A-Z0-9])+$/, '').trimEnd();

function isToday(d) {
  const t = new Date(), dt = new Date(d);
  return dt.getDate()===t.getDate() && dt.getMonth()===t.getMonth() && dt.getFullYear()===t.getFullYear();
}

function calcAutoMode() {
  const now = new Date();
  const str = now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const m = str.match(/(\d+)\.(\d+)\.(\d+),\s*(\d+):(\d+)/);
  if (!m) return 'geschlossen';
  const h = parseInt(m[4]), min = parseInt(m[5]);
  const mins = h * 60 + min;
  // Täglich 11:00 – 22:30
  if (mins >= 11*60 && mins < 22*60+30) return 'online';
  return 'geschlossen';
}

// PDF helper
function generatePdf(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildFn(doc);
    doc.end();
  });
}

function getWeekNum(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay()||7));
  return Math.ceil((((date - new Date(Date.UTC(date.getUTCFullYear(),0,1)))/86400000)+1)/7);
}

// PrintNode (optional)
async function triggerPrint(order) {
  if (!process.env.PRINTNODE_API_KEY || !process.env.PRINTNODE_PRINTER_ID) return;
  try { const p = require('./printnode-helper'); await p.printOrder(order); } catch(e) {}
}

// ─── EMAILS ──────────────────────────────────────────────────
const RESTAURANT_NAME = 'Pizzeria Pinocchio';
const RESTAURANT_ADDR = 'Bahnhofstraße 6, 59320 Ennigerloh';
const RESTAURANT_TEL  = '02524 / 000000';
const PRIMARY_COLOR   = '#c0392b';

async function sendConfirmationEmail(order, mins) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const m = mins || order.prepTime || (order.mode==='lieferung'?45:20);
  const addr = order.mode==='lieferung'
    ? `${order.customer.street} ${order.customer.house}, ${order.customer.city}`
    : RESTAURANT_ADDR;
  const rows = (order.items||[]).map(i =>
    `<tr><td>${i.qty}×</td><td>${cleanName(i.name)}${i.note?' <em>('+i.note+')</em>':''}</td><td style="text-align:right">${((i.price||0)*i.qty).toFixed(2).replace('.',',')} €</td></tr>`
  ).join('');
  await getResend()?.emails.send({
    from: process.env.EMAIL_FROM,
    to:   order.customer.email,
    subject: `✅ Bestellung #${order.orderNum} bestätigt – ${RESTAURANT_NAME}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:${PRIMARY_COLOR};color:#fff;padding:22px;text-align:center">
        <h1 style="margin:0">🍕 ${RESTAURANT_NAME}</h1>
        <p style="margin:4px 0 0;opacity:.8;font-size:13px">${RESTAURANT_ADDR}</p>
      </div>
      <div style="padding:26px 22px">
        <h2 style="color:${PRIMARY_COLOR}">Bestellung #${order.orderNum} bestätigt ✅</h2>
        <p>Hallo <strong>${order.customer.first}</strong>, deine Bestellung ist in der Küche!</p>
        <div style="background:#fff8f0;border-left:4px solid #d4a76a;padding:12px 16px;border-radius:0 8px 8px 0;margin:14px 0">
          <p style="margin:0 0 4px;font-weight:bold">${order.mode==='lieferung'?'🛵 Lieferung':'🏃 Abholung'}</p>
          <p style="margin:0;font-size:13px;color:#666">${addr}</p>
          <p style="margin:4px 0 0;font-size:15px;font-weight:bold;color:${PRIMARY_COLOR}">⏱ Voraussichtlich ~${m} Minuten</p>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin:14px 0">
          <thead><tr style="border-bottom:2px solid #eee"><th align="left">Menge</th><th align="left">Artikel</th><th align="right">Preis</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="border-top:1px solid #eee;padding-top:10px;font-size:13px">
          ${order.deliveryFee>0?`<div style="display:flex;justify-content:space-between;color:#666"><span>Liefergebühr</span><span>${order.deliveryFee.toFixed(2).replace('.',',')} €</span></div>`:''}
          <div style="display:flex;justify-content:space-between;color:#666"><span>Servicegebühr</span><span>${(order.serviceFee||0.99).toFixed(2).replace('.',',')} €</span></div>
          <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:15px;border-top:2px solid ${PRIMARY_COLOR};padding-top:8px;margin-top:6px">
            <span>Gesamt</span><span style="color:${PRIMARY_COLOR}">${(order.total||0).toFixed(2).replace('.',',')} €</span>
          </div>
        </div>
      </div>
      <div style="background:#f7f3ee;padding:14px;text-align:center;font-size:11px;color:#999">
        ${RESTAURANT_NAME} · ${RESTAURANT_ADDR} · Tel: ${RESTAURANT_TEL}
      </div>
    </div>`
  });
}

async function sendRestaurantEmail(order) {
  if (!process.env.RESTAURANT_EMAIL) return;
  const items = (order.items||[]).map(i => {
    let line = `${i.qty}× ${cleanName(i.name)}${i.note?' ('+i.note+')':''}`;
    const extras = (i.extraDetails||[]).filter(e=>e.name);
    if (extras.length) line += '\n' + extras.map(e=>`  ↳ ${e.name}`).join('\n');
    return line;
  }).join('\n');
  await getResend()?.emails.send({
    from: process.env.EMAIL_FROM,
    to:   process.env.RESTAURANT_EMAIL,
    subject: `🔔 Bestellung #${order.orderNum} – ${order.mode==='lieferung'?'Lieferung':'Abholung'}`,
    html: `<pre style="font-family:monospace;font-size:13px">BESTELLUNG #${order.orderNum} · ${order.source==='pos'?'POS':'ONLINE'}
Art:    ${order.mode==='lieferung'?'🛵 LIEFERUNG':'🏃 ABHOLUNG'}
Kunde:  ${order.customer?.first} ${order.customer?.last}
Tel:    ${order.customer?.phone||'–'}
${order.mode==='lieferung'?`Adresse: ${order.customer?.street} ${order.customer?.house}, ${order.customer?.city}`:''}

ARTIKEL:
${items}

Zwischensumme: ${(order.subtotal||0).toFixed(2)} €
${order.deliveryFee>0?`Liefergebühr:  ${order.deliveryFee.toFixed(2)} €`:''}
Servicegebühr: ${(order.serviceFee||0.99).toFixed(2)} €
GESAMT:        ${(order.total||0).toFixed(2)} €

Zahlung: ${order.payment==='stripe'?'KREDITKARTE':order.payment==='karte'?'EC-KARTE':'BAR'} – ${order.paymentStatus==='paid'?'✅ BEZAHLT':'❌ OFFEN'}
${order.note?`Anmerkung: ${order.note}`:''}</pre>`
  });
}

async function sendCancellationEmail(order, reason, refundStatus) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const refundHtml = (order.payment==='stripe' && refundStatus==='succeeded')
    ? `<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px;margin:14px 0">
        <strong style="color:#2e7d32">💸 Rückerstattung eingeleitet</strong><br>
        <span style="font-size:13px;color:#555">Der Betrag von ${(order.total||0).toFixed(2).replace('.',',')} € wird in 5–10 Werktagen zurückgebucht.</span>
       </div>` : '';
  await getResend()?.emails.send({
    from: process.env.EMAIL_FROM,
    to:   order.customer.email,
    subject: `❌ Bestellung #${order.orderNum} storniert – ${RESTAURANT_NAME}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:${PRIMARY_COLOR};color:#fff;padding:22px;text-align:center"><h1 style="margin:0">🍕 ${RESTAURANT_NAME}</h1></div>
      <div style="padding:26px 22px">
        <h2>Bestellung #${order.orderNum} storniert</h2>
        <p>Hallo <strong>${order.customer.first}</strong>, deine Bestellung wurde leider storniert.</p>
        ${reason?`<div style="background:#fff3ea;border-radius:8px;padding:12px;margin:14px 0"><strong>Grund:</strong> ${reason}</div>`:''}
        ${refundHtml}
        <p>Bei Fragen: <strong>${RESTAURANT_TEL}</strong></p>
      </div>
    </div>`
  });
}

// ══════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => res.json({ status: 'ok', restaurant: RESTAURANT_NAME }));

app.get('/api/status', async (req, res) => {
  try {
    const s = await Settings.findById('main');
    const mode = s ? s.mode : 'online';
    res.json({ mode, isOpen: mode==='online', manualOverride: s?.manualOverride||false });
  } catch(e) { res.json({ mode:'online', isOpen:true }); }
});

app.get('/api/availability', async (req, res) => {
  try {
    const d = await Availability.find({ available: false }).select('itemName -_id');
    res.json({ disabled: d.map(x => x.itemName) });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── WEB ORDER ────────────────────────────────────────────────
app.post('/api/orders', async (req, res) => {
  try {
    const orderNum = await getNextOrderNum();
    const isPOS = req.body.source === 'pos';
    const order = new Order({ ...req.body, orderNum, status: isPOS ? 'confirmed' : 'pending' });
    await order.save();
    if (isPOS) {
      await sendConfirmationEmail(order, order.prepTime || 20);
      await sendRestaurantEmail(order);
      await triggerPrint(order);
    }
    res.status(201).json({ orderNum: order.orderNum, order });
  } catch(e) { console.error(e); res.status(500).json({ message: 'Fehler' }); }
});

// ── STRIPE CHECKOUT ──────────────────────────────────────────
app.post('/api/create-stripe-checkout', async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ message: 'Stripe nicht konfiguriert' });
    const { items, subtotal, deliveryFee, serviceFee, total, customer, mode, note } = req.body;
    const orderNum = await getNextOrderNum();

    const lineItems = [
      ...items.filter(i => i.price > 0).map(i => ({
        price_data: { currency:'eur', product_data:{ name:`${i.qty}× ${cleanName(i.name)}${i.note?' ('+i.note+')':''}` }, unit_amount: Math.round(i.price*100) },
        quantity: i.qty,
      })),
      { price_data:{ currency:'eur', product_data:{ name:'Servicegebühr' }, unit_amount:Math.round(serviceFee*100) }, quantity:1 },
      ...(deliveryFee>0 ? [{ price_data:{ currency:'eur', product_data:{ name:'Liefergebühr' }, unit_amount:Math.round(deliveryFee*100) }, quantity:1 }] : []),
    ];

    const stripeFee = Math.round((total * 0.015 + 0.25) * 100);
    const appFee = Math.round((serviceFee + subtotal * 0.05) * 100) + stripeFee;

    const sessionOpts = {
      line_items: lineItems,
      mode: 'payment',
      ...(customer.email ? { customer_email: customer.email } : {}),
      locale: 'de',
      metadata: { orderNum: String(orderNum) },
      success_url: `${process.env.FRONTEND_URL}?order=${orderNum}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}?payment=cancelled`,
    };

    if (process.env.STRIPE_CONNECT_ACCOUNT) {
      sessionOpts.payment_method_types = ['card'];
      sessionOpts.payment_intent_data = {
        application_fee_amount: appFee,
        transfer_data: { destination: process.env.STRIPE_CONNECT_ACCOUNT },
      };
    } else {
      sessionOpts.automatic_payment_methods = { enabled: true };
    }

    const order = new Order({
      orderNum, mode, payment:'stripe', paymentStatus:'unpaid',
      status:'awaiting_payment', customer, items, subtotal, deliveryFee,
      serviceFee, total, note,
    });
    const session = await stripe.checkout.sessions.create(sessionOpts);
    order.stripeSessionId = session.id;
    await order.save();
    res.json({ url: session.url });
  } catch(e) { console.error(e); res.status(500).json({ message: e.message }); }
});

// ── STRIPE WEBHOOK ───────────────────────────────────────────
app.post('/api/stripe-webhook', async (req, res) => {
  let event;
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).send('Stripe nicht konfiguriert');
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) { return res.status(400).send('Webhook Fehler: '+e.message); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const order = await Order.findOne({ stripeSessionId: session.id });
    if (order && order.status === 'awaiting_payment') {
      order.paymentStatus = 'paid';
      order.status = 'pending';
      order.stripePaymentIntentId = session.payment_intent;
      await order.save();
    }
  }
  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    await Order.findOneAndUpdate({ stripeSessionId: session.id }, { status:'cancelled' });
  }
  res.json({ received: true });
});

// ── VERIFY PAYMENT (Fallback) ─────────────────────────────────
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false });
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ ok: false });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') return res.json({ ok: false });
    const order = await Order.findOne({ stripeSessionId: sessionId });
    if (!order) return res.status(404).json({ ok: false });
    if (order.status === 'awaiting_payment') {
      order.paymentStatus = 'paid'; order.status = 'pending';
      order.stripePaymentIntentId = session.payment_intent;
      await order.save();
    }
    res.json({ ok: true, orderNum: order.orderNum });
  } catch(e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// ADMIN API
// ══════════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD)
    return res.json({ token: process.env.ADMIN_TOKEN_SECRET });
  res.status(401).json({ message: 'Falsches Passwort' });
});

app.get('/api/admin/status', auth, async (req, res) => {
  try {
    const s = await Settings.findById('main');
    const mode = s?.mode || 'online';
    res.json({ mode, manualOverride: s?.manualOverride||false, autoMode: calcAutoMode() });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.patch('/api/admin/status', auth, async (req, res) => {
  try {
    const { mode, manualOverride } = req.body;
    const update = {};
    if (mode !== undefined) update.mode = mode;
    if (manualOverride !== undefined) update.manualOverride = manualOverride;
    if (manualOverride === false && mode === undefined) update.mode = calcAutoMode();
    update.isOpen = (update.mode || mode) === 'online';
    const s = await Settings.findByIdAndUpdate('main', update, { upsert: true, new: true });
    res.json({ mode: s.mode, manualOverride: s.manualOverride });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.get('/api/admin/orders', auth, async (req, res) => {
  try {
    const { date } = req.query;
    let from, to;
    if (date) {
      // Timezone-aware: UTC+2 (Europe/Berlin Sommerzeit)
      from = new Date(date + 'T00:00:00+02:00');
      to   = new Date(date + 'T23:59:59+02:00');
    }
    const query = { status: { $nin: ['pending'] } };
    if (from && to) query.createdAt = { $gte: from, $lte: to };
    const orders = await Order.find(query).sort({ createdAt: -1 });
    // Bei Datumsfilter: Stats aus gefilterten Orders; sonst nur heutige
    const statOrders = date ? orders : orders.filter(o => isToday(o.createdAt));
    const stats = {
      active:       orders.filter(o => ['confirmed','preparing'].includes(o.status)).length,
      done:         statOrders.filter(o => ['ready','delivered'].includes(o.status)).length,
      cancelled:    statOrders.filter(o => o.status==='cancelled').length,
      unpaid:       orders.filter(o => o.paymentStatus!=='paid' && o.status!=='cancelled').length,
      todayRevenue: statOrders.filter(o=>o.status!=='cancelled').reduce((s,o)=>s+(o.total||0),0),
      todayCount:   statOrders.filter(o=>o.status!=='cancelled').length,
    };
    res.json({ orders, stats });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// WICHTIG: Vor /:id Route!
app.get('/api/admin/orders/pending', auth, async (req, res) => {
  try { res.json({ pending: await Order.find({ status:'pending' }).sort({ createdAt:1 }) }); }
  catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.get('/api/admin/orders/:id', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    res.json(order);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.patch('/api/admin/orders/:id/confirm', auth, async (req, res) => {
  try {
    const { estimatedMinutes } = req.body;
    const order = await Order.findByIdAndUpdate(req.params.id,
      { status:'confirmed', prepTime: estimatedMinutes }, { new: true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    await sendConfirmationEmail(order, estimatedMinutes);
    await sendRestaurantEmail(order);
    await triggerPrint(order);
    res.json(order);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.patch('/api/admin/orders/:id/status', auth, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    res.json(order);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.patch('/api/admin/orders/:id/payment', auth, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, { paymentStatus: req.body.paymentStatus }, { new: true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    res.json(order);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.post('/api/admin/orders/:id/print', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    await triggerPrint(order);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ message:'Druckfehler' }); }
});

app.delete('/api/admin/orders/:id', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    let refundStatus = null;
    if (order.payment==='stripe' && order.paymentStatus==='paid' && order.stripePaymentIntentId) {
      try {
        const stripe = getStripe();
        const refund = await stripe?.refunds.create({ payment_intent: order.stripePaymentIntentId });
        refundStatus = refund?.status;
        order.paymentStatus = 'refunded';
      } catch(e) { console.error('Stripe Refund Fehler:', e); }
    }
    order.status = 'cancelled';
    order.cancelReason = req.body.cancelReason || '';
    await order.save();
    await sendCancellationEmail(order, req.body.cancelReason, refundStatus);
    res.json({ success: true, refundStatus });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.get('/api/admin/finance', auth, async (req, res) => {
  try {
    const active = ['confirmed','preparing','ready','delivered'];
    const all = await Order.find({ status: { $in: active } });
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); weekStart.setHours(0,0,0,0);
    const calc = list => {
      const brutto = list.reduce((s,o)=>s+(o.total||0),0);
      const svcFees = list.reduce((s,o)=>s+(o.serviceFee||0.99),0);
      const provision = (brutto-svcFees)*0.05;
      return { count:list.length, brutto, svcFees, provision, auszahlung:brutto-svcFees-provision };
    };
    res.json({
      today: calc(all.filter(o=>o.createdAt>=todayStart)),
      week:  calc(all.filter(o=>o.createdAt>=weekStart)),
    });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// AVAILABILITY
app.get('/api/admin/availability', auth, async (req, res) => {
  try { res.json({ items: await Availability.find() }); }
  catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.patch('/api/admin/availability', auth, async (req, res) => {
  try {
    const { itemName, available } = req.body;
    const a = await Availability.findOneAndUpdate(
      { itemName }, { available }, { upsert: true, new: true }
    );
    res.json(a);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// RECOVER STRIPE ORDERS
app.post('/api/admin/recover-stripe-orders', auth, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ message:'Stripe nicht konfiguriert' });
    const stuck = await Order.find({ status:'awaiting_payment', payment:'stripe' });
    const recovered = [];
    for (const order of stuck) {
      const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
      if (session.payment_status === 'paid') {
        order.paymentStatus='paid'; order.status='pending';
        order.stripePaymentIntentId=session.payment_intent;
        await order.save(); recovered.push(order.orderNum);
      }
    }
    res.json({ recovered, total: stuck.length });
  } catch(e) { res.status(500).json({ message: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// CRON JOBS
// ══════════════════════════════════════════════════════════════

// Auto-Modus – jede Minute
cron.schedule('* * * * *', async () => {
  try {
    const s = await Settings.findById('main');
    if (s?.manualOverride) return;
    await Settings.findByIdAndUpdate('main', { mode: calcAutoMode() }, { upsert: true });
  } catch(e) {}
});

// Tagesbericht – täglich 22:00
cron.schedule('0 22 * * *', async () => {
  if (!process.env.RESTAURANT_EMAIL) return;
  try {
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayEnd   = new Date(); todayEnd.setHours(23,59,59,999);
    const orders = await Order.find({
      createdAt: { $gte: todayStart, $lte: todayEnd },
      status: { $nin: ['cancelled','awaiting_payment'] }
    });
    const total = orders.reduce((s,o)=>s+(o.total||0),0);
    const pdf = await generatePdf(doc => {
      doc.fontSize(18).font('Helvetica-Bold').text(`${RESTAURANT_NAME}`, { align:'center' });
      doc.fontSize(12).font('Helvetica').text('Tagesbericht', { align:'center' });
      doc.text(new Date().toLocaleDateString('de-DE',{weekday:'long',day:'2-digit',month:'2-digit',year:'numeric'}), { align:'center' });
      doc.moveDown().moveTo(50,doc.y).lineTo(545,doc.y).stroke();
      doc.moveDown();
      doc.fontSize(11).text(`Bestellungen gesamt: ${orders.length}`);
      doc.text(`Lieferung: ${orders.filter(o=>o.mode==='lieferung').length}`);
      doc.text(`Abholung: ${orders.filter(o=>o.mode==='abholung').length}`);
      doc.text(`Gesamtumsatz: ${total.toFixed(2)} €`);
      doc.moveDown();
      orders.forEach(o => {
        doc.text(`#${o.orderNum} | ${new Date(o.createdAt).toLocaleTimeString('de-DE')} | ${o.customer?.first} ${o.customer?.last} | ${(o.total||0).toFixed(2)} €`);
      });
    });
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM,
      to:   process.env.RESTAURANT_EMAIL,
      subject: `📊 Tagesbericht ${new Date().toLocaleDateString('de-DE')} – ${RESTAURANT_NAME}`,
      html: `<p>Tagesbericht anbei als PDF.</p><p>Umsatz heute: <strong>${total.toFixed(2)} €</strong> (${orders.length} Bestellungen)</p>`,
      attachments: [{ filename: 'tagesbericht.pdf', content: pdf.toString('base64'), type:'application/pdf', disposition:'attachment' }],
    });
  } catch(e) { console.error('Tagesbericht Fehler:', e); }
});


// Wochenbericht – Sonntag 23:59
cron.schedule('59 23 * * 0', async () => {
  if (!process.env.RESTAURANT_EMAIL && !process.env.OWNER_EMAIL) return;
  try {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 6);
    weekStart.setHours(0,0,0,0);
    const weekEnd = new Date(now); weekEnd.setHours(23,59,59,999);
    const orders = await Order.find({
      createdAt: { $gte: weekStart, $lte: weekEnd },
      status: { $nin: ['cancelled','awaiting_payment'] }
    });
    const brutto    = orders.reduce((s,o)=>s+(o.total||0),0);
    const svcFees   = orders.reduce((s,o)=>s+(o.serviceFee||0.99),0);
    const provision = (brutto-svcFees)*0.05;
    const auszahlung = brutto-svcFees-provision;
    const kw = getWeekNum(now);
    const pdf = await generatePdf(doc => {
      doc.fontSize(18).font('Helvetica-Bold').text(RESTAURANT_NAME, { align:'center' });
      doc.fontSize(12).font('Helvetica').text(`Wochenbericht KW ${kw}`, { align:'center' });
      doc.text(`${weekStart.toLocaleDateString('de-DE')} – ${now.toLocaleDateString('de-DE')}`, { align:'center' });
      doc.moveDown().moveTo(50,doc.y).lineTo(545,doc.y).stroke().moveDown();
      doc.text(`Bestellungen: ${orders.length}`);
      doc.text(`Lieferung: ${orders.filter(o=>o.mode==='lieferung').length}`);
      doc.text(`Abholung: ${orders.filter(o=>o.mode==='abholung').length}`);
      doc.moveDown();
      doc.fontSize(11).text(`Bruttoumsatz:    ${brutto.toFixed(2)} €`);
      doc.text(`Servicegebühren: ${svcFees.toFixed(2)} €`);
      doc.text(`Provision (5%):  ${provision.toFixed(2)} €`);
      doc.fontSize(13).font('Helvetica-Bold').text(`Auszahlung:      ${auszahlung.toFixed(2)} €`);
    });
    if (process.env.OWNER_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM,
        to:   process.env.OWNER_EMAIL,
        subject: `📊 Wochenbericht KW ${kw} – ${RESTAURANT_NAME}`,
        html: `<p>Wochenbericht KW ${kw} anbei.</p><p>Umsatz: <strong>${brutto.toFixed(2)} €</strong> | Auszahlung: <strong>${auszahlung.toFixed(2)} €</strong></p>`,
        attachments: [{ filename: `wochenbericht-kw${kw}.pdf`, content: pdf.toString('base64'), type:'application/pdf', disposition:'attachment' }],
      });
    }
    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM,
        to:   process.env.RESTAURANT_EMAIL,
        subject: `📊 Wochenbericht KW ${kw} – ${RESTAURANT_NAME}`,
        html: `<p>Wochenbericht KW ${kw}.</p><p>Bestellungen: <strong>${orders.length}</strong> | Umsatz: <strong>${brutto.toFixed(2)} €</strong></p>`,
      });
    }
  } catch(e) { console.error('Wochenbericht Fehler:', e); }
});

// Monatsbericht – letzter Tag des Monats 23:58
cron.schedule('58 23 * * *', async () => {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  if (tomorrow.getDate() !== 1) return; // Nur am letzten Tag
  if (!process.env.OWNER_EMAIL) return;
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    const monthEnd   = new Date(now); monthEnd.setHours(23,59,59,999);
    const orders = await Order.find({
      createdAt: { $gte: monthStart, $lte: monthEnd },
      status: { $nin: ['cancelled','awaiting_payment'] }
    });
    const brutto    = orders.reduce((s,o)=>s+(o.total||0),0);
    const svcFees   = orders.reduce((s,o)=>s+(o.serviceFee||0.99),0);
    const provision = (brutto-svcFees)*0.05;
    const auszahlung = brutto-svcFees-provision;
    const monName = now.toLocaleDateString('de-DE',{month:'long',year:'numeric'});
    const rechnungNr = await getNextRechnungNum();
    const pdf = await generatePdf(doc => {
      doc.fontSize(18).font('Helvetica-Bold').text(RESTAURANT_NAME, { align:'center' });
      doc.fontSize(12).font('Helvetica').text(`Monatsbericht ${monName}`, { align:'center' });
      doc.text(`Rechnungsnr.: ${rechnungNr}`, { align:'center' });
      if (process.env.STEUERNUMMER) doc.text(`Steuernummer: ${process.env.STEUERNUMMER}`, { align:'center' });
      doc.moveDown().moveTo(50,doc.y).lineTo(545,doc.y).stroke().moveDown();
      doc.text(`Bestellungen gesamt: ${orders.length}`);
      doc.text(`Lieferung: ${orders.filter(o=>o.mode==='lieferung').length}`);
      doc.text(`Abholung: ${orders.filter(o=>o.mode==='abholung').length}`);
      doc.text(`Bar:    ${orders.filter(o=>o.payment==='bar').length}`);
      doc.text(`Karte/Online: ${orders.filter(o=>o.payment!=='bar').length}`);
      doc.moveDown();
      doc.fontSize(11).text(`Bruttoumsatz:    ${brutto.toFixed(2)} €`);
      doc.text(`Servicegebühren: ${svcFees.toFixed(2)} €`);
      doc.text(`Provision (5%):  ${provision.toFixed(2)} €`);
      doc.fontSize(13).font('Helvetica-Bold').text(`Auszahlung:      ${auszahlung.toFixed(2)} €`);
    });
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM,
      to:   process.env.OWNER_EMAIL,
      subject: `📄 Monatsabrechnung ${monName} – ${RESTAURANT_NAME}`,
      html: `<p>Monatsabrechnung ${monName} anbei (${rechnungNr}).</p><p>Umsatz: <strong>${brutto.toFixed(2)} €</strong> | Auszahlung: <strong>${auszahlung.toFixed(2)} €</strong></p>`,
      attachments: [{ filename: `monatsbericht-${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}.pdf`, content: pdf.toString('base64'), type:'application/pdf', disposition:'attachment' }],
    });
  } catch(e) { console.error('Monatsbericht Fehler:', e); }
});

// ══════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════
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
app.get('/api/admin/history', auth, async (req, res) => {
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


app.listen(PORT, () => console.log(`🍕 ${RESTAURANT_NAME} Server läuft auf Port ${PORT}`));
