const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Stripe = require('stripe');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── STRIPE & RESEND ────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── CORS ────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

// ─── RAW BODY for Stripe Webhook (must be before express.json) ──
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));

// ─── JSON BODY ───────────────────────────────────────────────────
app.use(express.json());

// ─── MONGODB ─────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB verbunden'))
  .catch(err => console.error('❌ MongoDB Fehler:', err));

// ─── ORDER SCHEMA ────────────────────────────────────────────────
const orderSchema = new mongoose.Schema({
  orderNum: { type: Number, unique: true },
  mode: { type: String, enum: ['lieferung','abholung'], required: true },
  status: { type: String, default: 'confirmed',
    enum: ['pending','confirmed','preparing','ready','delivered','cancelled'] },
  payment: { type: String, enum: ['bar','stripe','karte'], required: true },
  paymentStatus: { type: String, default: 'unpaid', enum: ['unpaid','paid','pending','refunded'] },
  stripeSessionId: String,
  stripePaymentIntentId: String,
  customer: {
    first: String, last: String, email: String,
    phone: String, city: String, street: String, house: String
  },
  items: [{ name: String, price: Number, qty: Number, note: String }],
  subtotal: Number,
  deliveryFee: { type: Number, default: 0 },
  serviceFee: { type: Number, default: 0.99 },
  total: Number,
  note: String,
  prepTime: { type: Number, default: null },
  cancelReason: { type: String, default: '' },
}, { timestamps: true });

const Order = mongoose.model('Order', orderSchema);

// ─── COUNTER für orderNum ─────────────────────────────────────────
const counterSchema = new mongoose.Schema({ _id: String, seq: Number });
const Counter = mongoose.model('Counter', counterSchema);

async function getNextOrderNum() {
  const result = await Counter.findByIdAndUpdate(
    'orderNum',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return result.seq + 1000;
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Nicht autorisiert' });
  }
  const token = auth.split(' ')[1];
  if (token !== process.env.ADMIN_TOKEN_SECRET) {
    return res.status(401).json({ message: 'Ungültiger Token' });
  }
  next();
}

// ─── AVAILABILITY SCHEMA ─────────────────────────────────────────
const availabilitySchema = new mongoose.Schema({
  itemName: { type: String, required: true, unique: true },
  available: { type: Boolean, default: false }
}, { timestamps: true });
const Availability = mongoose.model('Availability', availabilitySchema);

// ═══════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════

// ── Health Check ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', restaurant: 'ATAS Döner & Pizza Beckum', time: new Date() });
});

// ── WhatsApp Nummer (PUBLIC) ───────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    whatsapp: process.env.WHATSAPP_NUMBER || ''
  });
});

// ── Verfügbarkeit abrufen (PUBLIC) ────────────────────────────────
app.get('/api/availability', async (req, res) => {
  try {
    const disabled = await Availability.find({ available: false }).select('itemName -_id');
    res.json({ disabled: disabled.map(d => d.itemName) });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden' });
  }
});

// ── Neue Bestellung → IMMER als pending speichern ─────────────────
app.post('/api/orders', async (req, res) => {
  try {
    const orderNum = await getNextOrderNum();
    const isAdmin = req.body.source === 'admin';
    const order = new Order({
      ...req.body,
      orderNum,
      status: isAdmin ? 'confirmed' : 'pending'
    });
    await order.save();

    if (isAdmin) {
      await sendConfirmationEmail(order);
      await sendRestaurantEmail(order);
      await triggerPrint(order);
    }

    res.status(201).json({ orderNum: order.orderNum, order });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ message: 'Fehler beim Speichern der Bestellung' });
  }
});

// ── Stripe Checkout Session erstellen ─────────────────────────────
app.post('/api/create-stripe-checkout', async (req, res) => {
  try {
    const { items, subtotal, deliveryFee, serviceFee, total, customer, mode, note, ...rest } = req.body;
    const orderNum = await getNextOrderNum();

    const lineItems = items.map(item => ({
      price_data: {
        currency: 'eur',
        product_data: { name: `${item.qty}× ${item.name}${item.note ? ' ('+item.note+')' : ''}` },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.qty,
    }));

    if (deliveryFee && deliveryFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: { name: 'Fahrtkostenpauschale' },
          unit_amount: Math.round(deliveryFee * 100),
        },
        quantity: 1,
      });
    }

    if (serviceFee && serviceFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: { name: 'Servicegebühr' },
          unit_amount: Math.round(serviceFee * 100),
        },
        quantity: 1,
      });
    }

    const order = new Order({
      ...req.body,
      orderNum,
      status: 'pending',
      paymentStatus: 'pending',
    });
    await order.save();

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}?stripe=success&order=${orderNum}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}?stripe=cancel`,
      metadata: { orderId: order._id.toString(), orderNum: orderNum.toString() },
      customer_email: customer?.email,
    });

    await Order.findByIdAndUpdate(order._id, { stripeSessionId: session.id });

    res.json({ url: session.url, orderNum });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ message: 'Stripe Fehler' });
  }
});

// ── Stripe Webhook ─────────────────────────────────────────────────
app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const order = await Order.findOneAndUpdate(
      { stripeSessionId: session.id },
      { paymentStatus: 'paid', stripePaymentIntentId: session.payment_intent, status: 'pending' },
      { new: true }
    );
    if (order) console.log(`✅ Stripe Zahlung für Bestellung #${order.orderNum} bestätigt`);
  }

  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    await Order.findOneAndUpdate(
      { stripeSessionId: session.id },
      { status: 'cancelled', cancelReason: 'Stripe Session abgelaufen' }
    );
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════

// ── Login ─────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ message: 'Falsches Passwort' });
  }
  res.json({ token: process.env.ADMIN_TOKEN_SECRET });
});

// ── Alle Bestellungen abrufen ──────────────────────────────────────
app.get('/api/admin/orders', authMiddleware, async (req, res) => {
  try {
    const { date, status } = req.query;
    let filter = {};
    if (date) {
      const start = new Date(date); start.setHours(0,0,0,0);
      const end = new Date(date); end.setHours(23,59,59,999);
      filter.createdAt = { $gte: start, $lte: end };
    }
    if (status) filter.status = status;
    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden' });
  }
});

// ── Pending Bestellungen abrufen ───────────────────────────────────
app.get('/api/admin/orders/pending', authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ status: 'pending' }).sort({ createdAt: 1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Laden' });
  }
});

// ── Bestellung bestätigen ──────────────────────────────────────────
app.patch('/api/admin/orders/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const { prepTime } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: 'confirmed', prepTime: prepTime || 45 },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: 'Bestellung nicht gefunden' });
    await sendConfirmationEmail(order, prepTime);
    await sendRestaurantEmail(order);
    await triggerPrint(order);
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Bestätigen' });
  }
});

// ── Bestellstatus aktualisieren ────────────────────────────────────
app.patch('/api/admin/orders/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id, { status }, { new: true }
    );
    if (!order) return res.status(404).json({ message: 'Bestellung nicht gefunden' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Aktualisieren' });
  }
});

// ── Zahlungsstatus aktualisieren ───────────────────────────────────
app.patch('/api/admin/orders/:id/payment', authMiddleware, async (req, res) => {
  try {
    const { paymentStatus } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id, { paymentStatus }, { new: true }
    );
    if (!order) return res.status(404).json({ message: 'Bestellung nicht gefunden' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Aktualisieren' });
  }
});

// ── Bestellung stornieren ─────────────────────────────────────────
app.delete('/api/admin/orders/:id', authMiddleware, async (req, res) => {
  try {
    const cancelReason = req.body?.cancelReason || '';
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: 'cancelled', cancelReason },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: 'Bestellung nicht gefunden' });

    // ── Automatische Stripe-Rückerstattung ──────────────────────────
    let refundStatus = null;
    if (order.payment === 'stripe' && order.paymentStatus === 'paid' && order.stripePaymentIntentId) {
      try {
        const refund = await stripe.refunds.create({
          payment_intent: order.stripePaymentIntentId,
        });
        refundStatus = refund.status; // 'succeeded' oder 'pending'
        await Order.findByIdAndUpdate(order._id, { paymentStatus: 'refunded' });
        console.log(`💸 Stripe-Rückerstattung für Bestellung #${order.orderNum}: ${refund.status}`);
      } catch (stripeErr) {
        console.error(`❌ Stripe-Refund Fehler für #${order.orderNum}:`, stripeErr.message);
        refundStatus = 'failed';
      }
    }

    await sendCancellationEmail(order, cancelReason, refundStatus);
    res.json({ success: true, order, refundStatus });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Stornieren' });
  }
});

// ── Bon nachdrucken ────────────────────────────────────────────────
app.post('/api/admin/orders/:id/print', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Nicht gefunden' });
    await triggerPrint(order);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Druckfehler' });
  }
});

// ── Verfügbarkeit setzen (ADMIN) ──────────────────────────────────
app.post('/api/admin/availability', authMiddleware, async (req, res) => {
  try {
    const { itemName, available } = req.body;
    await Availability.findOneAndUpdate(
      { itemName },
      { available },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Fehler beim Speichern' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// E-MAIL FUNKTIONEN (via Resend)
// ═══════════════════════════════════════════════════════════════════

async function sendConfirmationEmail(order, estimatedMinutes) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  try {
    const mins = estimatedMinutes || order.prepTime || (order.mode === 'lieferung' ? 40 : 20);
    const modeText = order.mode === 'lieferung' ? '🛵 Lieferung' : '🏃 Abholung';
    const addrText = order.mode === 'lieferung'
      ? `${order.customer.street} ${order.customer.house}, ${order.customer.city}`
      : 'Nordstr. 45a, 59269 Beckum';
    const itemsHtml = (order.items || [])
      .map(i => `<tr><td>${i.qty}×</td><td>${i.name}${i.note ? ' <em>('+i.note+')</em>' : ''}</td><td style="text-align:right">${(i.price*i.qty).toFixed(2).replace('.',',')} €</td></tr>`)
      .join('');

    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'bestellungen@atas-beckum.de',
      to: order.customer.email,
      subject: `✅ Bestellung #${order.orderNum} bestätigt – ATAS Döner & Pizza`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#111;">
          <div style="background:linear-gradient(135deg,#1a0900,#3d1800);color:#fff;padding:24px;text-align:center;">
            <h1 style="margin:0;font-size:24px;color:#e8a020;letter-spacing:2px;">ATAS</h1>
            <p style="margin:4px 0 0;opacity:.8;font-size:14px;color:#ccc;">Döner & Pizza · Beckum</p>
          </div>
          <div style="padding:28px 24px;background:#1a1a1a;color:#f0ece4;">
            <h2 style="color:#e8a020;">Bestellung #${order.orderNum} bestätigt ✅</h2>
            <p>Hallo <strong>${order.customer.first}</strong>,<br>deine Bestellung wurde bestätigt!</p>
            <div style="background:#222;border:1px solid #333;border-radius:8px;padding:16px;margin:16px 0;">
              <p style="margin:0 0 6px;font-weight:bold;color:#f0ece4;">${modeText}</p>
              <p style="margin:0;font-size:14px;color:#888;">${addrText}</p>
              <p style="margin:4px 0 0;font-size:16px;font-weight:bold;color:#d4541a;">⏱ Voraussichtlich ~${mins} Minuten</p>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:14px;color:#f0ece4;">
              <thead><tr style="border-bottom:2px solid #333;">
                <th style="text-align:left;padding:6px 0;">Menge</th>
                <th style="text-align:left;padding:6px 0;">Artikel</th>
                <th style="text-align:right;padding:6px 0;">Preis</th>
              </tr></thead>
              <tbody>${itemsHtml}</tbody>
            </table>
            <div style="border-top:1px solid #333;margin-top:12px;padding-top:10px;color:#f0ece4;">
              <div style="display:flex;justify-content:space-between;font-size:13px;color:#888;margin:3px 0;"><span>Zwischensumme</span><span>${(order.subtotal||0).toFixed(2).replace('.',',')} €</span></div>
              ${order.deliveryFee?`<div style="display:flex;justify-content:space-between;font-size:13px;color:#888;margin:3px 0;"><span>Fahrtkostenpauschale</span><span>${order.deliveryFee.toFixed(2).replace('.',',')} €</span></div>`:''}
              <div style="display:flex;justify-content:space-between;font-size:13px;color:#888;margin:3px 0;"><span>Servicegebühr</span><span>${(order.serviceFee||0.50).toFixed(2).replace('.',',')} €</span></div>
              <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:16px;margin-top:8px;border-top:2px solid #e8a020;padding-top:8px;"><span style="color:#f0ece4;">Gesamt</span><span style="color:#d4541a;">${(order.total||0).toFixed(2).replace('.',',')} €</span></div>
            </div>
            <p style="font-size:13px;color:#888;margin-top:16px;">Zahlung: ${order.payment==='bar'?'Barzahlung':order.payment==='stripe'?'Kreditkarte (Stripe)':'EC-Karte'} · ${order.paymentStatus==='paid'?'✅ Bezahlt':'💵 Bei Lieferung/Abholung'}</p>
            ${order.note?`<p style="font-size:13px;background:#222;padding:10px;border-radius:6px;color:#f0ece4;">📝 Anmerkung: ${order.note}</p>`:''}
          </div>
          <div style="background:#111;padding:16px 24px;text-align:center;font-size:12px;color:#555;">
            ATAS Döner & Pizza · Nordstr. 45a · 59269 Beckum<br>
            Alle Preise inkl. 7% / 19% MwSt.
          </div>
        </div>`
    });
    console.log(`📧 Bestätigungs-E-Mail gesendet an ${order.customer.email}`);
  } catch (err) {
    console.error('E-Mail Fehler (Kunde):', err);
  }
}

async function sendRestaurantEmail(order) {
  if (!process.env.RESTAURANT_EMAIL) return;
  try {
    const itemsList = (order.items || [])
      .map(i => `${i.qty}× ${i.name}${i.note?' ('+i.note+')':''}`)
      .join('\n');
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'bestellungen@atas-beckum.de',
      to: process.env.RESTAURANT_EMAIL,
      subject: `🔔 Neue Bestellung #${order.orderNum} – ${order.mode==='lieferung'?'Lieferung':'Abholung'}`,
      html: `<pre style="font-family:monospace;font-size:14px;">
NEUE BESTELLUNG #${order.orderNum}
══════════════════════════════
Art: ${order.mode === 'lieferung' ? '🛵 LIEFERUNG' : '🏃 ABHOLUNG'}
Kunde: ${order.customer?.first} ${order.customer?.last}
${order.customer?.phone?`Tel: ${order.customer.phone}`:''}
${order.mode==='lieferung'?`Adresse: ${order.customer?.street} ${order.customer?.house}, ${order.customer?.city}`:''}

ARTIKEL:
${itemsList}

Zwischensumme: ${(order.subtotal||0).toFixed(2)} €
${order.deliveryFee?`Fahrtkostenpauschale: ${order.deliveryFee.toFixed(2)} €`:''}
Servicegebühr: ${(order.serviceFee||0.50).toFixed(2)} €
GESAMT: ${(order.total||0).toFixed(2)} €

Zahlung: ${order.payment==='bar'?'BAR':order.payment==='stripe'?'KREDITKARTE':'EC-KARTE'} – ${order.paymentStatus==='paid'?'✅ BEZAHLT':'❌ NOCH OFFEN'}
${order.note?`Anmerkung: ${order.note}`:''}
══════════════════════════════</pre>`
    });
  } catch (err) {
    console.error('E-Mail Fehler (Restaurant):', err);
  }
}

async function sendCancellationEmail(order, cancelReason, refundStatus) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const reasonText = cancelReason || order.cancelReason || '';

  let refundHtml = '';
  if (order.payment === 'stripe' && order.paymentStatus === 'refunded') {
    if (refundStatus === 'succeeded') {
      refundHtml = `<div style="background:#1a2e1a;border:1px solid #2e5e2e;border-radius:8px;padding:14px;margin:16px 0;">
        <strong style="color:#4caf50;">💸 Rückerstattung erfolgreich</strong>
        <p style="color:#aaa;margin:6px 0 0;font-size:13px;">Der Betrag von <strong style="color:#f0ece4;">${(order.total||0).toFixed(2).replace('.',',')} €</strong> wird innerhalb von 5–10 Werktagen auf deine Karte zurückgebucht.</p>
      </div>`;
    } else if (refundStatus === 'pending') {
      refundHtml = `<div style="background:#1a2a1a;border:1px solid #3a5a3a;border-radius:8px;padding:14px;margin:16px 0;">
        <strong style="color:#81c784;">💸 Rückerstattung wird bearbeitet</strong>
        <p style="color:#aaa;margin:6px 0 0;font-size:13px;">Der Betrag von <strong style="color:#f0ece4;">${(order.total||0).toFixed(2).replace('.',',')} €</strong> wird in Kürze zurückgebucht.</p>
      </div>`;
    } else {
      refundHtml = `<div style="background:#2e1a1a;border:1px solid #5e2e2e;border-radius:8px;padding:14px;margin:16px 0;">
        <strong style="color:#e57373;">⚠️ Rückerstattung fehlgeschlagen</strong>
        <p style="color:#aaa;margin:6px 0 0;font-size:13px;">Bitte kontaktiere uns direkt: <strong style="color:#e8a020;">02521 / 826 48 00</strong></p>
      </div>`;
    }
  }

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'bestellungen@atas-beckum.de',
      to: order.customer.email,
      subject: `❌ Bestellung #${order.orderNum} storniert – ATAS Döner & Pizza`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#111;">
          <div style="background:linear-gradient(135deg,#1a0900,#3d1800);color:#fff;padding:24px;text-align:center;">
            <h1 style="margin:0;color:#e8a020;">ATAS Döner & Pizza</h1>
          </div>
          <div style="padding:28px 24px;background:#1a1a1a;color:#f0ece4;">
            <h2>Bestellung #${order.orderNum} wurde storniert</h2>
            <p>Hallo <strong>${order.customer.first}</strong>,<br>
            deine Bestellung wurde leider storniert.</p>
            ${reasonText ? `<div style="background:#222;border-radius:8px;padding:14px;margin:16px 0;border:1px solid #333;">
              <strong style="color:#e8a020;">Grund:</strong> <span style="color:#f0ece4;">${reasonText}</span>
            </div>` : ''}
            ${refundHtml}
            <p style="color:#888;">Bei Fragen erreichst du uns telefonisch: <strong style="color:#e8a020;">02521 / 826 48 00</strong></p>
            <p style="color:#888;">Wir entschuldigen uns für die Unannehmlichkeiten.</p>
          </div>
        </div>`
    });
  } catch (err) {
    console.error('E-Mail Fehler (Storno):', err);
  }
}

// ═══════════════════════════════════════════════════════════════════
// PRINTNODE (Bondruck)
// ═══════════════════════════════════════════════════════════════════

async function triggerPrint(order) {
  if (!process.env.PRINTNODE_API_KEY || !process.env.PRINTNODE_PRINTER_ID) return;
  try {
    const printHelper = require('./printnode-helper');
    await printHelper.printOrder(order);
  } catch (err) {
    console.error('PrintNode Fehler:', err);
  }
}

// ─── START ────────────────────────────────────────────────────────
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


app.listen(PORT, () => {
  console.log(`🚀 ATAS Döner & Pizza Backend läuft auf Port ${PORT}`);
});
