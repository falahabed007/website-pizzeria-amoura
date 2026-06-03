const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const Stripe     = require('stripe');
const { Resend } = require('resend'); // v2.0.1
const cron       = require('node-cron');
const PDFDocument = require('pdfkit');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

// Stripe lazy – liest Key bei jedem Aufruf
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY nicht gesetzt');
  return Stripe(key);
}

// Resend lazy – kein Crash beim Start wenn Key fehlt
function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('⚠️  RESEND_API_KEY fehlt – E-Mails werden nicht gesendet'); return null; }
  return new Resend(key);
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

// ─── Statische HTML-Dateien (kein Cache) ─────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

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
  items:       [{ name: String, price: Number, qty: Number, note: String, extraDetails: [{ name: String, price: Number }] }],
  subtotal:    Number,
  deliveryFee: { type: Number, default: 0 },
  serviceFee:  { type: Number, default: 0.99 },
  total:       Number,
  note:        String,
  coupon:      String,
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
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

const userSchema = new mongoose.Schema({
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  first:    { type: String, required: true, trim: true },
  last:     { type: String, required: true, trim: true },
  phone:    { type: String, default: '' },
  addresses: [{
    label:  { type: String, default: 'Zuhause' },
    street: String,
    house:  String,
    city:   String,
    zip:    String,
  }],
  defaultAddress: { type: Number, default: 0 },
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

// ─── Counter ─────────────────────────────────────────────────────
async function getNextOrderNum() {
  const r = await Counter.findByIdAndUpdate('orderNum',
    { $inc: { seq: 1 } }, { new: true, upsert: true });
  return r.seq + 1000;
}

// ─── Admin Auth ───────────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ message: 'Nicht autorisiert' });
  if (h.split(' ')[1] !== process.env.ADMIN_TOKEN_SECRET) return res.status(401).json({ message: 'Token ungültig' });
  next();
}

// ─── Customer Auth (JWT) ──────────────────────────────────────────
function customerAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Nicht eingeloggt' });
  }
  try {
    req.user = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Token abgelaufen oder ungültig' });
  }
}

// ═══════════════════════════════════════════════════════════════
// KUNDEN-AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, first, last, phone } = req.body;
    if (!email || !password || !first || !last || !phone) {
      return res.status(400).json({ message: 'Alle Pflichtfelder ausfüllen' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Passwort mindestens 6 Zeichen' });
    }
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ message: 'E-Mail bereits registriert' });

    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({ email, password: hash, first, last, phone: phone || '' });
    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({
      token,
      user: { id: user._id, email: user.email, first: user.first, last: user.last }
    });
  } catch (err) {
    console.error('Register Fehler:', err);
    res.status(500).json({ message: 'Registrierung fehlgeschlagen' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: 'Falsche E-Mail oder Passwort' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ message: 'Falsche E-Mail oder Passwort' });

    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: { id: user._id, email: user.email, first: user.first, last: user.last }
    });
  } catch (err) {
    console.error('Login Fehler:', err);
    res.status(500).json({ message: 'Login fehlgeschlagen' });
  }
});

app.get('/api/auth/me', customerAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User nicht gefunden' });
    res.json(user);
  } catch {
    res.status(500).json({ message: 'Fehler' });
  }
});

app.patch('/api/auth/profile', customerAuth, async (req, res) => {
  try {
    const { first, last, phone, addresses, defaultAddress } = req.body;
    const update = {};
    if (first) update.first = first;
    if (last) update.last = last;
    if (phone !== undefined) update.phone = phone;
    if (addresses) update.addresses = addresses;
    if (defaultAddress !== undefined) update.defaultAddress = defaultAddress;

    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).select('-password');
    res.json(user);
  } catch {
    res.status(500).json({ message: 'Profil-Update fehlgeschlagen' });
  }
});

app.patch('/api/auth/password', customerAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'Neues Passwort mindestens 6 Zeichen' });
    }
    const user = await User.findById(req.user.id);
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ message: 'Aktuelles Passwort falsch' });

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ message: 'Passwort geändert' });
  } catch {
    res.status(500).json({ message: 'Fehler beim Passwort ändern' });
  }
});

app.get('/api/account/orders', customerAuth, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('orderNum status payment total items createdAt mode');
    res.json(orders);
  } catch {
    res.status(500).json({ message: 'Bestellhistorie konnte nicht geladen werden' });
  }
});

app.post('/api/account/reorder/:orderId', customerAuth, async (req, res) => {
  try {
    const original = await Order.findOne({ _id: req.params.orderId, userId: req.user.id });
    if (!original) return res.status(404).json({ message: 'Bestellung nicht gefunden' });

    res.json({
      items: original.items,
      mode: original.mode,
      note: original.note || ''
    });
  } catch {
    res.status(500).json({ message: 'Re-Order fehlgeschlagen' });
  }
});

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
    'Beckum':  { min: 15.00, fee: 2.50 },
    'Roland':  { min: 20.00, fee: 3.00 },
    'Vellern': { min: 20.00, fee: 3.00 },
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
    // Auto-Modus: sofort berechnen wenn manualOverride auf false gesetzt wird
    if (manualOverride === false && mode === undefined) {
      update.mode = calcAutoMode();
    }
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

// ── Gutscheincode Verlosung ───────────────────────────────────────
app.post('/api/coupon-raffle', async (req, res) => {
  const { email, name, coupon } = req.body;
  if (!email || !coupon) return res.status(400).json({ error: 'Fehlende Felder' });
  if ((coupon || '').toUpperCase() !== 'ROLLNCONE') return res.status(400).json({ error: 'Ungültiger Gutscheincode' });

  const resend = getResend();
  if (!resend) return res.json({ ok: true });

  const firstName = (name || 'Kunde').split(' ')[0];
  const now = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const customerHtml = `
<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fff9f5;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:580px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

  <!-- Header: Roll N Cone -->
  <div style="background:linear-gradient(135deg,#ff6b35 0%,#ff4b8b 50%,#a855f7 100%);padding:40px 30px;text-align:center;">
    <div style="font-size:52px;margin-bottom:8px;">🍦</div>
    <h1 style="color:#fff;margin:0;font-size:28px;font-weight:900;letter-spacing:-0.5px;">Roll N Cone</h1>
    <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px;letter-spacing:1px;text-transform:uppercase;">× Pizzeria Amoura</p>
  </div>

  <!-- Konfetti Banner -->
  <div style="background:#fff3e0;padding:18px 30px;text-align:center;border-bottom:2px dashed #ffcc80;">
    <p style="margin:0;font-size:22px;font-weight:900;color:#e65100;">🎉 Du bist dabei!</p>
    <p style="margin:4px 0 0;font-size:14px;color:#bf360c;">Deine Teilnahme an der Verlosung wurde erfolgreich registriert.</p>
  </div>

  <!-- Body -->
  <div style="padding:30px 30px 20px;">
    <p style="font-size:16px;color:#333;margin:0 0 16px;">Hallo <strong>${firstName}</strong>,</p>
    <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">
      mit dem Gutscheincode <strong style="color:#ff4b8b;font-size:16px;letter-spacing:2px;">ROLLNCONE</strong> hast du erfolgreich an unserer Kooperations-Verlosung zwischen <strong>Pizzeria Amoura</strong> und <strong>Roll N Cone</strong> teilgenommen.
    </p>

    <!-- Gewinn-Box -->
    <div style="background:linear-gradient(135deg,#fff0fb,#fff8f0);border:2px solid #ffd6f0;border-radius:14px;padding:22px;text-align:center;margin-bottom:22px;">
      <p style="margin:0 0 8px;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px;">Du kannst gewinnen</p>
      <p style="margin:0;font-size:22px;font-weight:900;color:#a855f7;">🍦 Kostenloses Roll N Cone Erlebnis</p>
      <p style="margin:8px 0 0;font-size:13px;color:#666;">Inkl. deiner Lieblings-Kreation nach Wahl</p>
    </div>

    <div style="background:#f9f9f9;border-radius:10px;padding:16px 20px;margin-bottom:22px;">
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#333;">📋 Deine Teilnahme im Überblick</p>
      <table style="width:100%;font-size:13px;color:#555;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#888;">Teilnahmedatum</td><td style="text-align:right;font-weight:600;">${now}</td></tr>
        <tr><td style="padding:4px 0;color:#888;">Code</td><td style="text-align:right;font-weight:600;color:#ff4b8b;">ROLLNCONE</td></tr>
        <tr><td style="padding:4px 0;color:#888;">E-Mail</td><td style="text-align:right;font-weight:600;">${email}</td></tr>
      </table>
    </div>

    <p style="font-size:13px;color:#777;line-height:1.7;margin:0 0 20px;">
      Der Gewinner wird direkt per E-Mail benachrichtigt. Wir wünschen dir viel Glück! 🍀<br>
      Bis dahin – genieße deine Bestellung bei Pizzeria Amoura! 🍕
    </p>
  </div>

  <!-- Roll N Cone Info -->
  <div style="background:linear-gradient(135deg,#ff6b35,#ff4b8b);padding:20px 30px;text-align:center;">
    <p style="color:#fff;margin:0 0 6px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Unsere Kooperationspartner</p>
    <p style="color:rgba(255,255,255,0.9);margin:0;font-size:14px;">🍦 Roll N Cone – Frische Eiscreme-Rollen & Waffelkegel</p>
    <a href="https://www.rollncone.de" style="color:#fff;font-size:12px;opacity:0.8;text-decoration:underline;">www.rollncone.de</a>
  </div>

  <!-- Footer -->
  <div style="background:#f7f3ee;padding:14px 30px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#aaa;">Pizzeria Amoura · Oststraße 48 · 59269 Beckum · Tel: 02521 / 829 06 00</p>
    <p style="margin:4px 0 0;font-size:11px;color:#ccc;">Diese E-Mail wurde automatisch generiert.</p>
  </div>
</div>
</body>
</html>`;

  try {
    await resend.emails.send({
      from:    process.env.EMAIL_FROM || 'bestellungen@pizzeria-amoura.de',
      to:      email,
      bcc:     'rachmanfalah5@gmail.com',
      subject: '🎉 Deine Teilnahme an der Roll N Cone Verlosung – Pizzeria Amoura',
      html:    customerHtml
    });
    console.log(`🎟️ Verlosungs-Mail → ${email}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('Coupon-Mail Fehler:', e);
    res.status(500).json({ error: 'E-Mail konnte nicht gesendet werden' });
  }
});

// ── Neue Web-Bestellung (pending) ────────────────────────────────
app.post('/api/orders', async (req, res) => {
  try {
    // userId aus Kunden-JWT extrahieren falls vorhanden (Gastbestellung bleibt möglich)
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        userId = decoded.id;
      } catch {} // Gastbestellung – kein Fehler
    }

    const orderNum = await getNextOrderNum();
    const isPOS    = req.body.source === 'pos';
    const order    = new Order({
      ...req.body, orderNum, userId,
      status: isPOS ? 'confirmed' : 'pending'
    });
    await order.save();
    if (isPOS) {
      await sendConfirmationEmail(order, order.prepTime || 20);
      await sendRestaurantEmail(order);
      await triggerPrint(order);
    }
    await sendCouponRaffleEmail(order);
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
    // serviceFee(0,99€) + 5% vom subtotal + Stripe-Transaktionsgebühr (1,5% + 0,25€)
    // stripeFee in appFee einrechnen → Gastro trägt Stripe-Gebühren, FlueVate behält vollen Anteil
    const stripeFee = Math.round((total * 0.015 + 0.25) * 100);
    const appFee = Math.round((serviceFee + (subtotal * 0.05)) * 100) + stripeFee;

    const sessionOpts = {
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
      // Mit Connect: payment_method_types explizit (Klarna nicht mit Connect kompatibel)
      sessionOpts.payment_method_types = ['card'];
      sessionOpts.payment_intent_data = {
        application_fee_amount: appFee,
        transfer_data: { destination: process.env.STRIPE_CONNECT_ACCOUNT }
      };
    } else {
      // Ohne Connect: alle im Stripe-Dashboard aktivierten Methoden erlauben
      // (Karte, Apple Pay, Google Pay, Klarna, etc.)
      sessionOpts.automatic_payment_methods = { enabled: true };
    }

    const session = await getStripe().checkout.sessions.create(sessionOpts);

    const order = new Order({
      items, subtotal, deliveryFee, serviceFee, total,
      customer, mode, note, orderNum,
      coupon: req.body.coupon || null,
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
      await sendCouponRaffleEmail(order);
    }
  }
  if (event.type === 'checkout.session.expired') {
    await Order.findOneAndUpdate({ stripeSessionId: event.data.object.id }, { status:'cancelled' });
  }
  res.json({ received: true });
});

// ── Zahlungsverifikation (Fallback falls Webhook fehlschlägt) ──
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, message: 'sessionId fehlt' });

    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.json({ ok: false, message: 'Noch nicht bezahlt' });
    }

    const order = await Order.findOne({ stripeSessionId: sessionId });
    if (!order) return res.status(404).json({ ok: false, message: 'Bestellung nicht gefunden' });

    if (order.status === 'awaiting_payment') {
      order.paymentStatus = 'paid';
      order.status = 'pending';
      order.stripePaymentIntentId = session.payment_intent;
      await order.save();
      console.log(`✅ Zahlung verifiziert (Fallback): #${order.orderNum}`);
      await sendCouponRaffleEmail(order);
    }

    res.json({ ok: true, orderNum: order.orderNum });
  } catch(e) {
    console.error('verify-payment Fehler:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── Stripe-Bestellungen nachträglich einbuchen (Admin) ──────────
app.post('/api/admin/recover-stripe-orders', auth, async (_req, res) => {
  try {
    const stuck = await Order.find({ status: 'awaiting_payment', payment: 'stripe' });
    const recovered = [];
    for (const order of stuck) {
      try {
        const session = await getStripe().checkout.sessions.retrieve(order.stripeSessionId);
        if (session.payment_status === 'paid') {
          order.paymentStatus = 'paid';
          order.status = 'pending';
          order.stripePaymentIntentId = session.payment_intent;
          await order.save();
          recovered.push(order.orderNum);
          console.log(`🔁 Nachträglich eingebucht: #${order.orderNum}`);
        }
      } catch(e) {
        console.warn(`Stripe-Abfrage für #${order.orderNum} fehlgeschlagen:`, e.message);
      }
    }
    res.json({ recovered, total: stuck.length });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/admin/customers/:userId/orders', auth, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(orders);
  } catch(e) {
    res.status(500).json({ message: 'Fehler beim Laden der Bestellungen' });
  }
});

app.get('/api/admin/customers', auth, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    const userIds = users.map(u => u._id);
    const stats = await Order.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: '$userId', count: { $sum: 1 }, total: { $sum: '$total' }, lastOrder: { $max: '$createdAt' } } }
    ]);
    const statsMap = {};
    stats.forEach(s => { statsMap[s._id.toString()] = s; });
    const result = users.map(u => ({
      ...u.toObject(),
      orderCount: statsMap[u._id.toString()]?.count || 0,
      orderTotal: statsMap[u._id.toString()]?.total || 0,
      lastOrder:  statsMap[u._id.toString()]?.lastOrder || null,
    }));
    res.json(result);
  } catch(e) {
    res.status(500).json({ message: 'Fehler beim Laden der Kunden' });
  }
});

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
    const dateParam = req.query.date; // z.B. "2026-04-25"

    if (dateParam) {
      // ── Vergangenheits-Abfrage: nur Bestellungen dieses Tages ──
      // Deutschland = UTC+2 (CEST) / UTC+1 (CET)
      // Server läuft in UTC → 2h abziehen damit der volle deutsche Tag abgedeckt ist
      const from = new Date(dateParam + 'T00:00:00+02:00');
      const to   = new Date(dateParam + 'T23:59:59+02:00');
      const orders = await Order.find({
        status:    { $nin: ['pending', 'awaiting_payment'] },
        createdAt: { $gte: from, $lte: to }
      }).sort({ createdAt: -1 });
      const valid = orders.filter(o => o.status !== 'cancelled');
      return res.json({
        orders,
        stats: {
          todayCount:   orders.length,
          todayRevenue: valid.reduce((s,o) => s+(o.total||0), 0),
          active:       orders.filter(o=>['confirmed','preparing'].includes(o.status)).length,
          done:         orders.filter(o=>['ready','delivered'].includes(o.status)).length,
          cancelled:    orders.filter(o=>o.status==='cancelled').length,
          unpaid:       orders.filter(o=>o.paymentStatus!=='paid'&&o.status!=='cancelled').length,
        }
      });
    }

    // ── Normalfall: heutige + laufende Bestellungen ──
    const orders  = await Order.find({ status:{ $nin:['pending'] } }).sort({ createdAt:-1 }).limit(300);
    const pending = await Order.find({ status:'pending' }).sort({ createdAt:1 });
    const today   = new Date(); today.setHours(0,0,0,0);
    const tod     = orders.filter(o => new Date(o.createdAt) >= today && o.status !== 'awaiting_payment');
    res.json({
      orders, pending,
      stats: {
        todayCount:   tod.length,
        todayRevenue: tod.filter(o=>o.status!=='cancelled').reduce((s,o)=>s+(o.total||0),0),
        totalRevenue: orders.reduce((s,o)=>s+(o.total||0),0),
        active:       orders.filter(o=>['confirmed','preparing'].includes(o.status)).length,
        done:         tod.filter(o=>['ready','delivered'].includes(o.status)).length,
        cancelled:    tod.filter(o=>o.status==='cancelled').length,
        unpaid:       orders.filter(o=>o.paymentStatus!=='paid'&&o.status!=='cancelled'&&o.status!=='awaiting_payment').length,
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

const cleanName = n => n.replace(/[A-Z0-9](,[A-Z0-9])+$/, '').trimEnd();

async function sendCouponRaffleEmail(order) {
  if (!order.coupon || order.coupon.toUpperCase() !== 'ROLLNCONE') return;
  const now = new Date();
  const start = new Date('2026-05-19T00:00:00+02:00');
  const end   = new Date('2026-06-02T23:59:59+02:00');
  if (now < start || now > end) return;
  if (!order.customer?.email) return;
  const resend = getResend();
  if (!resend) return;

  const firstName = (order.customer.first || 'Kunde');
  const email = order.customer.email;
  const now = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fff9f5;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:580px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <div style="background:linear-gradient(135deg,#ff6b35 0%,#ff4b8b 50%,#a855f7 100%);padding:40px 30px;text-align:center;">
    <div style="font-size:52px;margin-bottom:8px;">🍦</div>
    <h1 style="color:#fff;margin:0;font-size:28px;font-weight:900;letter-spacing:-0.5px;">Roll N Cone</h1>
    <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px;letter-spacing:1px;text-transform:uppercase;">× Pizzeria Amoura</p>
  </div>
  <div style="background:#fff3e0;padding:18px 30px;text-align:center;border-bottom:2px dashed #ffcc80;">
    <p style="margin:0;font-size:22px;font-weight:900;color:#e65100;">🎉 Du bist dabei!</p>
    <p style="margin:4px 0 0;font-size:14px;color:#bf360c;">Deine Teilnahme an der Verlosung wurde erfolgreich registriert.</p>
  </div>
  <div style="padding:30px 30px 20px;">
    <p style="font-size:16px;color:#333;margin:0 0 16px;">Hallo <strong>${firstName}</strong>,</p>
    <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">
      mit deiner Bestellung bei <strong>Pizzeria Amoura</strong> und dem Code <strong style="color:#ff4b8b;font-size:16px;letter-spacing:2px;">ROLLNCONE</strong> hast du erfolgreich an unserer Kooperations-Verlosung mit <strong>Roll N Cone</strong> teilgenommen.
    </p>
    <div style="background:linear-gradient(135deg,#fff0fb,#fff8f0);border:2px solid #ffd6f0;border-radius:14px;padding:22px;text-align:center;margin-bottom:22px;">
      <p style="margin:0 0 8px;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px;">Du kannst gewinnen</p>
      <p style="margin:0;font-size:22px;font-weight:900;color:#a855f7;">🍦 Kostenloses Roll N Cone Erlebnis</p>
      <p style="margin:8px 0 0;font-size:13px;color:#666;">Inkl. deiner Lieblings-Kreation nach Wahl</p>
    </div>
    <div style="background:#f9f9f9;border-radius:10px;padding:16px 20px;margin-bottom:22px;">
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#333;">📋 Deine Teilnahme im Überblick</p>
      <table style="width:100%;font-size:13px;color:#555;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#888;">Teilnahmedatum</td><td style="text-align:right;font-weight:600;">${now}</td></tr>
        <tr><td style="padding:4px 0;color:#888;">Bestellung</td><td style="text-align:right;font-weight:600;">#${order.orderNum}</td></tr>
        <tr><td style="padding:4px 0;color:#888;">Code</td><td style="text-align:right;font-weight:600;color:#ff4b8b;">ROLLNCONE</td></tr>
        <tr><td style="padding:4px 0;color:#888;">E-Mail</td><td style="text-align:right;font-weight:600;">${email}</td></tr>
      </table>
    </div>
    <p style="font-size:13px;color:#777;line-height:1.7;margin:0 0 20px;">
      Der Gewinner wird direkt per E-Mail benachrichtigt. Viel Glück! 🍀
    </p>
  </div>
  <div style="background:linear-gradient(135deg,#ff6b35,#ff4b8b);padding:20px 30px;text-align:center;">
    <p style="color:#fff;margin:0 0 6px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Unsere Kooperationspartner</p>
    <p style="color:rgba(255,255,255,0.9);margin:0;font-size:14px;">🍦 Roll N Cone – Frische Eiscreme-Rollen & Waffelkegel</p>
    <a href="https://www.rollncone.de" style="color:#fff;font-size:12px;opacity:0.8;text-decoration:underline;">www.rollncone.de</a>
  </div>
  <div style="background:#f7f3ee;padding:14px 30px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#aaa;">Pizzeria Amoura · Oststraße 48 · 59269 Beckum · Tel: 02521 / 829 06 00</p>
  </div>
</div>
</body>
</html>`;

  try {
    await resend.emails.send({
      from:    process.env.EMAIL_FROM || 'bestellungen@pizzeria-amoura.de',
      to:      email,
      bcc:     'rachmanfalah5@gmail.com',
      subject: '🎉 Du nimmst an der Roll N Cone Verlosung teil! – Pizzeria Amoura',
      html
    });
    console.log(`🎟️ Verlosungs-Mail → ${email} (Bestellung #${order.orderNum})`);
  } catch(e) { console.error('Coupon-Mail Fehler:', e); }
}

async function sendConfirmationEmail(order, mins) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const m    = mins || order.prepTime || (order.mode==='lieferung'?45:20);
  const addr = order.mode==='lieferung'
    ? `${order.customer.street} ${order.customer.house}, ${order.customer.city}`
    : 'Oststraße 48, 59269 Beckum';
  const rows = (order.items||[]).map(i => {
    const extras = (i.extraDetails||[]).map(e => `<div style="font-size:11px;color:#888;padding-left:8px">↳ ${e.name}${e.price>0?' (+'+e.price.toFixed(2).replace('.',',')+'€)':''}</div>`).join('');
    return `<tr><td style="padding:4px 8px;vertical-align:top">${i.qty}×</td><td style="padding:4px 8px">${cleanName(i.name)}${i.note?' <em>('+i.note+')</em>':''}${extras}</td><td style="padding:4px 8px;text-align:right;vertical-align:top">${(i.price*i.qty).toFixed(2).replace('.',',')} €</td></tr>`;
  }).join('');
  try {
    await getResend()?.emails.send({
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
  const items = (order.items||[]).map(i=>{
    const base = `${i.qty}× ${cleanName(i.name)}${i.note?' ('+i.note+')':''}`;
    const extras = (i.extraDetails||[]).map(e=>`   ↳ ${e.name}${e.price>0?' (+'+e.price.toFixed(2)+'€)':''}`).join('\n');
    return extras ? base+'\n'+extras : base;
  }).join('\n');
  try {
    await getResend()?.emails.send({
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
    await getResend()?.emails.send({
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

// ─── PDF Layout-Helpers ───────────────────────────────────────────────────
const PDF_M  = 50;
const PDF_W  = 495;
const PDF_PW = 595;
const PDF_FT = 810;
const PDF_SV = 0.99;
const PDF_PR = 0.05;
const pdfFmt = n => n.toFixed(2).replace('.', ',') + ' €';

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
    doc.font('Helvetica').fontSize(7.5).fillColor('rgba(255,255,255,0.72)').text(label, x + 8, top + 8, { width: kW - 12 });
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#fff').text(value, x + 8, top + 22, { width: kW - 12 });
  });
  doc.y = top + 54;
}

function pdfTableRow(doc, cells, shade, bold = false) {
  const top = doc.y;
  if (shade) doc.rect(PDF_M, top, PDF_W, 20).fill('#f5f7fa');
  cells.forEach(([txt, x, w, align]) => {
    const opts = align ? { width: w, align } : { width: w };
    (bold ? doc.font('Helvetica-Bold') : doc.font('Helvetica'))
      .fontSize(9.5).fillColor('#222').text(txt, x, top + 5, opts);
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
      const name = `${o.customer?.first||''} ${o.customer?.last||''}`.trim().substring(0, 28);
      const modeStr = o.mode === 'lieferung' ? 'Lieferung' : 'Abholung';
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
      sub += (o.total||0);
    });
    const sy = doc.y;
    doc.rect(PDF_M, sy, PDF_W, 20).fill(color + '28');
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Summe ${label}:`, PDF_M+8, sy+5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text(pdfFmt(sub), PDF_M+2, sy+5, { width:PDF_W-4, align:'right' });
    doc.y = sy + 20 + 10;
  }
  drawGroup('Barzahlung', '#8b1d1d', orders.filter(o => o.payment === 'bar'));
  drawGroup('Online-Zahlung (Stripe)', '#276749', orders.filter(o => o.payment !== 'bar'));
}

function pdfBarRechnung(doc, barOrders, barStats, zeitraum, rgnr) {
  if (!barOrders.length) return;
  doc.addPage(); doc.y = PDF_M;
  doc.rect(0, 0, PDF_PW, 50).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#fff').text('Bar-Rechnung', PDF_M, 14);
  doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.7)').text(`FlueVate Online-Bestellsystem  ·  ${zeitraum}`, PDF_M, 33);
  doc.y = 62;
  const addrY = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Rechnungssteller:', PDF_M, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Abed Rachman Falah · FlueVate', PDF_M, addrY+12).text('Zur Goldbrede 30, 59269 Beckum', PDF_M, addrY+22);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Rechnungsempfänger:', PDF_M+270, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Pizzeria Amoura', PDF_M+270, addrY+12).text('Oststraße 48, 59269 Beckum', PDF_M+270, addrY+22);
  doc.y = addrY + 38;
  doc.font('Helvetica').fontSize(8.5).fillColor('#888').text(`Zeitraum: ${zeitraum}  ·  Rg.-Nr.: ${rgnr}`, PDF_M, doc.y);
  doc.y += 12;
  const hy = doc.y;
  doc.rect(PDF_M, hy, PDF_W, 16).fill('#fef9e7');
  doc.font('Helvetica').fontSize(7.5).fillColor('#7a5c00').text('ℹ  Nur Barzahlungen – Stripe-Gebühren wurden bereits automatisch beim Checkout einbehalten.', PDF_M+6, hy+4, { width:PDF_W-12 });
  doc.y = hy + 16 + 6;
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M+PDF_W, doc.y).strokeColor('#333').lineWidth(1).stroke(); doc.y += 4;
  const th = doc.y;
  doc.rect(PDF_M, th, PDF_W, 16).fill('#1a1a2e');
  [['#', PDF_M+2, 34, 'left'], ['Datum', PDF_M+38, 40, 'left'], ['Kunde', PDF_M+80, 170, 'left'],
   ['Umsatz', PDF_M+252, 64, 'right'], ['Gebühr', PDF_M+318, 60, 'right'], ['5% Prov', PDF_M+380, 58, 'right'], ['Gesamt', PDF_M+2, PDF_W-4, 'right']
  ].forEach(([h, x, w, a]) => doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff').text(h, x, th+4, { width:w, align:a }));
  doc.y = th + 16;
  barOrders.forEach((o, i) => {
    if (doc.y > PDF_FT - 20) { doc.addPage(); doc.y = PDF_M; }
    const sf   = o.serviceFee || PDF_SV;
    const prov = (o.total - sf) * PDF_PR;
    const ges  = sf + prov;
    const date = new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) + '.';
    const name = `${o.customer?.first||''} ${o.customer?.last||''}`.trim().substring(0, 24);
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
  doc.font('Helvetica').fontSize(9).fillColor('#333').text('Servicegebühren', PDF_M+8, s1y+5).text(`${barOrders.length} × ${pdfFmt(PDF_SV)}`, PDF_M+200, s1y+5, { width:140, align:'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#222').text(pdfFmt(barStats.barSvc), PDF_M+2, s1y+5, { width:PDF_W-4, align:'right' });
  doc.y = s1y + 18;
  const s2y = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor('#333').text('Systemprovision (5 %)', PDF_M+8, s2y+5).text(`5 % von ${pdfFmt(barStats.barNetto)}`, PDF_M+200, s2y+5, { width:140, align:'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#222').text(pdfFmt(barStats.barProv), PDF_M+2, s2y+5, { width:PDF_W-4, align:'right' });
  doc.y = s2y + 18 + 4;
  const gy = doc.y;
  doc.rect(PDF_M, gy, PDF_W, 30).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff').text('RECHNUNGSBETRAG (netto)', PDF_M+10, gy+9, { width:PDF_W*0.6 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffd700').text(pdfFmt(barStats.barBetrag), PDF_M+2, gy+8, { width:PDF_W-4, align:'right' });
  doc.y = gy + 30 + 8;
  const uy = doc.y;
  doc.rect(PDF_M, uy, PDF_W, 14).fill('#fef9e7');
  doc.font('Helvetica').fontSize(7.5).fillColor('#7a5c00').text('Gemäß § 19 UStG wird keine Umsatzsteuer ausgewiesen (Kleinunternehmerregelung).', PDF_M+6, uy+3, { width:PDF_W-12 });
  doc.y = uy + 14;
}

// Rechnungsnummer fortlaufend in MongoDB speichern
async function getNextRechnungNum() {
  const c = await Counter.findByIdAndUpdate('rechnungNum', { $inc: { seq: 1 } }, { new: true, upsert: true });
  const year = new Date().getFullYear();
  return `RE-${year}-${String(c.seq).padStart(4,'0')}`;
}

// TAGESBERICHT (täglich um 22:00 Uhr)
cron.schedule('0 22 * * *', async () => {
  try {
    const now   = new Date();
    const start = new Date(now); start.setHours(0,0,0,0);
    const end   = new Date(now); end.setHours(23,59,59,999);
    const label = now.toLocaleDateString('de-DE', { weekday:'long', day:'2-digit', month:'2-digit', year:'numeric' });

    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: { $nin: ['cancelled','awaiting_payment'] }
    }).sort({ orderNum: 1 });

    if (orders.length === 0) {
      console.log('[Tagesbericht] Keine Bestellungen heute – kein PDF versendet.');
      return;
    }

    const total      = orders.reduce((s,o) => s + (o.total||0), 0);
    const totalBar   = orders.filter(o=>o.payment==='bar').reduce((s,o)=>s+(o.total||0),0);
    const totalStripe= orders.filter(o=>o.payment==='stripe').reduce((s,o)=>s+(o.total||0),0);
    const nLief      = orders.filter(o=>o.mode==='lieferung').length;
    const nAbh       = orders.filter(o=>o.mode==='abholung').length;

    const tagespdf = await generatePdf(doc => {
      const W = 495;
      const fmt = n => n.toFixed(2).replace('.',',')+' €';

      // Header
      doc.rect(0,0,595,70).fill('#8b1d1d');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('Tagesbericht', 50, 16);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.8)')
        .text(`Pizzeria Amoura  ·  ${label}`, 50, 44);

      doc.moveDown(3.5);

      // Zusammenfassung
      const sumRows = [
        ['Bestellungen gesamt', `${orders.length}`, false],
        ['davon Lieferung', `${nLief}`, true],
        ['davon Abholung', `${nAbh}`, false],
        ['Umsatz Barzahlung', fmt(totalBar), true],
        ['Umsatz Kreditkarte (Stripe)', fmt(totalStripe), false],
      ];
      sumRows.forEach(([label, val, shade]) => {
        const y = doc.y;
        if (shade) doc.rect(50,y,W,26).fill('#f5f5f5');
        doc.font('Helvetica').fontSize(11).fillColor('#222').text(label, 58, y+7);
        doc.text(val, 50, y+7, { width: W-8, align:'right' });
        doc.y = y+26;
      });

      // Gesamtumsatz
      const ty = doc.y;
      doc.rect(50,ty,W,36).fill('#8b1d1d');
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#fff')
        .text('GESAMTUMSATZ', 58, ty+11);
      doc.text(fmt(total), 50, ty+11, { width:W-8, align:'right' });
      doc.y = ty+50;

      doc.moveDown(1);

      // Bestelldetails
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#8b1d1d').text('Alle Bestellungen');
      doc.moveDown(0.4);

      orders.forEach((o, i) => {
        if (doc.y > 730) doc.addPage();
        const rowY = doc.y;
        const shade = i % 2 === 0;
        if (shade) doc.rect(50,rowY,W,0).fill('#f9f9f9');

        const kunde    = `${o.customer?.first||''} ${o.customer?.last||''}`.trim() || '–';
        const telefon  = o.customer?.phone || '–';
        const email    = o.customer?.email || '–';
        const adresse  = o.mode==='lieferung'
          ? `${o.customer?.street||''} ${o.customer?.house||''}, ${o.customer?.city||''}`.trim()
          : 'Abholung';
        const zahlung  = o.payment==='stripe'?'Kreditkarte':o.payment==='karte'?'EC-Karte':'Bar';
        const bezahlt  = o.paymentStatus==='paid'?'✓ Bezahlt':'✗ Offen';
        const items    = (o.items||[]).map(it=>{
          const extras = (it.extraDetails||[]).map(e=>e.name).filter(Boolean).join(', ');
          return `${it.qty}× ${cleanName(it.name)}${extras?' ['+extras+']':''}${it.note?' ('+it.note+')':''}`;
        }).join(', ');

        // Trennlinie
        doc.rect(50, rowY, W, 0.5).fill('#e0e0e0');

        doc.font('Helvetica-Bold').fontSize(10).fillColor('#8b1d1d')
          .text(`#${o.orderNum}  ${new Date(o.createdAt).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}  ${o.mode==='lieferung'?'LIEFERUNG':'ABHOLUNG'}`, 50, rowY+6, { width: W/2 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#222')
          .text(fmt(o.total||0), 50, rowY+6, { width:W, align:'right' });

        doc.font('Helvetica').fontSize(9).fillColor('#333')
          .text(`Kunde: ${kunde}  |  Tel: ${telefon}  |  ${email}`, 50, rowY+20, { width: W });
        doc.text(`Adresse: ${adresse}  |  Zahlung: ${zahlung}  |  ${bezahlt}`, 50, rowY+32, { width: W });
        doc.text(`Artikel: ${items}`, 50, rowY+44, { width: W });

        doc.y = rowY + 60;
      });

      // Footer
      doc.fontSize(8).fillColor('#aaa')
        .text(`Pizzeria Amoura  ·  Tagesbericht ${label}  ·  Erstellt: ${now.toLocaleTimeString('de-DE')}`, 50, 790, { width: W, align:'center' });
    });

    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzeria-amoura.de',
        to: process.env.RESTAURANT_EMAIL,
        subject: `📋 Tagesbericht ${label} · Pizzeria Amoura`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
          <div style="background:#8b1d1d;padding:22px 28px;color:#fff">
            <h2 style="margin:0;font-size:20px">Tagesbericht</h2>
            <p style="margin:4px 0 0;opacity:.8;font-size:13px">${label}</p>
          </div>
          <div style="padding:24px 28px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
              <tr><td style="padding:8px">davon Lieferung</td><td style="padding:8px;text-align:right">${nLief}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:8px">davon Abholung</td><td style="padding:8px;text-align:right">${nAbh}</td></tr>
              <tr><td style="padding:8px">Umsatz Barzahlung</td><td style="padding:8px;text-align:right">${totalBar.toFixed(2).replace('.',',')} €</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:8px">Umsatz Kreditkarte (Stripe)</td><td style="padding:8px;text-align:right">${totalStripe.toFixed(2).replace('.',',')} €</td></tr>
              <tr style="background:#8b1d1d"><td style="padding:10px;font-weight:bold;color:#fff;font-size:15px">Gesamtumsatz</td><td style="padding:10px;text-align:right;font-weight:bold;color:#fff;font-size:15px">${total.toFixed(2).replace('.',',')} €</td></tr>
            </table>
            <p style="font-size:12px;color:#888;margin-top:12px">Die vollständige Bestellliste mit Kundendaten finden Sie im beigefügten PDF.</p>
          </div>
        </div>`,
        attachments: [{ filename: `Tagesbericht_${now.toISOString().slice(0,10)}.pdf`, content: tagespdf.toString('base64') }]
      });
    }
    console.log(`📋 Tagesbericht versendet: ${orders.length} Bestellungen, ${total.toFixed(2)} €`);
  } catch(e) { console.error('Tagesbericht Fehler:', e); }
});

cron.schedule('0 22 * * 0', async () => {
  try {
    const now      = new Date();
    const wStart   = new Date(now); wStart.setDate(now.getDate()-6); wStart.setHours(0,0,0,0);
    const wEnd     = new Date(now); wEnd.setHours(23,59,59,999);
    const kw       = getWeekNum(now);
    const datum    = now.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
    const vonBis   = `${wStart.toLocaleDateString('de-DE')} – ${datum}`;

    const orders = await Order.find({
      status: { $in: ['confirmed','preparing','ready','delivered'] },
      createdAt: { $gte: wStart, $lte: wEnd }
    });

    const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
    const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
    const nettoBase  = brutto - svcFees;
    const provision  = nettoBase * PDF_PR;
    const meinBetrag = svcFees + provision;
    const auszahlung = brutto - meinBetrag;
    const barOrders  = orders.filter(o => o.payment === 'bar');
    const barSvc     = barOrders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
    const barNetto   = barOrders.reduce((s,o) => s+(o.total||0), 0) - barSvc;
    const barProv    = barNetto * PDF_PR;
    const barBetrag  = barSvc + barProv;

    const rechnungNr = await getNextRechnungNum();

    // ── PDF 1: FlueVate Rechnung (geht an Owner) ──────────────────
    const rechnungPdf = await generatePdf(doc => {
      const W = 495; // content width
      // Header
      doc.rect(0, 0, 595, 70).fill('#1a1a2e');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('Abed Rachman Falah', 50, 20);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.7)').text('Online-Bestellsystem · Abrechnung', 50, 46);

      // Invoice title
      doc.moveDown(3).fontSize(16).font('Helvetica-Bold').fillColor('#1a1a2e').text(`RECHNUNG ${rechnungNr}`);
      doc.fontSize(10).font('Helvetica').fillColor('#666').text(`KW ${kw} / ${now.getFullYear()}  ·  ${vonBis}`);
      doc.moveDown(1.5);

      // Addresses side by side
      const addrY = doc.y;
      doc.fontSize(8).fillColor('#999').text('RECHNUNGSSTELLER', 50, addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Abed Rachman Falah', 50, addrY + 14);
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
        .text(`Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  ${rechnungNr} · KW ${kw}/${now.getFullYear()}`, 50, 780, { width: W, align: 'center' });
    });

    // ── PDF 2: Wochenbericht Pizzeria Amoura ──────────────────────
    const berichtPdf = await generatePdf(doc => {
      pdfColorBox(doc, `Wochenbericht KW ${kw} / ${now.getFullYear()}`, `Pizzeria Amoura  ·  ${vonBis}`, '#8b1d1d');
      pdfKacheln(doc, [
        ['Bestellungen gesamt', `${orders.length}`,                              '#1a1a2e'],
        ['Davon Bar',           `${barOrders.length}`,                           '#2c5282'],
        ['Davon Stripe',        `${orders.filter(o=>o.payment!=='bar').length}`, '#276749'],
        ['Brutto-Umsatz',       pdfFmt(brutto),                                  '#744210'],
      ]);
      doc.moveDown(0.4);
      pdfHr(doc);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ABRECHNUNG', PDF_M, doc.y);
      doc.y += 14;
      pdfTableRow(doc, [[`Servicegebühren  (${pdfFmt(PDF_SV)} × ${orders.length})`, PDF_M+8, PDF_W-80, 'left'], [pdfFmt(svcFees),    PDF_M+2, PDF_W-4, 'right']], false);
      pdfTableRow(doc, [[`Systemprovision  (5 % auf ${pdfFmt(nettoBase)})`,          PDF_M+8, PDF_W-80, 'left'], [pdfFmt(provision),  PDF_M+2, PDF_W-4, 'right']], true);
      pdfTableRow(doc, [['Mein Gesamtbetrag',                                        PDF_M+8, PDF_W-80, 'left'], [pdfFmt(meinBetrag), PDF_M+2, PDF_W-4, 'right']], false, true);
      doc.y += 4;
      const ay = doc.y;
      doc.rect(PDF_M, ay, PDF_W, 28).fill('#e8f5e9');
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#2e7d32').text('Auszahlung an Pizzeria Amoura', PDF_M+10, ay+8, { width: PDF_W*0.65 });
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#2e7d32').text(pdfFmt(auszahlung), PDF_M+2, ay+8, { width: PDF_W-4, align: 'right' });
      doc.y = ay + 28 + 12;
      pdfHr(doc, '#bbb');
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('KUNDENLISTE', PDF_M, doc.y);
      doc.y += 12;
      pdfKundenliste(doc, orders);
      if (barOrders.length > 0) {
        pdfBarRechnung(doc, barOrders, { barSvc, barNetto, barProv, barBetrag }, vonBis, `${rechnungNr}-BAR`);
      }
      doc.font('Helvetica').fontSize(7).fillColor('#bbb')
        .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  Wochenbericht KW ${kw} / ${now.getFullYear()}`, PDF_M, 820, { width: PDF_W, align: 'center' });
    });

    // ── E-Mail 1: Restaurant bekommt Wochenbericht als PDF-Anhang ────────
    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzeria-amoura.de',
        to: process.env.RESTAURANT_EMAIL,
        subject: `📊 Wochenbericht KW ${kw} / ${now.getFullYear()} · Pizzeria Amoura`,
        html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#222">
  <div style="background:#8b1d1d;padding:24px 28px;color:#fff">
    <h2 style="margin:0;font-size:20px">Wochenbericht KW ${kw} / ${now.getFullYear()}</h2>
    <p style="margin:4px 0 0;opacity:.8;font-size:13px">${vonBis}</p>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
      <tr><td style="padding:8px">Gesamtumsatz (Brutto)</td><td style="padding:8px;text-align:right">${brutto.toFixed(2).replace('.',',')} €</td></tr>
      <tr style="background:#f5f5f5"><td style="padding:8px">Einbehaltene Gebühren (A. R. Falah)</td><td style="padding:8px;text-align:right">− ${meinBetrag.toFixed(2).replace('.',',')} €</td></tr>
      <tr style="background:#e8f5e9"><td style="padding:10px;font-weight:bold;color:#2e7d32;font-size:15px">Ihr Auszahlungsbetrag</td><td style="padding:10px;text-align:right;font-weight:bold;color:#2e7d32;font-size:15px">${auszahlung.toFixed(2).replace('.',',')} €</td></tr>
    </table>
    <p style="font-size:11px;color:#aaa;margin-top:8px">Anbei der Wochenbericht mit Kundenliste${barOrders.length > 0 ? ' und Bar-Rechnung' : ''}.</p>
  </div>
</div>`,
        attachments: [{ filename: `KW${kw}_${now.getFullYear()}_Amoura_Wochenbericht.pdf`, content: berichtPdf.toString('base64') }],
      });
    }

    // ── E-Mail 2: Owner bekommt beide PDFs als Anhang ─────────────
    if (process.env.OWNER_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzeria-amoura.de',
        to: process.env.OWNER_EMAIL,
        subject: `🧾 ${rechnungNr} + Wochenbericht KW ${kw} · Pizzeria Amoura`,
        html: `<p style="font-family:Arial,sans-serif;color:#555">Anbei die Rechnung <b>${rechnungNr}</b> sowie der Wochenbericht KW ${kw} / ${now.getFullYear()} für Pizzeria Amoura.</p>
               <p style="font-family:Arial,sans-serif;color:#555"><b>Zeitraum:</b> ${vonBis}<br><b>Dein Verdienst:</b> ${meinBetrag.toFixed(2).replace('.',',')} €</p>`,
        attachments: [
          { filename: `${rechnungNr}_ARF_Rechnung.pdf`, content: rechnungPdf.toString('base64') },
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

// MONATSBERICHT (Cron – täglich 22:00, nur am letzten Tag des Monats)
// ═══════════════════════════════════════════════════════════════════
cron.schedule('0 22 * * *', async () => {
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

    // ── Wochenübersicht berechnen ─────────────────────────────────
    const weeksMap = {};
    orders.forEach(o => {
      const kw2 = getWeekNum(new Date(o.createdAt));
      if (!weeksMap[kw2]) weeksMap[kw2] = { n: 0, brutto: 0 };
      weeksMap[kw2].n++;
      weeksMap[kw2].brutto += o.total || 0;
    });
    const weekRows = Object.entries(weeksMap).sort((a, b) => +a[0] - +b[0]);

    // ── PDF 1: Monatsbericht (Kennzahlen + Kundenliste + Bar-Rechnung) ─────
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
      pdfTableRow(doc, [[`Servicegebühren  (${pdfFmt(PDF_SV)} × ${orders.length})`, PDF_M+8, PDF_W-80, 'left'], [pdfFmt(svcFees),    PDF_M+2, PDF_W-4, 'right']], false);
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
          [`KW ${kw2}`,           PDF_M+8, 70,       'left'],
          [`${d.n} Bestellungen`, PDF_M+8, PDF_W-80, 'left'],
          [pdfFmt(d.brutto),      PDF_M+2, PDF_W-4,  'right'],
        ], i % 2 === 1);
      });
      doc.y += 8;
      pdfHr(doc, '#bbb');
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('KUNDENLISTE', PDF_M, doc.y);
      doc.y += 12;
      pdfKundenliste(doc, orders);
      if (barOrdersM.length > 0) {
        pdfBarRechnung(doc, barOrdersM, { barSvc: barSvcM, barNetto: barNettoM, barProv: barProvM, barBetrag: barBetragM }, vonBis, `${rechnungNr}-BAR`);
      }
      doc.font('Helvetica').fontSize(7).fillColor('#bbb')
        .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  Monatsbericht ${monat}`, PDF_M, 820, { width: PDF_W, align: 'center' });
    });

    // ── PDF 2: FlueVate Rechnung (nur für Owner) ──────────────────────────
    const monatRechnungPdf = await generatePdf(doc => {
      const W = 495;
      doc.rect(0, 0, 595, 70).fill('#1a1a2e');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('Abed Rachman Falah', 50, 20);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.7)').text('Online-Bestellsystem · Monatsabrechnung', 50, 46);
      doc.moveDown(3).fontSize(16).font('Helvetica-Bold').fillColor('#1a1a2e').text(`RECHNUNG ${rechnungNr}`);
      doc.fontSize(10).font('Helvetica').fillColor('#666').text(`${monat}  ·  ${vonBis}`);
      doc.moveDown(1.5);
      const addrY = doc.y;
      doc.fontSize(8).fillColor('#999').text('RECHNUNGSSTELLER', 50, addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Abed Rachman Falah', 50, addrY+14);
      doc.fontSize(10).font('Helvetica').fillColor('#555').text('Zur Goldbrede 30', 50, addrY+30).text('59269 Beckum', 50, addrY+44);
      if (process.env.STEUERNUMMER) doc.text(`St.-Nr.: ${process.env.STEUERNUMMER}`, 50, addrY+58);
      doc.fontSize(8).fillColor('#999').text('RECHNUNGSEMPFÄNGER', 310, addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Pizzeria Amoura', 310, addrY+14);
      doc.fontSize(10).font('Helvetica').fillColor('#555').text('Oststraße 48', 310, addrY+30).text('59269 Beckum', 310, addrY+44);
      doc.y = addrY + 80;
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(1).stroke(); doc.moveDown(0.8);
      doc.fontSize(9).fillColor('#555').text(`Rechnungsnummer: ${rechnungNr}`, 50, doc.y, { continued:true }).text(`Datum: ${datum}`, { align:'right' });
      doc.text(`Leistungszeitraum: ${vonBis}`, 50); doc.moveDown(1);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#222').lineWidth(1.5).stroke(); doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Leistung', 50, doc.y).text('Betrag', 50, doc.y-14, { width:W, align:'right' });
      doc.moveDown(0.5); doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke(); doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Servicegebühren Online-Bestellsystem', 50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`${pdfFmt(PDF_SV)} × ${orders.length} Bestellungen (${monat})`);
      const sfY = doc.y - 32;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${svcFees.toFixed(2).replace('.',',')} €`, 50, sfY, { width:W, align:'right' });
      doc.moveDown(0.8); doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#eee').lineWidth(0.5).stroke(); doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Systemprovision (5 % auf Speisenumsatz)', 50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`5 % von ${nettoBase.toFixed(2).replace('.',',')} € Speisenumsatz`);
      const pvY = doc.y - 32;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${provision.toFixed(2).replace('.',',')} €`, 50, pvY, { width:W, align:'right' });
      doc.moveDown(0.8); doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#222').lineWidth(1.5).stroke(); doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1a2e').text('RECHNUNGSBETRAG (netto)', 50);
      const totY = doc.y - 18;
      doc.text(`${meinBetrag.toFixed(2).replace('.',',')} €`, 50, totY, { width:W, align:'right' });
      doc.moveDown(1.5);
      const noteY = doc.y;
      doc.rect(50, noteY, W, 26).fill('#fff8e1');
      doc.fontSize(9).font('Helvetica').fillColor('#7a5c00').text('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).', 56, noteY+4);
      doc.fontSize(8).fillColor('#aaa').text(`Abed Rachman Falah · ${rechnungNr} · ${monat}`, 50, 780, { width:W, align:'center' });
    });

    // ── E-Mail: Restaurant ────────────────────────────────────────────────
    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzeria-amoura.de',
        to:   process.env.RESTAURANT_EMAIL,
        subject: `📅 Monatsbericht ${monat} · Pizzeria Amoura`,
        html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#222">
  <div style="background:#8b1d1d;padding:24px 28px;color:#fff">
    <h2 style="margin:0;font-size:20px">Monatsbericht ${monat}</h2>
    <p style="margin:4px 0 0;opacity:.8;font-size:13px">${vonBis}</p>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
      <tr><td style="padding:8px">Gesamtumsatz (Brutto)</td><td style="padding:8px;text-align:right">${brutto.toFixed(2).replace('.',',')} €</td></tr>
      <tr style="background:#f5f5f5"><td style="padding:8px">Einbehaltene Gebühren (A. R. Falah)</td><td style="padding:8px;text-align:right">− ${meinBetrag.toFixed(2).replace('.',',')} €</td></tr>
      <tr style="background:#e8f5e9"><td style="padding:10px;font-weight:bold;color:#2e7d32;font-size:15px">Ihr Auszahlungsbetrag</td><td style="padding:10px;text-align:right;font-weight:bold;color:#2e7d32;font-size:15px">${auszahlung.toFixed(2).replace('.',',')} €</td></tr>
    </table>
    <p style="font-size:11px;color:#aaa;margin-top:8px">Anbei der Monatsbericht mit Kundenliste${barOrdersM.length > 0 ? ' und Bar-Rechnung' : ''}.</p>
  </div>
</div>`,
        attachments: [{ filename: `${monat.replace(' ','_')}_Amoura_Monatsbericht.pdf`, content: monatsPdf.toString('base64') }],
      });
    }

    // ── E-Mail: Owner ─────────────────────────────────────────────────────
    if (process.env.OWNER_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzeria-amoura.de',
        to: process.env.OWNER_EMAIL,
        subject: `🧾 ${rechnungNr} + Monatsbericht ${monat} · Pizzeria Amoura`,
        html: `<p style="font-family:Arial,sans-serif;color:#555">Anbei Rechnung <b>${rechnungNr}</b> und Monatsbericht <b>${monat}</b> für Pizzeria Amoura.</p>
               <p style="font-family:Arial,sans-serif;color:#555"><b>Zeitraum:</b> ${vonBis}<br><b>Verdienst:</b> ${meinBetrag.toFixed(2).replace('.',',')} €${barOrdersM.length > 0 ? `<br><b>Bar-Rechnung:</b> ${barBetragM.toFixed(2).replace('.',',')} € (${barOrdersM.length} Barzahlungen)` : ''}</p>`,
        attachments: [
          { filename: `${rechnungNr}_ARF_Monatsrechnung_${monat.replace(' ','_')}.pdf`, content: monatRechnungPdf.toString('base64') },
          { filename: `${monat.replace(' ','_')}_Amoura_Monatsbericht.pdf`,              content: monatsPdf.toString('base64') },
        ],
      });
    }
    console.log(`📅 Monatsbericht ${monat} + Rechnung ${rechnungNr} versendet`);
  } catch(e) { console.error('Monatsbericht Fehler:', e); }
});

// ── Monatsbericht manuell triggern ───────────────────────────────
// POST /api/admin/send-monthly?month=2026-05  (oder leer = aktueller Monat)
app.post('/api/admin/send-monthly', auth, async (req, res) => {
  try {
    const monthParam = req.query.month; // z.B. "2026-05"
    let refDate;
    if (monthParam) {
      const [y, m] = monthParam.split('-').map(Number);
      refDate = new Date(y, m - 1, 28, 22, 0, 0); // letzter Tag des Monats
    } else {
      refDate = new Date();
    }
    const now    = refDate;
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const mEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const monat  = now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    const datum  = mEnd.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
    const vonBis = `${mStart.toLocaleDateString('de-DE')} – ${datum}`;
    const rechnungNr = await getNextRechnungNum();

    const orders = await Order.find({
      status: { $in: ['confirmed','preparing','ready','delivered'] },
      createdAt: { $gte: mStart, $lte: mEnd }
    });

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
    const weeksMap = {};
    orders.forEach(o => { const kw2=getWeekNum(new Date(o.createdAt)); if(!weeksMap[kw2])weeksMap[kw2]={n:0,brutto:0}; weeksMap[kw2].n++; weeksMap[kw2].brutto+=o.total||0; });
    const weekRows = Object.entries(weeksMap).sort((a,b)=>+a[0]-+b[0]);

    const monatsPdf = await generatePdf(doc => {
      pdfColorBox(doc, `Monatsbericht ${monat}`, `Pizzeria Amoura  ·  ${vonBis}`, '#8b1d1d');
      pdfKacheln(doc, [
        ['Bestellungen gesamt',`${orders.length}`,'#1a1a2e'],['Davon Bar',`${barOrdersM.length}`,'#2c5282'],
        ['Davon Stripe',`${orders.filter(o=>o.payment!=='bar').length}`,'#276749'],['Brutto-Umsatz',pdfFmt(brutto),'#744210'],
      ]);
      doc.moveDown(0.4); pdfHr(doc);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ABRECHNUNG',PDF_M,doc.y); doc.y+=14;
      pdfTableRow(doc,[[`Servicegebühren  (${pdfFmt(PDF_SV)} × ${orders.length})`,PDF_M+8,PDF_W-80,'left'],[pdfFmt(svcFees),PDF_M+2,PDF_W-4,'right']],false);
      pdfTableRow(doc,[[`Systemprovision  (5 % auf ${pdfFmt(nettoBase)})`,PDF_M+8,PDF_W-80,'left'],[pdfFmt(provision),PDF_M+2,PDF_W-4,'right']],true);
      pdfTableRow(doc,[['Mein Gesamtbetrag',PDF_M+8,PDF_W-80,'left'],[pdfFmt(meinBetrag),PDF_M+2,PDF_W-4,'right']],false,true);
      doc.y+=4;
      const ay=doc.y; doc.rect(PDF_M,ay,PDF_W,28).fill('#e8f5e9');
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#2e7d32').text('Auszahlung an Pizzeria Amoura',PDF_M+10,ay+8,{width:PDF_W*0.65});
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#2e7d32').text(pdfFmt(auszahlung),PDF_M+2,ay+8,{width:PDF_W-4,align:'right'});
      doc.y=ay+28+16; pdfHr(doc,'#bbb');
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('WOCHENÜBERSICHT',PDF_M,doc.y); doc.y+=14;
      weekRows.forEach(([kw2,d],i)=>{ pdfTableRow(doc,[[`KW ${kw2}`,PDF_M+8,70,'left'],[`${d.n} Bestellungen`,PDF_M+8,PDF_W-80,'left'],[pdfFmt(d.brutto),PDF_M+2,PDF_W-4,'right']],i%2===1); });
      doc.y+=8; pdfHr(doc,'#bbb');
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('KUNDENLISTE',PDF_M,doc.y); doc.y+=12;
      pdfKundenliste(doc,orders);
      if(barOrdersM.length>0) pdfBarRechnung(doc,barOrdersM,{barSvc:barSvcM,barNetto:barNettoM,barProv:barProvM,barBetrag:barBetragM},vonBis,`${rechnungNr}-BAR`);
      doc.font('Helvetica').fontSize(7).fillColor('#bbb').text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  Monatsbericht ${monat}`,PDF_M,820,{width:PDF_W,align:'center'});
    });

    const monatRechnungPdf = await generatePdf(doc => {
      const W=495;
      doc.rect(0,0,595,70).fill('#1a1a2e');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('Abed Rachman Falah',50,20);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.7)').text('Online-Bestellsystem · Monatsabrechnung',50,46);
      doc.moveDown(3).fontSize(16).font('Helvetica-Bold').fillColor('#1a1a2e').text(`RECHNUNG ${rechnungNr}`);
      doc.fontSize(10).font('Helvetica').fillColor('#666').text(`${monat}  ·  ${vonBis}`);
      doc.moveDown(1.5);
      const addrY=doc.y;
      doc.fontSize(8).fillColor('#999').text('RECHNUNGSSTELLER',50,addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Abed Rachman Falah',50,addrY+14);
      doc.fontSize(10).font('Helvetica').fillColor('#555').text('Zur Goldbrede 30',50,addrY+30).text('59269 Beckum',50,addrY+44);
      if(process.env.STEUERNUMMER) doc.text(`St.-Nr.: ${process.env.STEUERNUMMER}`,50,addrY+58);
      doc.fontSize(8).fillColor('#999').text('RECHNUNGSEMPFÄNGER',310,addrY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Pizzeria Amoura',310,addrY+14);
      doc.fontSize(10).font('Helvetica').fillColor('#555').text('Oststraße 48',310,addrY+30).text('59269 Beckum',310,addrY+44);
      doc.y=addrY+80;
      doc.moveTo(50,doc.y).lineTo(545,doc.y).strokeColor('#ddd').lineWidth(1).stroke(); doc.moveDown(0.8);
      doc.fontSize(9).fillColor('#555').text(`Rechnungsnummer: ${rechnungNr}`,50,doc.y,{continued:true}).text(`Datum: ${datum}`,{align:'right'});
      doc.text(`Leistungszeitraum: ${vonBis}`,50); doc.moveDown(1);
      doc.moveTo(50,doc.y).lineTo(545,doc.y).strokeColor('#222').lineWidth(1.5).stroke(); doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#222').text('Leistung',50,doc.y).text('Betrag',50,doc.y-14,{width:W,align:'right'});
      doc.moveDown(0.5); doc.moveTo(50,doc.y).lineTo(545,doc.y).strokeColor('#ddd').lineWidth(0.5).stroke(); doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Servicegebühren Online-Bestellsystem',50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`${pdfFmt(PDF_SV)} × ${orders.length} Bestellungen (${monat})`);
      const sfY=doc.y-32; doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${svcFees.toFixed(2).replace('.',',')} €`,50,sfY,{width:W,align:'right'});
      doc.moveDown(0.8); doc.moveTo(50,doc.y).lineTo(545,doc.y).strokeColor('#eee').lineWidth(0.5).stroke(); doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text('Systemprovision (5 % auf Speisenumsatz)',50);
      doc.font('Helvetica').fontSize(9).fillColor('#888').text(`5 % von ${nettoBase.toFixed(2).replace('.',',')} € Speisenumsatz`);
      const pvY=doc.y-32; doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(`${provision.toFixed(2).replace('.',',')} €`,50,pvY,{width:W,align:'right'});
      doc.moveDown(0.8); doc.moveTo(50,doc.y).lineTo(545,doc.y).strokeColor('#222').lineWidth(1.5).stroke(); doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1a2e').text('RECHNUNGSBETRAG (netto)',50);
      const totY=doc.y-18; doc.text(`${meinBetrag.toFixed(2).replace('.',',')} €`,50,totY,{width:W,align:'right'});
      doc.moveDown(1.5);
      const noteY=doc.y; doc.rect(50,noteY,W,26).fill('#fff8e1');
      doc.fontSize(9).font('Helvetica').fillColor('#7a5c00').text('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).',56,noteY+4);
      doc.fontSize(8).fillColor('#aaa').text(`Abed Rachman Falah · ${rechnungNr} · ${monat}`,50,780,{width:W,align:'center'});
    });

    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzeria-amoura.de',
        to: process.env.RESTAURANT_EMAIL,
        subject: `📅 Monatsbericht ${monat} · Pizzeria Amoura`,
        html: `<p style="font-family:Arial,sans-serif">Manuell ausgelöster Monatsbericht für <b>${monat}</b>.<br>${orders.length} Bestellungen · Auszahlung: ${auszahlung.toFixed(2).replace('.',',')} €</p>`,
        attachments: [{ filename: `${monat.replace(' ','_')}_Amoura_Monatsbericht.pdf`, content: monatsPdf.toString('base64') }],
      });
    }
    if (process.env.OWNER_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzeria-amoura.de',
        to: process.env.OWNER_EMAIL,
        subject: `🧾 ${rechnungNr} + Monatsbericht ${monat} · Pizzeria Amoura`,
        html: `<p style="font-family:Arial,sans-serif;color:#555">Manuell ausgelöst: Rechnung <b>${rechnungNr}</b> und Monatsbericht <b>${monat}</b>.<br><b>Verdienst:</b> ${meinBetrag.toFixed(2).replace('.',',')} €</p>`,
        attachments: [
          { filename: `${rechnungNr}_ARF_Monatsrechnung_${monat.replace(' ','_')}.pdf`, content: monatRechnungPdf.toString('base64') },
          { filename: `${monat.replace(' ','_')}_Amoura_Monatsbericht.pdf`, content: monatsPdf.toString('base64') },
        ],
      });
    }
    console.log(`📅 Monatsbericht ${monat} manuell versendet (${orders.length} Bestellungen)`);
    res.json({
      success: true, monat, orders: orders.length, rechnungNr,
      monatsPdfBase64: monatsPdf.toString('base64'),
      rechnungPdfBase64: monatRechnungPdf.toString('base64'),
    });
  } catch(e) {
    console.error('Monatsbericht manuell Fehler:', e);
    res.status(500).json({ message: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🍕 Pizzeria Amoura Backend · Port ${PORT}`));
