---
name: restaurant-kundenkonto
description: Fügt einem bestehenden Restaurant-Bestellsystem (Express + MongoDB + Mongoose + Stripe) ein vollständiges Kundenkonto-System hinzu. Enthält Register/Login (JWT), Bestellhistorie, Re-Order-Funktion und Profilverwaltung. Nutze diesen Skill wenn der User "Kundenkonto", "Bestellhistorie", "Re-Order", "Login" oder "Kundenportal" im Kontext eines Restaurant-Bestellsystems erwähnt.
---

Dieser Skill implementiert ein vollständiges Kundenkonto-System für Express + MongoDB + Mongoose Restaurant-Backends mit plain HTML/JS Frontend.

## Stack-Kontext

Die bestehenden Projekte nutzen:
- **Backend**: Node.js + Express + Mongoose + Stripe + Resend
- **Auth (Admin)**: Einfacher `ADMIN_TOKEN_SECRET` Bearer-Token
- **Frontend**: Plain HTML/CSS/JS (keine Frameworks)
- **DB**: MongoDB via Mongoose

Der Skill erweitert diesen Stack um **JWT-basierte Kunden-Authentifizierung** ohne bestehenden Code zu brechen.

---

## 1. Abhängigkeiten

```bash
npm install bcryptjs jsonwebtoken
```

Ins `package.json` dependencies eintragen:
```json
"bcryptjs": "^2.4.3",
"jsonwebtoken": "^9.0.2"
```

---

## 2. Umgebungsvariablen (.env)

```env
JWT_SECRET=dein-geheimer-jwt-schluessel-mindestens-32-zeichen
```

---

## 3. MongoDB User Schema

In `server.js` nach den bestehenden Schemas einfügen:

```js
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
```

### Order Schema anpassen

Im bestehenden `orderSchema` das Feld `userId` ergänzen:

```js
userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
```

Das erlaubt Gastbestellungen (null) und verknüpfte Bestellungen gleichzeitig.

---

## 4. Imports & JWT Middleware

Am Anfang von `server.js`:

```js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
```

JWT-Middleware für geschützte Kunden-Routen:

```js
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
```

---

## 5. API Routes (Backend)

Alle Routen unter dem Block `// PUBLIC ROUTES` einfügen:

### POST /api/auth/register

```js
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, first, last, phone } = req.body;
    if (!email || !password || !first || !last) {
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
    res.status(500).json({ message: 'Registrierung fehlgeschlagen' });
  }
});
```

### POST /api/auth/login

```js
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
    res.status(500).json({ message: 'Login fehlgeschlagen' });
  }
});
```

### GET /api/auth/me (Token prüfen)

```js
app.get('/api/auth/me', customerAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User nicht gefunden' });
    res.json(user);
  } catch {
    res.status(500).json({ message: 'Fehler' });
  }
});
```

### PATCH /api/auth/profile (Profil bearbeiten)

```js
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
```

### PATCH /api/auth/password (Passwort ändern)

```js
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
```

### GET /api/account/orders (Bestellhistorie)

```js
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
```

### POST /api/account/reorder (Re-Order)

```js
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
```

### userId bei neuer Bestellung speichern

In der bestehenden `POST /api/orders` Route, nach dem Auflösen des Tokens (optional, Gastbestellung bleibt möglich):

```js
app.post('/api/orders', async (req, res) => {
  try {
    // userId aus JWT extrahieren falls vorhanden
    let userId = null;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
        userId = decoded.id;
      } catch {}  // Gastbestellung – kein Fehler
    }

    const orderNum = await getNextOrderNum();
    const isAdmin = req.body.source === 'admin';
    const order = new Order({
      ...req.body,
      orderNum,
      userId,
      status: isAdmin ? 'confirmed' : 'pending'
    });
    // ... rest bleibt unverändert
```

---

## 6. Frontend: account.html

Eine eigenständige Seite `account.html` erstellen mit drei Zuständen:

### Struktur

```html
<!-- Zustand 1: Login/Register Form (wenn kein Token) -->
<div id="auth-section">
  <!-- Tab: Login | Registrieren -->
</div>

<!-- Zustand 2: Account-Dashboard (wenn eingeloggt) -->
<div id="dashboard-section" style="display:none">
  <!-- Tab: Bestellhistorie | Profil | Passwort -->
</div>
```

### JavaScript-Logik (Grundgerüst)

```js
const API = 'https://dein-backend.railway.app'; // aus Config laden

// Token-Management
function getToken() { return localStorage.getItem('customerToken'); }
function setToken(t) { localStorage.setItem('customerToken', t); }
function clearToken() { localStorage.removeItem('customerToken'); }

// Auth-Header
function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` };
}

// Beim Laden der Seite
async function init() {
  const token = getToken();
  if (!token) return showAuth();
  try {
    const res = await fetch(`${API}/api/auth/me`, { headers: authHeaders() });
    if (!res.ok) throw new Error();
    const user = await res.json();
    showDashboard(user);
  } catch {
    clearToken();
    showAuth();
  }
}

// Login
async function login(email, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message);
  setToken(data.token);
  showDashboard(data.user);
}

// Register
async function register(formData) {
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(formData)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message);
  setToken(data.token);
  showDashboard(data.user);
}

// Bestellhistorie laden
async function loadOrders() {
  const res = await fetch(`${API}/api/account/orders`, { headers: authHeaders() });
  return res.json();
}

// Re-Order → Items in localStorage für Warenkorb
async function reorder(orderId) {
  const res = await fetch(`${API}/api/account/reorder/${orderId}`, {
    method: 'POST', headers: authHeaders()
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message);
  // Items in den Warenkorb (localStorage) schreiben und zur Hauptseite weiterleiten
  localStorage.setItem('cart', JSON.stringify(data.items));
  localStorage.setItem('cartMode', data.mode);
  window.location.href = '/index.html#warenkorb';
}

// Logout
function logout() {
  clearToken();
  showAuth();
}
```

### Bestellhistorie rendern

```js
function renderOrders(orders) {
  if (!orders.length) return '<p>Noch keine Bestellungen.</p>';
  return orders.map(o => `
    <div class="order-card">
      <div class="order-header">
        <span>Bestellung #${o.orderNum}</span>
        <span class="status status-${o.status}">${statusLabel(o.status)}</span>
        <span>${new Date(o.createdAt).toLocaleDateString('de-DE')}</span>
      </div>
      <ul class="order-items">
        ${o.items.map(i => `<li>${i.qty}× ${i.name}</li>`).join('')}
      </ul>
      <div class="order-footer">
        <strong>${o.total?.toFixed(2)} €</strong>
        <button onclick="reorder('${o._id}')">↺ Erneut bestellen</button>
      </div>
    </div>
  `).join('');
}

function statusLabel(s) {
  const map = { pending:'Ausstehend', confirmed:'Bestätigt', preparing:'In Zubereitung',
                ready:'Fertig', delivered:'Geliefert', cancelled:'Storniert' };
  return map[s] || s;
}
```

---

## 7. Warenkorb-Integration (Re-Order)

Im bestehenden `index.html` / Warenkorb-Skript beim Laden prüfen:

```js
// Beim Seitenstart: Re-Order aus Account?
const reorderItems = localStorage.getItem('cart');
if (reorderItems) {
  cart = JSON.parse(reorderItems);
  localStorage.removeItem('cart');
  renderCart();
  // optional: Warenkorb aufklappen
}
```

---

## 8. Integrations-Checkliste

Beim Anwenden auf ein konkretes Restaurant:

- [ ] `bcryptjs` und `jsonwebtoken` installieren
- [ ] `JWT_SECRET` in `.env` und auf dem Server (Railway/Render) setzen
- [ ] `User` Schema und `customerAuth` Middleware in `server.js` einfügen
- [ ] Alle 7 Auth/Account-Routen einfügen
- [ ] `userId`-Logik in `POST /api/orders` integrieren
- [ ] `account.html` erstellen und mit Restaurant-Design anpassen
- [ ] API-URL in `account.html` auf das richtige Backend zeigen
- [ ] Re-Order-Logik mit dem bestehenden Warenkorb-System verknüpfen
- [ ] Link zum Kundenkonto in Navigation der Hauptseite einfügen

---

## Sicherheitshinweise

- Passwörter werden mit bcrypt (12 Runden) gehasht — niemals plain text speichern
- JWT läuft nach 30 Tagen ab — Token wird im `localStorage` gespeichert (für SPA ausreichend)
- `userId` in `/api/account/reorder` immer gegen den eingeloggten User validieren (bereits eingebaut)
- E-Mail wird lowercase+trimmed gespeichert um Duplikate zu vermeiden
- Fehlermedlungen bei Login/Register sind bewusst generisch ("Falsche E-Mail oder Passwort") um User-Enumeration zu verhindern
