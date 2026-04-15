const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const Stripe     = require('stripe');
const { Resend } = require('resend');
const cron       = require('node-cron');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const app    = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const PORT   = process.env.PORT || 3001;

// Stripe lazy – liest Key bei jedem Aufruf (Test & Live kompatibel)
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY nicht gesetzt in Render Environment');
  return Stripe(key);
}

// ─── CORS ────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://pizzeria-amoura.de',
  'https://www.pizzeria-amoura.de',
];
app.use(cors({
  origin: function(origin, callback) {
    // Kein Origin = Postman / server-to-server / lokale Datei → erlauben
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, origin);
    console.warn('CORS blockiert:', origin);
    return callback(new Error('CORS nicht erlaubt für: ' + origin));
  },
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));
// Preflight für alle Routen
app.options('*', cors());

// ─── Stripe Webhook braucht raw body ─────────────────────────────
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── MongoDB ─────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB verbunden'))
  .catch(err => console.error('❌ MongoDB:', err));

// ═══════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════

const orderSchema = new mongoose.Schema({
  orderNum:             { type: Number, unique: true },
  mode:                 { type: String, enum: ['lieferung','abholung'], required: true },
  status:               { type: String, default: 'pending',
                          enum: ['awaiting_payment','pending','confirmed','preparing','ready','delivered','cancelled'] },
  payment:              { type: String, enum: ['bar','stripe','karte'], required: true },
  paymentStatus:        { type: String, default: 'unpaid', enum: ['unpaid','paid','pending','refunded'] },
  source:               { type: String, default: 'web', enum: ['web','pos'] },
  stripeSessionId:      String,
  stripePaymentIntentId:String,
  prepTime:             Number,
  cancelReason:         { type: String, default: '' },
  customer: {
    first: String, last: String, email: String,
    phone: String, city: String, street: String, house: String
  },
  items:       [{ name: String, price: Number, qty: Number, note: String }],
  subtotal:    Number,
  deliveryFee: { type: Number, default: 0 },
  serviceFee:  { type: Number, default: 0.99 },
  total:       Number,
  note:        String,
}, { timestamps: true });

const Order = mongoose.model('Order', orderSchema);

const counterSchema = new mongoose.Schema({ _id: String, seq: Number });
const Counter = mongoose.model('Counter', counterSchema);

const availabilitySchema = new mongoose.Schema({
  itemName:  { type: String, required: true, unique: true },
  available: { type: Boolean, default: false }
}, { timestamps: true });
const Availability = mongoose.model('Availability', availabilitySchema);

const settingsSchema = new mongoose.Schema({
  _id:            String,
  mode:           { type: String, default: 'online', enum: ['online','geschlossen','neutral'] },
  manualOverride: { type: Boolean, default: false },
  // Rückwärtskompatibilität
  isOpen:         { type: Boolean, default: true }
});
const Settings = mongoose.model('Settings', settingsSchema);

// ─── Counter ─────────────────────────────────────────────────────
async function getNextOrderNum() {
  const r = await Counter.findByIdAndUpdate('orderNum',
    { $inc: { seq: 1 } }, { new: true, upsert: true });
  return r.seq + 1000;
}

// ─── Auth ─────────────────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ message: 'Nicht autorisiert' });
  if (h.split(' ')[1] !== process.env.ADMIN_TOKEN_SECRET) return res.status(401).json({ message: 'Token ungültig' });
  next();
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => res.json({
  status: 'ok', restaurant: 'Pizzeria Amoura', time: new Date()
}));

app.get('/api/config', (req, res) => res.json({
  whatsapp: process.env.WHATSAPP_NUMBER || '',
  serviceFee: 0.99,
  deliveryCities: {
    'Beckum':  { min: 15.00, fee: 1.50 },
    'Roland':  { min: 20.00, fee: 2.00 },
    'Vellern': { min: 20.00, fee: 2.00 },
  }
}));

// ── Restaurant Status (öffentlich) ───────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const s = await Settings.findById('restaurant');
    const mode = s ? (s.mode || (s.isOpen ? 'online' : 'geschlossen')) : 'online';
    res.json({ mode, isOpen: mode === 'online' });
  } catch(e) { res.json({ mode: 'online', isOpen: true }); }
});

// ── Restaurant Status (Admin) ─────────────────────────────────────
app.patch('/api/admin/status', auth, async (req, res) => {
  try {
    const { mode, manualOverride } = req.body;
    const update = {};
    if (mode !== undefined)           update.mode           = mode;
    if (manualOverride !== undefined) update.manualOverride = manualOverride;
    update.isOpen = (update.mode || mode) === 'online';
    const s = await Settings.findByIdAndUpdate('restaurant', update, { upsert: true, new: true });
    const icons = { online:'✅ ONLINE', geschlossen:'❌ GESCHLOSSEN', neutral:'⚪ NEUTRAL' };
    console.log(`🏪 Restaurant: ${icons[s.mode]} | Manuell: ${s.manualOverride}`);
    res.json({ mode: s.mode, manualOverride: s.manualOverride, isOpen: s.isOpen });
  } catch(e) { res.status(500).json({ message: 'Fehler' }); }
});

// ── Admin: aktuellen Status lesen ────────────────────────────────
app.get('/api/admin/status', auth, async (req, res) => {
  try {
    const s = await Settings.findById('restaurant');
    const mode = s ? (s.mode || (s.isOpen ? 'online' : 'geschlossen')) : 'online';
    res.json({ mode, manualOverride: s ? s.manualOverride : false, isOpen: mode === 'online' });
  } catch(e) { res.status(500).json({ mode: 'online', manualOverride: false }); }
});

app.get('/api/availability', async (req, res) => {
  try {
    const d = await Availability.find({ available: false }).select('itemName -_id');
    res.json({ disabled: d.map(x => x.itemName) });
  } catch(e) { res.status(500).json({ message: 'Fehler' }); }
});

// ── Neue Web-Bestellung (pending) ────────────────────────────────
app.post('/api/orders', async (req, res) => {
  try {
    const orderNum = await getNextOrderNum();
    const isPOS    = req.body.source === 'pos';
    const order    = new Order({
      ...req.body, orderNum,
      status: isPOS ? 'confirmed' : 'pending'
    });
    await order.save();
    if (isPOS) {
      await sendConfirmationEmail(order, order.prepTime || 20);
      await sendRestaurantEmail(order);
      await triggerPrint(order);
    }
    res.status(201).json({ orderNum: order.orderNum, order });
  } catch(e) { console.error(e); res.status(500).json({ message: 'Fehler beim Speichern' }); }
});

// ── Stripe Checkout ───────────────────────────────────────────────
app.post('/api/create-stripe-checkout', async (req, res) => {
  try {
    const { items, subtotal, deliveryFee, serviceFee, total, customer, mode, note } = req.body;
    const orderNum = await getNextOrderNum();

    const lineItems = items.filter(i => i.price > 0).map(i => ({
      price_data: { currency:'eur',
        product_data: { name: `${i.qty}× ${i.name}${i.note?' ('+i.note+')':''}` },
        unit_amount: Math.round(i.price * 100) },
      quantity: i.qty,
    }));
    if (deliveryFee > 0) lineItems.push({
      price_data: { currency:'eur', product_data:{ name:'Liefergebühr' }, unit_amount: Math.round(deliveryFee*100) }, quantity:1
    });
    if (serviceFee > 0) lineItems.push({
      price_data: { currency:'eur', product_data:{ name:'Servicegebühr' }, unit_amount: Math.round(serviceFee*100) }, quantity:1
    });

    // Stripe Connect: Provision berechnen
    // serviceFee(0,99€) + 5% vom subtotal → application_fee_amount
    const appFee = Math.round((serviceFee + (subtotal * 0.05)) * 100);

    const sessionOpts = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      ...(customer.email ? { customer_email: customer.email } : {}),
      locale: 'de',
      metadata: { orderNum: String(orderNum) },
      success_url: `https://pizzeria-amoura.de?order=${orderNum}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `https://pizzeria-amoura.de?payment=cancelled`,
    };

    // Stripe Connect wenn konfiguriert
    if (process.env.STRIPE_CONNECT_ACCOUNT) {
      sessionOpts.payment_intent_data = {
        application_fee_amount: appFee,
        transfer_data: { destination: process.env.STRIPE_CONNECT_ACCOUNT }
      };
    }

    const session = await getStripe().checkout.sessions.create(sessionOpts);

    const order = new Order({
      items, subtotal, deliveryFee, serviceFee, total,
      customer, mode, note, orderNum,
      payment: 'stripe', paymentStatus: 'pending',
      stripeSessionId: session.id, status: 'awaiting_payment'
    });
    await order.save();
    res.json({ url: session.url, orderNum });
  } catch(e) { console.error(e); res.status(500).json({ message: 'Stripe Fehler: '+e.message }); }
});

// ── Stripe Webhook ────────────────────────────────────────────────
app.post('/api/stripe-webhook', async (req, res) => {
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) { return res.status(400).send('Webhook Error: '+e.message); }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const order = await Order.findOne({ stripeSessionId: s.id });
    if (order) {
      order.paymentStatus = 'paid';
      order.status = 'pending'; // wartet auf Admin-Bestätigung
      order.stripePaymentIntentId = s.payment_intent;
      await order.save();
      console.log(`💳 Bezahlt: #${order.orderNum} → wartet auf Bestätigung`);
    }
  }
  if (event.type === 'checkout.session.expired') {
    await Order.findOneAndUpdate({ stripeSessionId: event.data.object.id }, { status:'cancelled' });
  }
  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  req.body.password === process.env.ADMIN_PASSWORD
    ? res.json({ token: process.env.ADMIN_TOKEN_SECRET })
    : res.status(401).json({ message: 'Falsches Passwort' });
});

// ── Pending Bestellungen (für 5s Polling) ───────────────────────
app.get('/api/admin/orders/pending', auth, async (req, res) => {
  try { res.json({ pending: await Order.find({ status:'pending' }).sort({ createdAt:1 }) }); }
  catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Alle Bestellungen ────────────────────────────────────────────
app.get('/api/admin/orders', auth, async (req, res) => {
  try {
    const orders  = await Order.find({ status:{ $nin:['pending','awaiting_payment'] } }).sort({ createdAt:-1 }).limit(300);
    const pending = await Order.find({ status:'pending' }).sort({ createdAt:1 });
    const today   = new Date(); today.setHours(0,0,0,0);
    const tod     = orders.filter(o => new Date(o.createdAt) >= today);
    res.json({
      orders, pending,
      stats: {
        todayCount:   tod.length,
        todayRevenue: tod.filter(o=>o.status!=='cancelled').reduce((s,o)=>s+(o.total||0),0),
        totalRevenue: orders.reduce((s,o)=>s+(o.total||0),0),
        active:       orders.filter(o=>['confirmed','preparing'].includes(o.status)).length,
        done:         tod.filter(o=>['ready','delivered'].includes(o.status)).length,
        cancelled:    tod.filter(o=>o.status==='cancelled').length,
        unpaid:       orders.filter(o=>o.paymentStatus!=='paid'&&o.status!=='cancelled').length,
      }
    });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Bestellung BESTÄTIGEN (Annehmen + Zeit) ──────────────────────
app.patch('/api/admin/orders/:id/confirm', auth, async (req, res) => {
  try {
    const { estimatedMinutes } = req.body;
    const order = await Order.findByIdAndUpdate(req.params.id,
      { status:'confirmed', prepTime: estimatedMinutes||45 }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    // E-Mail + Druck auslösen
    await sendConfirmationEmail(order, estimatedMinutes);
    await sendRestaurantEmail(order);
    await triggerPrint(order);
    console.log(`✅ #${order.orderNum} bestätigt – ${estimatedMinutes} Min.`);
    res.json(order);
  } catch(e) { console.error(e); res.status(500).json({ message:'Fehler' }); }
});

// ── Status ändern ────────────────────────────────────────────────
app.patch('/api/admin/orders/:id/status', auth, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, { status:req.body.status }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    res.json(order);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Bezahlstatus togglen ─────────────────────────────────────────
app.patch('/api/admin/orders/:id/payment', auth, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id,
      { paymentStatus:req.body.paymentStatus }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    res.json(order);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── STORNIEREN (mit Auto-Refund bei Stripe) ──────────────────────
app.delete('/api/admin/orders/:id', auth, async (req, res) => {
  try {
    const reason = req.body?.cancelReason || '';
    const order  = await Order.findByIdAndUpdate(req.params.id,
      { status:'cancelled', cancelReason:reason }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });

    let refundStatus = null;
    if (order.payment === 'stripe' && order.paymentStatus === 'paid' && order.stripePaymentIntentId) {
      try {
        const refund = await getStripe().refunds.create({ payment_intent: order.stripePaymentIntentId });
        refundStatus = refund.status;
        await Order.findByIdAndUpdate(order._id, { paymentStatus:'refunded' });
        console.log(`💸 Refund #${order.orderNum}: ${refund.status}`);
      } catch(e) { console.error('Refund Fehler:', e.message); refundStatus='failed'; }
    }

    await sendCancellationEmail(order, reason, refundStatus);
    res.json({ success:true, order, refundStatus });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Bon nachdrucken ──────────────────────────────────────────────
app.post('/api/admin/orders/:id/print', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    await triggerPrint(order);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ message:'Druckfehler' }); }
});

// ── Verfügbarkeit (Sold-Out Toggle) ─────────────────────────────
app.get('/api/admin/availability', auth, async (req, res) => {
  try { res.json({ items: await Availability.find() }); }
  catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.patch('/api/admin/availability', auth, async (req, res) => {
  try {
    const { itemName, available } = req.body;
    if (!itemName) return res.status(400).json({ message:'itemName fehlt' });
    const doc = await Availability.findOneAndUpdate(
      { itemName }, { available }, { upsert:true, new:true });
    console.log(`${available?'✅':'❌'} "${itemName}" → ${available?'verfügbar':'ausverkauft'}`);
    res.json(doc);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Finanzübersicht ──────────────────────────────────────────────
app.get('/api/admin/finance', auth, async (req, res) => {
  try {
    const orders = await Order.find({ status:{ $in:['confirmed','preparing','ready','delivered'] } });
    const today  = new Date(); today.setHours(0,0,0,0);
    const wStart = new Date(); wStart.setDate(wStart.getDate() - wStart.getDay() + 1); wStart.setHours(0,0,0,0);
    const calc = list => {
      const brutto    = list.reduce((s,o)=>s+(o.total||0),0);
      const svcFees   = list.reduce((s,o)=>s+(o.serviceFee||0.99),0);
      const provision = (brutto - svcFees) * 0.05;
      return { count:list.length, brutto, svcFees, provision, auszahlung: brutto-svcFees-provision };
    };
    res.json({
      today: calc(orders.filter(o=>new Date(o.createdAt)>=today)),
      week:  calc(orders.filter(o=>new Date(o.createdAt)>=wStart)),
    });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ═══════════════════════════════════════════════════════════════
// E-MAIL FUNKTIONEN
// ═══════════════════════════════════════════════════════════════

async function sendConfirmationEmail(order, mins) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const m    = mins || order.prepTime || (order.mode==='lieferung'?45:20);
  const addr = order.mode==='lieferung'
    ? `${order.customer.street} ${order.customer.house}, ${order.customer.city}`
    : 'Oststraße 48, 59269 Beckum';
  const rows = (order.items||[]).map(i =>
    `<tr><td style="padding:4px 8px">${i.qty}×</td><td style="padding:4px 8px">${i.name}${i.note?' <em>('+i.note+')</em>':''}</td><td style="padding:4px 8px;text-align:right">${(i.price*i.qty).toFixed(2).replace('.',',')} €</td></tr>`
  ).join('');
  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'bestellungen@pizzeria-amoura.de',
      to:   order.customer.email,
      subject: `✅ Bestellung #${order.orderNum} bestätigt – Pizzeria Amoura`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#8b1d1d;color:#fff;padding:22px;text-align:center">
          <h1 style="margin:0;font-size:22px">🍕 Pizzeria Amoura</h1>
          <p style="margin:4px 0 0;opacity:.8;font-size:13px">Oststraße 48 · 59269 Beckum</p>
        </div>
        <div style="padding:26px 22px">
          <h2 style="color:#8b1d1d;margin:0 0 14px">Bestellung #${order.orderNum} bestätigt ✅</h2>
          <p>Hallo <strong>${order.customer.first}</strong>, deine Bestellung ist in der Küche!</p>
          <div style="background:#fff8f0;border-left:4px solid #d4a76a;padding:12px 16px;border-radius:0 8px 8px 0;margin:14px 0">
            <p style="margin:0 0 4px;font-weight:bold">${order.mode==='lieferung'?'🛵 Lieferung':'🏃 Abholung'}</p>
            <p style="margin:0;font-size:13px;color:#666">${addr}</p>
            <p style="margin:4px 0 0;font-size:15px;font-weight:bold;color:#8b1d1d">⏱ Voraussichtlich ~${m} Minuten</p>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:14px 0">
            <thead><tr style="border-bottom:2px solid #eee"><th align="left" style="padding:4px 8px">Menge</th><th align="left" style="padding:4px 8px">Artikel</th><th align="right" style="padding:4px 8px">Preis</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="border-top:1px solid #eee;padding-top:10px;font-size:13px">
            <div style="display:flex;justify-content:space-between;color:#666;margin:3px 0"><span>Zwischensumme</span><span>${(order.subtotal||0).toFixed(2).replace('.',',')} €</span></div>
            ${order.deliveryFee>0?`<div style="display:flex;justify-content:space-between;color:#666;margin:3px 0"><span>Liefergebühr</span><span>${order.deliveryFee.toFixed(2).replace('.',',')} €</span></div>`:''}
            <div style="display:flex;justify-content:space-between;color:#666;margin:3px 0"><span>Servicegebühr</span><span>${(order.serviceFee||0.99).toFixed(2).replace('.',',')} €</span></div>
            <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:15px;border-top:2px solid #8b1d1d;padding-top:8px;margin-top:6px"><span>Gesamt</span><span style="color:#8b1d1d">${(order.total||0).toFixed(2).replace('.',',')} €</span></div>
          </div>
          <p style="font-size:13px;color:#666;margin-top:14px">
            Zahlung: ${order.payment==='stripe'?'💳 Online (Stripe)':order.payment==='karte'?'💳 EC-Karte':'💵 Barzahlung'} ·
            ${order.paymentStatus==='paid'?'✅ Bereits bezahlt':'💵 Bitte bereithalten'}
          </p>
          ${order.note?`<p style="background:#fff3ea;padding:10px;border-radius:6px;font-size:13px">📝 Anmerkung: ${order.note}</p>`:''}
        </div>
        <div style="background:#f7f3ee;padding:14px;text-align:center;font-size:11px;color:#999">Pizzeria Amoura · Oststraße 48 · 59269 Beckum · Tel: 02521 / 829 06 00</div>
      </div>`
    });
    console.log(`📧 Bestätigung → ${order.customer.email}`);
  } catch(e) { console.error('Mail Fehler:', e); }
}

async function sendRestaurantEmail(order) {
  if (!process.env.RESTAURANT_EMAIL) return;
  const items = (order.items||[]).map(i=>`${i.qty}× ${i.name}${i.note?' ('+i.note+')':''}`).join('\n');
  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM||'bestellungen@pizzeria-amoura.de',
      to:   process.env.RESTAURANT_EMAIL,
      subject: `🔔 Bestellung #${order.orderNum} – ${order.mode==='lieferung'?'Lieferung':'Abholung'}`,
      html: `<pre style="font-family:monospace;font-size:13px">BESTELLUNG #${order.orderNum} · ${order.source==='pos'?'POS':'ONLINE'}
═══════════════════════════════
Art:    ${order.mode==='lieferung'?'🛵 LIEFERUNG':'🏃 ABHOLUNG'}
Kunde:  ${order.customer?.first} ${order.customer?.last}
Tel:    ${order.customer?.phone||'–'}
${order.mode==='lieferung'?`Adresse: ${order.customer?.street} ${order.customer?.house}, ${order.customer?.city}`:''}

ARTIKEL:
${items}

Zwischensumme: ${(order.subtotal||0).toFixed(2)} €
${order.deliveryFee?`Liefergebühr:  ${order.deliveryFee.toFixed(2)} €`:''}
Servicegebühr: ${(order.serviceFee||0.99).toFixed(2)} €
GESAMT:        ${(order.total||0).toFixed(2)} €

Zahlung: ${order.payment==='stripe'?'KREDITKARTE':order.payment==='karte'?'EC-KARTE':'BAR'} – ${order.paymentStatus==='paid'?'✅ BEZAHLT':'❌ NOCH OFFEN'}
${order.note?`Anmerkung: ${order.note}`:''}</pre>`
    });
  } catch(e) { console.error('Restaurant Mail:', e); }
}

async function sendCancellationEmail(order, reason, refundStatus) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const refundHtml = (order.payment==='stripe' && order.paymentStatus==='refunded')
    ? `<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px;margin:14px 0">
        <strong style="color:#2e7d32">💸 Rückerstattung eingeleitet</strong><br>
        <span style="font-size:13px;color:#555">Der Betrag von ${(order.total||0).toFixed(2).replace('.',',')} € wird in 5–10 Werktagen zurückgebucht.</span>
       </div>` : '';
  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM||'bestellungen@pizzeria-amoura.de',
      to:   order.customer.email,
      subject: `❌ Bestellung #${order.orderNum} storniert – Pizzeria Amoura`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#8b1d1d;color:#fff;padding:22px;text-align:center"><h1 style="margin:0">🍕 Pizzeria Amoura</h1></div>
        <div style="padding:26px 22px">
          <h2>Bestellung #${order.orderNum} storniert</h2>
          <p>Hallo <strong>${order.customer.first}</strong>, deine Bestellung wurde leider storniert.</p>
          ${reason?`<div style="background:#fff3ea;border-radius:8px;padding:12px;margin:14px 0"><strong>Grund:</strong> ${reason}</div>`:''}
          ${refundHtml}
          <p>Bei Fragen: <strong>02521 / 829 06 00</strong></p>
        </div>
      </div>`
    });
  } catch(e) { console.error('Storno Mail:', e); }
}

// ═══════════════════════════════════════════════════════════════
// PRINTNODE
// ═══════════════════════════════════════════════════════════════

async function triggerPrint(order) {
  if (!process.env.PRINTNODE_API_KEY || !process.env.PRINTNODE_PRINTER_ID) return;
  try { const p = require('./printnode-helper'); await p.printOrder(order); }
  catch(e) { console.error('PrintNode:', e); }
}

// ═══════════════════════════════════════════════════════════════
// AUTO-STATUS (Cron – jede Minute, Öffnungszeiten Deutschland)
// ═══════════════════════════════════════════════════════════════

function calcAutoMode() {
  // Deutsche Zeit berechnen
  const deTime = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const parts  = deTime.match(/(\d+)\.(\d+)\.(\d+),\s*(\d+):(\d+)/);
  if (!parts) return 'geschlossen';
  const day  = parseInt(parts[1]);
  const mon  = parseInt(parts[2]);
  const year = parseInt(parts[3]);
  const h    = parseInt(parts[4]);
  const m    = parseInt(parts[5]);
  const mins = h * 60 + m;

  // Wochentag berechnen (0=So, 1=Mo, ..., 6=Sa)
  const wd = new Date(year, mon - 1, day).getDay();

  // Dienstag = Ruhetag
  if (wd === 2) return 'geschlossen';

  // Samstag: 17:00–22:00
  if (wd === 6) {
    return (mins >= 17*60 && mins < 22*60) ? 'online' : 'geschlossen';
  }

  // Sonntag: 12:00–14:00 & 16:00–22:00
  if (wd === 0) {
    const session1 = mins >= 12*60 && mins < 14*60;
    const session2 = mins >= 16*60 && mins < 22*60;
    return (session1 || session2) ? 'online' : 'geschlossen';
  }

  // Mo, Mi, Do, Fr: 11:30–14:00 & 17:00–22:00
  const session1 = mins >= 11*60+30 && mins < 14*60;
  const session2 = mins >= 17*60    && mins < 22*60;
  return (session1 || session2) ? 'online' : 'geschlossen';
}

cron.schedule('* * * * *', async () => {
  try {
    const s = await Settings.findById('restaurant');
    if (s && s.manualOverride) return; // Manuell gesetzt – nicht überschreiben
    const autoMode = calcAutoMode();
    await Settings.findByIdAndUpdate('restaurant',
      { mode: autoMode, isOpen: autoMode === 'online' },
      { upsert: true, new: true }
    );
  } catch(e) { console.error('Auto-Status Fehler:', e); }
});

// ═══════════════════════════════════════════════════════════════
// WOCHENBERICHT + RECHNUNG (Cron – jeden Sonntag 23:59)
// ═══════════════════════════════════════════════════════════════

// PDF-Generator Helper
function generatePdf(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildFn(doc);
    doc.end();
  });
}

// Rechnungsnummer fortlaufend in MongoDB speichern
async function getNextRechnungNum() {
  const c = await Counter.findByIdAndUpdate('rechnungNum', { $inc: { seq: 1 } }, { new: true, upsert: true });
  const year = new Date().getFullYear();
  return `RE-${year}-${String(c.seq).padStart(4,'0')}`;
}

cron.schedule('59 23 * * 0', async () => {
  try {
    const now    = new Date();
    const wStart = new Date(now); wStart.setDate(now.getDate()-6); wStart.setHours(0,0,0,0);
    const wEnd   = new Date(now); wEnd.setHours(23,59,59,999);
    const kw     = getWeekNum(now);
    const datum  = now.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
    const vonBis = `${wStart.toLocaleDateString('de-DE')} – ${datum}`;

    const orders = await Order.find({
      status: { $in: ['confirmed','preparing','ready','delivered'] },
      createdAt: { $gte: wStart, $lte: wEnd }
    });

    const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
    const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||0.99), 0);
    const nettoBase  = brutto - svcFees;
    const provision  = nettoBase * 0.05;
    const meinBetrag = svcFees + provision;
    const auszahlung = brutto - meinBetrag;
    const web        = orders.filter(o=>o.source!=='pos').length;
    const pos        = orders.filter(o=>o.source==='pos').length;

    const rechnungNr = await getNextRechnungNum();

    // ── PDF 1: FlueVate Rechnung (geht an Owner) ──────────────────
    const rechnungPdf = await generatePdf(doc => {
      const W = 495; // content width
      // Header
      doc.rect(0, 0, 595, 70).fill('#1a1a2e');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('FlueVate', 50, 20);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.7)').text('Online-Bestellsystem · Abrechnung', 50, 46);

      // Invoice title
      doc.moveDown(3).fontSize(16).font('Helvetica-Bold').fillColor('#1a1a2e').text(`RECHNUNG ${rechnungNr}`);
      doc.fontSize(10).font('Helvetica').fillColor('#666').text(`KW ${kw} / ${now.getFullYear()}  ·  ${vonBis}`);
      doc.moveDown(1.5);

      // Addresses side by side
      const addrY = doc.y;
      doc.fontSize(8).fillColor('#999').text('RECHNUNGSSTELLER', 50, addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Abed Rachman Falah / FlueVate', 50, addrY + 14);
      doc.fontSize(10).font('Helvetica').fillColor('#555')
        .text('Zur Goldbrede 30', 50, addrY + 30)
        .text('59269 Beckum', 50, addrY + 44)
        .text('Deutschland', 50, addrY + 58);
      if (process.env.STEUERNUMMER) doc.text(`St.-Nr.: ${process.env.STEUERNUMMER}`, 50, addrY + 72);

      doc.fontSize(8).fillColor('#999').text('RECHNUNGSEMPFÄNGER', 310, addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Pizzeria Amoura', 310, addrY + 14);
      doc.fontSize(10).font('Helvetica').fillColor('#555')
        .text('Oststraße 48', 310, addrY + 30)
        .text('59269 Beckum', 310, addrY + 44)
        .text('Deutschland', 310, addrY + 58);

      doc.y = addrY + 95;
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(1).stroke();
      doc.moveDown(0.8);

      // Invoice meta
      doc.fontSize(9).fillColor('#555')
        .text(`Rechnungsnummer: ${rechnungNr}`, 50, doc.y, { continued: true })
        .text(`Datum: ${datum}`, { align: 'right' });
      doc.text(`Leistungszeitraum: ${vonBis}`, 50);
      doc.moveDown(1);

      // Line items header
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#222').lineWidth(1.5).stroke();
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222')
        .text('Leistung', 50, doc.y)
        .text('Betrag', 50, doc.y - 14, { width: W, align: 'right' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      // Row: Service fees
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Servicegebühren Online-Bestellsystem', 50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`0,99 € × ${orders.length} Bestellungen (KW ${kw})`);
      const sfY = doc.y - 32;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${svcFees.toFixed(2).replace('.',',')} €`, 50, sfY, { width: W, align: 'right' });
      doc.moveDown(0.8);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#eee').lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      // Row: Provision
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Systemprovision (5 % auf Speisenumsatz)', 50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`5 % von ${nettoBase.toFixed(2).replace('.',',')} € Speisenumsatz`);
      const pvY = doc.y - 32;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${provision.toFixed(2).replace('.',',')} €`, 50, pvY, { width: W, align: 'right' });
      doc.moveDown(0.8);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#222').lineWidth(1.5).stroke();
      doc.moveDown(0.5);

      // Total
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1a2e').text('RECHNUNGSBETRAG (netto)', 50);
      const totY = doc.y - 18;
      doc.text(`${meinBetrag.toFixed(2).replace('.',',')} €`, 50, totY, { width: W, align: 'right' });
      doc.moveDown(1.5);

      // Note
      doc.rect(50, doc.y, W, 26).fill('#fff8e1');
      doc.fontSize(9).font('Helvetica').fillColor('#7a5c00')
        .text('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).', 56, doc.y - 20);
      doc.moveDown(2);

      // Footer
      doc.fontSize(8).fillColor('#aaa')
        .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  ${rechnungNr} · KW ${kw}/${now.getFullYear()}`, 50, 780, { width: W, align: 'center' });
    });

    // ── PDF 2: Wochenbericht Pizzeria Amoura ──────────────────────
    const berichtPdf = await generatePdf(doc => {
      const W = 495;
      // Header
      doc.rect(0, 0, 595, 70).fill('#8b1d1d');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('Wochenbericht', 50, 20);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.75)')
        .text(`Pizzeria Amoura  ·  KW ${kw} / ${now.getFullYear()}  ·  ${vonBis}`, 50, 46);

      doc.moveDown(4);

      // Stats table
      const rows = [
        ['Bestellungen gesamt', `${orders.length}`, false],
        ['davon Online', `${web}`, true],
        ['davon Telefon / POS', `${pos}`, false],
        ['Gesamtumsatz (Brutto)', `${brutto.toFixed(2).replace('.',',')} €`, true],
        ['Einbehaltene Gebühren (FlueVate)', `− ${meinBetrag.toFixed(2).replace('.',',')} €`, false],
      ];
      rows.forEach(([label, value, shade]) => {
        const rowY = doc.y;
        if (shade) doc.rect(50, rowY, W, 28).fill('#f5f5f5');
        doc.font('Helvetica').fontSize(11).fillColor('#222').text(label, 58, rowY + 8);
        doc.text(value, 50, rowY + 8, { width: W - 8, align: 'right' });
        doc.y = rowY + 28;
      });

      // Auszahlung highlight
      const ay = doc.y;
      doc.rect(50, ay, W, 38).fill('#e8f5e9');
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#2e7d32')
        .text('Ihr Auszahlungsbetrag', 58, ay + 12);
      doc.text(`${auszahlung.toFixed(2).replace('.',',')} €`, 50, ay + 12, { width: W - 8, align: 'right' });
      doc.y = ay + 52;

      doc.moveDown(0.5);
      doc.fontSize(8).font('Helvetica').fillColor('#aaa')
        .text('* Auszahlung erfolgt automatisch über Stripe Connect auf das hinterlegte Bankkonto.');

      // Footer
      doc.fontSize(8).fillColor('#aaa')
        .text(`Pizzeria Amoura  ·  KW ${kw} / ${now.getFullYear()}`, 50, 780, { width: W, align: 'center' });
    });

    // ── E-Mail 1: Restaurant bekommt nur den Wochenbericht ────────
    const restaurantHtml = `
<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#222">
  <div style="background:#8b1d1d;padding:24px 28px;color:#fff">
    <h2 style="margin:0;font-size:20px">Wochenbericht KW ${kw} / ${now.getFullYear()}</h2>
    <p style="margin:4px 0 0;opacity:.8;font-size:13px">${vonBis}</p>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
      <tr><td style="padding:8px">davon Online</td><td style="padding:8px;text-align:right">${web}</td></tr>
      <tr style="background:#f5f5f5"><td style="padding:8px">davon Telefon / POS</td><td style="padding:8px;text-align:right">${pos}</td></tr>
      <tr><td style="padding:8px">Gesamtumsatz (Brutto)</td><td style="padding:8px;text-align:right">${brutto.toFixed(2).replace('.',',')} €</td></tr>
      <tr style="background:#f5f5f5"><td style="padding:8px">Einbehaltene Gebühren (FlueVate)</td><td style="padding:8px;text-align:right">− ${meinBetrag.toFixed(2).replace('.',',')} €</td></tr>
      <tr style="background:#e8f5e9"><td style="padding:10px;font-weight:bold;color:#2e7d32;font-size:15px">Ihr Auszahlungsbetrag</td><td style="padding:10px;text-align:right;font-weight:bold;color:#2e7d32;font-size:15px">${auszahlung.toFixed(2).replace('.',',')} €</td></tr>
    </table>
    <p style="font-size:11px;color:#aaa;margin-top:8px">* Auszahlung erfolgt automatisch über Stripe Connect.</p>
  </div>
</div>`;

    if (process.env.RESTAURANT_EMAIL) {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzeria-amoura.de',
        to: process.env.RESTAURANT_EMAIL,
        subject: `📊 Wochenbericht KW ${kw} / ${now.getFullYear()} · Pizzeria Amoura`,
        html: restaurantHtml,
      });
    }

    // ── E-Mail 2: Owner bekommt beide PDFs als Anhang ─────────────
    if (process.env.OWNER_EMAIL) {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzeria-amoura.de',
        to: process.env.OWNER_EMAIL,
        subject: `🧾 ${rechnungNr} + Wochenbericht KW ${kw} · Pizzeria Amoura`,
        html: `<p style="font-family:Arial,sans-serif;color:#555">Anbei die Rechnung <b>${rechnungNr}</b> sowie der Wochenbericht KW ${kw} / ${now.getFullYear()} für Pizzeria Amoura.</p>
               <p style="font-family:Arial,sans-serif;color:#555"><b>Zeitraum:</b> ${vonBis}<br><b>Dein Verdienst:</b> ${meinBetrag.toFixed(2).replace('.',',')} €</p>`,
        attachments: [
          { filename: `${rechnungNr}_FlueVate_Rechnung.pdf`, content: rechnungPdf.toString('base64') },
          { filename: `KW${kw}_${now.getFullYear()}_Amoura_Wochenbericht.pdf`, content: berichtPdf.toString('base64') },
        ],
      });
    }

    console.log(`📊 Wochenbericht + Rechnung ${rechnungNr} KW ${kw} versendet`);
  } catch(e) { console.error('Wochenbericht Fehler:', e); }
});

function getWeekNum(d) {
  const dt = new Date(d); dt.setHours(0,0,0,0);
  dt.setDate(dt.getDate()+3-(dt.getDay()+6)%7);
  const w1 = new Date(dt.getFullYear(),0,4);
  return 1+Math.round(((dt-w1)/86400000-3+(w1.getDay()+6)%7)/7);
}

// MONATSBERICHT (Cron – täglich 23:58, nur am letzten Tag des Monats)
// ═══════════════════════════════════════════════════════════════════
cron.schedule('58 23 * * *', async () => {
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (tomorrow.getDate() !== 1) return; // nur am letzten Tag des Monats

  try {
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const mEnd   = new Date(now); mEnd.setHours(23,59,59,999);
    const monat  = now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    const datum  = now.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
    const vonBis = `${mStart.toLocaleDateString('de-DE')} – ${datum}`;
    const rechnungNr = await getNextRechnungNum();

    const orders = await Order.find({
      status: { $in: ['confirmed','preparing','ready','delivered'] },
      createdAt: { $gte: mStart, $lte: mEnd }
    });

    const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
    const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||0.99), 0);
    const nettoBase  = brutto - svcFees;
    const provision  = nettoBase * 0.05;
    const meinBetrag = svcFees + provision;
    const auszahlung = brutto - meinBetrag;
    const web        = orders.filter(o=>o.source!=='pos').length;
    const pos        = orders.filter(o=>o.source==='pos').length;

    const monatsPdf = await generatePdf(doc => {
      const W = 495;
      // Header
      doc.rect(0, 0, 595, 70).fill('#1a1a2e');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('FlueVate', 50, 20);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.7)').text(`Monatsbericht · ${monat}`, 50, 46);

      doc.moveDown(3.5).fontSize(16).font('Helvetica-Bold').fillColor('#1a1a2e').text(`MONATSABRECHNUNG ${rechnungNr}`);
      doc.fontSize(10).font('Helvetica').fillColor('#666').text(`${monat}  ·  ${vonBis}`);
      doc.moveDown(1.5);

      // Addresses
      const addrY = doc.y;
      doc.fontSize(8).fillColor('#999').text('RECHNUNGSSTELLER', 50, addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Abed Rachman Falah / FlueVate', 50, addrY+14);
      doc.fontSize(10).font('Helvetica').fillColor('#555')
        .text('Zur Goldbrede 30', 50, addrY+30)
        .text('59269 Beckum', 50, addrY+44)
        .text('Deutschland', 50, addrY+58);
      if (process.env.STEUERNUMMER) {
        doc.text(`Steuernummer: ${process.env.STEUERNUMMER}`, 50, addrY+72);
      }

      doc.fontSize(8).fillColor('#999').text('RECHNUNGSEMPFÄNGER', 310, addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Pizzeria Amoura', 310, addrY+14);
      doc.fontSize(10).font('Helvetica').fillColor('#555')
        .text('Oststraße 48', 310, addrY+30)
        .text('59269 Beckum', 310, addrY+44)
        .text('Deutschland', 310, addrY+58);

      doc.y = addrY + 100;
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(1).stroke();
      doc.moveDown(0.8);

      doc.fontSize(9).fillColor('#555')
        .text(`Rechnungsnummer: ${rechnungNr}`, 50, doc.y, { continued: true })
        .text(`Datum: ${datum}`, { align: 'right' });
      doc.text(`Leistungszeitraum: ${vonBis}`, 50);
      doc.moveDown(1);

      // Line items
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#222').lineWidth(1.5).stroke();
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222')
        .text('Leistung', 50, doc.y)
        .text('Betrag', 50, doc.y-14, { width: W, align: 'right' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Servicegebühren Online-Bestellsystem', 50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`0,99 € × ${orders.length} Bestellungen (${monat})`);
      const sfY = doc.y - 32;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${svcFees.toFixed(2).replace('.',',')} €`, 50, sfY, { width: W, align: 'right' });
      doc.moveDown(0.8);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#eee').lineWidth(0.5).stroke();
      doc.moveDown(0.5);

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Systemprovision (5 % auf Speisenumsatz)', 50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`5 % von ${nettoBase.toFixed(2).replace('.',',')} € Speisenumsatz`);
      const pvY = doc.y - 32;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${provision.toFixed(2).replace('.',',')} €`, 50, pvY, { width: W, align: 'right' });
      doc.moveDown(0.8);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#222').lineWidth(1.5).stroke();
      doc.moveDown(0.5);

      doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1a2e').text('RECHNUNGSBETRAG (netto)', 50);
      const totY = doc.y - 18;
      doc.text(`${meinBetrag.toFixed(2).replace('.',',')} €`, 50, totY, { width: W, align: 'right' });
      doc.moveDown(1.5);

      doc.rect(50, doc.y, W, 26).fill('#fff8e1');
      doc.fontSize(9).font('Helvetica').fillColor('#7a5c00')
        .text('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).', 56, doc.y-20);
      doc.moveDown(2);

      // Monatsübersicht
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('MONATSÜBERSICHT');
      doc.moveDown(0.5);
      const rows = [
        ['Bestellungen gesamt', `${orders.length}`, false],
        ['davon Online', `${web}`, true],
        ['davon Telefon / POS', `${pos}`, false],
        ['Gesamtumsatz (Brutto)', `${brutto.toFixed(2).replace('.',',')} €`, true],
        ['Einbehaltene Gebühren (FlueVate)', `− ${meinBetrag.toFixed(2).replace('.',',')} €`, false],
        ['Auszahlung an Restaurant', `${auszahlung.toFixed(2).replace('.',',')} €`, true],
      ];
      rows.forEach(([label, value, shade]) => {
        const rowY = doc.y;
        if (shade) doc.rect(50, rowY, W, 26).fill('#f5f5f5');
        doc.font('Helvetica').fontSize(10).fillColor('#222').text(label, 58, rowY+8);
        doc.text(value, 50, rowY+8, { width: W-8, align: 'right' });
        doc.y = rowY + 26;
      });

      doc.fontSize(8).fillColor('#aaa')
        .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  ${rechnungNr} · ${monat}`, 50, 780, { width: W, align: 'center' });
    });

    if (process.env.OWNER_EMAIL) {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzeria-amoura.de',
        to: process.env.OWNER_EMAIL,
        subject: `📅 Monatsbericht ${monat} · Pizzeria Amoura`,
        html: `<p style="font-family:Arial,sans-serif;color:#555">Anbei der Monatsbericht <b>${monat}</b> für Pizzeria Amoura.<br><b>Dein Verdienst:</b> ${meinBetrag.toFixed(2).replace('.',',')} €</p>`,
        attachments: [
          { filename: `${rechnungNr}_FlueVate_Monatsbericht_${monat.replace(' ','_')}.pdf`, content: monatsPdf.toString('base64') },
        ],
      });
    }
    console.log(`📅 Monatsbericht ${monat} versendet`);
  } catch(e) { console.error('Monatsbericht Fehler:', e); }
});

// ─── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🍕 Pizzeria Amoura Backend · Port ${PORT}`));
