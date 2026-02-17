require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'hourfix_secret_2026';

// ── BASE DE DATOS ─────────────────────────────────────────────────────
const db = new Database('./hourfix.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone TEXT,
    category TEXT NOT NULL,
    address TEXT,
    zone TEXT,
    rating REAL DEFAULT 0,
    total_reviews INTEGER DEFAULT 0,
    plan TEXT DEFAULT 'free',
    commission_rate REAL DEFAULT 0.15,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    price REAL NOT NULL,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    status TEXT DEFAULT 'available',
    UNIQUE(business_id, date, time)
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    phone TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    business_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    availability_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    price REAL NOT NULL,
    commission_amount REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    cancellation_charge REAL DEFAULT 0,
    confirmation_code TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER UNIQUE NOT NULL,
    client_id INTEGER NOT NULL,
    business_id INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    comment TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── MIDDLEWARES ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(403).json({ error: 'Token inválido' });
  }
}

function genCode() {
  return 'HF-' + Math.random().toString(36).substr(2, 6).toUpperCase();
}

// ── HEALTH CHECK ──────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'HOURFIX API funcionando ✅', version: '1.0' }));

// ── AUTH EMPRESAS ─────────────────────────────────────────────────────
app.post('/api/auth/business/register', (req, res) => {
  const { name, email, password, phone, category, address, zone } = req.body;
  if (!name || !email || !password || !category)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  if (db.prepare('SELECT id FROM businesses WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Email ya registrado' });

  const result = db.prepare(
    'INSERT INTO businesses (name,email,password,phone,category,address,zone) VALUES (?,?,?,?,?,?,?)'
  ).run(name, email, bcrypt.hashSync(password, 10), phone, category, address, zone);

  const token = jwt.sign({ id: result.lastInsertRowid, type: 'business', name }, JWT_SECRET, { expiresIn: '30d' });
  res.status(201).json({ token, business: { id: result.lastInsertRowid, name, email, category, plan: 'free' } });
});

app.post('/api/auth/business/login', (req, res) => {
  const { email, password } = req.body;
  const biz = db.prepare('SELECT * FROM businesses WHERE email = ?').get(email);
  if (!biz || !bcrypt.compareSync(password, biz.password))
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  const token = jwt.sign({ id: biz.id, type: 'business', name: biz.name }, JWT_SECRET, { expiresIn: '30d' });
  const { password: _, ...bizData } = biz;
  res.json({ token, business: bizData });
});

// ── AUTH CLIENTES ─────────────────────────────────────────────────────
app.post('/api/auth/client/register', (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  if (db.prepare('SELECT id FROM clients WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Email ya registrado' });

  const result = db.prepare(
    'INSERT INTO clients (name,email,password,phone) VALUES (?,?,?,?)'
  ).run(name, email, bcrypt.hashSync(password, 10), phone);

  const token = jwt.sign({ id: result.lastInsertRowid, type: 'client', name }, JWT_SECRET, { expiresIn: '30d' });
  res.status(201).json({ token, client: { id: result.lastInsertRowid, name, email } });
});

app.post('/api/auth/client/login', (req, res) => {
  const { email, password } = req.body;
  const client = db.prepare('SELECT * FROM clients WHERE email = ?').get(email);
  if (!client || !bcrypt.compareSync(password, client.password))
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  const token = jwt.sign({ id: client.id, type: 'client', name: client.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, client: { id: client.id, name: client.name, email: client.email } });
});

// ── NEGOCIOS ──────────────────────────────────────────────────────────
// Buscar (SIN dirección/teléfono)
app.get('/api/businesses', (req, res) => {
  const { category, date, time } = req.query;
  let query = `SELECT b.id, b.name, b.category, b.zone, b.rating, b.total_reviews,
               MIN(s.price) as min_price FROM businesses b
               LEFT JOIN services s ON s.business_id = b.id AND s.active = 1 WHERE 1=1`;
  const params = [];
  if (category) { query += ' AND b.category = ?'; params.push(category); }
  if (date && time) {
    query += ` AND EXISTS (SELECT 1 FROM availability a WHERE a.business_id = b.id
               AND a.date = ? AND a.time = ? AND a.status = 'available')`;
    params.push(date, time);
  }
  query += ' GROUP BY b.id ORDER BY b.rating DESC';
  res.json(db.prepare(query).all(...params));
});

// Detalle negocio (SIN dirección/teléfono)
app.get('/api/businesses/:id', (req, res) => {
  const biz = db.prepare(
    'SELECT id,name,category,zone,rating,total_reviews FROM businesses WHERE id = ?'
  ).get(req.params.id);
  if (!biz) return res.status(404).json({ error: 'No encontrado' });

  const services = db.prepare(
    'SELECT id,name,duration_minutes,price FROM services WHERE business_id = ? AND active = 1'
  ).all(req.params.id);

  const slots = db.prepare(
    "SELECT date,time FROM availability WHERE business_id = ? AND status = 'available' AND date >= date('now') ORDER BY date,time"
  ).all(req.params.id);

  res.json({ ...biz, services, available_slots: slots });
});

// Mi perfil empresa (CON dirección/teléfono)
app.get('/api/businesses/me/profile', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.user.id);
  const { password, ...data } = biz;
  res.json(data);
});

// Estadísticas empresa
app.get('/api/businesses/me/stats', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const { month } = req.query;
  const filter = month ? `AND strftime('%Y-%m', date) = '${month}'` : '';
  const stats = db.prepare(`
    SELECT COUNT(*) as total, 
           SUM(CASE WHEN status='confirmed' OR status='completed' THEN 1 ELSE 0 END) as confirmed,
           SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled,
           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN status!='cancelled' THEN price ELSE 0 END) as gross_revenue,
           SUM(CASE WHEN status!='cancelled' THEN commission_amount ELSE 0 END) as commissions
    FROM bookings WHERE business_id = ? ${filter}
  `).get(req.user.id);
  stats.net_revenue = (stats.gross_revenue || 0) - (stats.commissions || 0);
  res.json(stats);
});

// Servicios empresa
app.get('/api/businesses/me/services', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  res.json(db.prepare('SELECT * FROM services WHERE business_id = ?').all(req.user.id));
});

app.post('/api/businesses/me/services', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const { name, duration_minutes, price } = req.body;
  if (!name || !duration_minutes || !price) return res.status(400).json({ error: 'Faltan campos' });
  const r = db.prepare(
    'INSERT INTO services (business_id,name,duration_minutes,price) VALUES (?,?,?,?)'
  ).run(req.user.id, name, duration_minutes, price);
  res.status(201).json({ id: r.lastInsertRowid, name, duration_minutes, price, active: 1 });
});

app.put('/api/businesses/me/services/:id', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const { name, duration_minutes, price, active } = req.body;
  db.prepare(
    'UPDATE services SET name=COALESCE(?,name), duration_minutes=COALESCE(?,duration_minutes), price=COALESCE(?,price), active=COALESCE(?,active) WHERE id=? AND business_id=?'
  ).run(name, duration_minutes, price, active, req.params.id, req.user.id);
  res.json({ message: 'Servicio actualizado' });
});

// Disponibilidad empresa
app.get('/api/businesses/me/availability', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const { month } = req.query;
  let q = 'SELECT * FROM availability WHERE business_id = ?';
  const p = [req.user.id];
  if (month) { q += ' AND date LIKE ?'; p.push(`${month}%`); }
  res.json(db.prepare(q + ' ORDER BY date,time').all(...p));
});

app.post('/api/businesses/me/availability', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const { slots } = req.body;
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'Envía array de slots' });

  const upsert = db.prepare(`
    INSERT INTO availability (business_id,date,time,status) VALUES (?,?,?,?)
    ON CONFLICT(business_id,date,time) DO UPDATE SET status=excluded.status WHERE status!='booked'
  `);
  db.transaction(() => slots.forEach(s => upsert.run(req.user.id, s.date, s.time, s.status || 'available')))();
  res.json({ message: `${slots.length} slots actualizados` });
});

// ── RESERVAS ──────────────────────────────────────────────────────────
// Crear reserva (cliente) → revela dirección y teléfono al confirmar
app.post('/api/bookings', auth, (req, res) => {
  if (req.user.type !== 'client') return res.status(403).json({ error: 'Solo clientes' });
  const { business_id, service_id, date, time } = req.body;

  const slot = db.prepare(
    "SELECT * FROM availability WHERE business_id=? AND date=? AND time=? AND status='available'"
  ).get(business_id, date, time);
  if (!slot) return res.status(409).json({ error: 'Horario no disponible' });

  const service = db.prepare('SELECT * FROM services WHERE id=? AND business_id=? AND active=1').get(service_id, business_id);
  if (!service) return res.status(404).json({ error: 'Servicio no encontrado' });

  const biz = db.prepare('SELECT * FROM businesses WHERE id=?').get(business_id);
  const commission = parseFloat((service.price * biz.commission_rate).toFixed(2));

  let code = genCode();
  while (db.prepare('SELECT id FROM bookings WHERE confirmation_code=?').get(code)) code = genCode();

  const bookingId = db.transaction(() => {
    const r = db.prepare(
      'INSERT INTO bookings (client_id,business_id,service_id,availability_id,date,time,price,commission_amount,confirmation_code) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(req.user.id, business_id, service_id, slot.id, date, time, service.price, commission, code);
    db.prepare("UPDATE availability SET status='booked' WHERE id=?").run(slot.id);
    return r.lastInsertRowid;
  })();

  res.status(201).json({
    message: '¡Reserva confirmada!',
    booking: {
      id: bookingId,
      confirmation_code: code,
      date, time,
      service: service.name,
      price: service.price,
      // ← Solo se revela al confirmar reserva
      business: { name: biz.name, address: biz.address, phone: biz.phone, zone: biz.zone },
      cancellation_policy: `Cancela gratis hasta 24h antes. Después: ${(service.price * 0.5).toFixed(2)}€`
    }
  });
});

// Mis reservas
app.get('/api/bookings/my', auth, (req, res) => {
  if (req.user.type === 'client') {
    res.json(db.prepare(`
      SELECT b.*, s.name as service_name, bu.name as business_name, bu.address, bu.phone
      FROM bookings b JOIN services s ON s.id=b.service_id JOIN businesses bu ON bu.id=b.business_id
      WHERE b.client_id=? ORDER BY b.date DESC
    `).all(req.user.id));
  } else {
    res.json(db.prepare(`
      SELECT b.*, s.name as service_name, c.name as client_name, c.phone as client_phone
      FROM bookings b JOIN services s ON s.id=b.service_id JOIN clients c ON c.id=b.client_id
      WHERE b.business_id=? ORDER BY b.date ASC
    `).all(req.user.id));
  }
});

// Pendientes de aceptar (empresa)
app.get('/api/bookings/pending', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  res.json(db.prepare(`
    SELECT b.*, s.name as service_name, c.name as client_name
    FROM bookings b JOIN services s ON s.id=b.service_id JOIN clients c ON c.id=b.client_id
    WHERE b.business_id=? AND b.status='pending' ORDER BY b.created_at ASC
  `).all(req.user.id));
});

// Aceptar reserva
app.put('/api/bookings/:id/confirm', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id=? AND business_id=?').get(req.params.id, req.user.id);
  if (!booking) return res.status(404).json({ error: 'No encontrada' });
  db.prepare("UPDATE bookings SET status='confirmed' WHERE id=?").run(req.params.id);
  res.json({ message: 'Reserva aceptada ✅' });
});

// Rechazar reserva
app.put('/api/bookings/:id/reject', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id=? AND business_id=?').get(req.params.id, req.user.id);
  if (!booking) return res.status(404).json({ error: 'No encontrada' });
  db.prepare("UPDATE availability SET status='available' WHERE id=?").run(booking.availability_id);
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(req.params.id);
  res.json({ message: 'Reserva rechazada. Slot liberado.' });
});

// Cancelar reserva (cliente, con lógica 50%)
app.put('/api/bookings/:id/cancel', auth, (req, res) => {
  if (req.user.type !== 'client') return res.status(403).json({ error: 'Solo clientes' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!booking) return res.status(404).json({ error: 'No encontrada' });
  if (booking.status === 'cancelled') return res.status(400).json({ error: 'Ya cancelada' });

  const hoursLeft = (new Date(`${booking.date}T${booking.time}`) - new Date()) / 3600000;
  const charge = hoursLeft < 24 ? parseFloat((booking.price * 0.5).toFixed(2)) : 0;

  db.transaction(() => {
    db.prepare("UPDATE bookings SET status='cancelled', cancellation_charge=? WHERE id=?").run(charge, req.params.id);
    if (charge === 0) db.prepare("UPDATE availability SET status='available' WHERE id=?").run(booking.availability_id);
  })();

  res.json({
    message: charge > 0 ? `Cancelada con cargo de ${charge}€ (menos de 24h)` : 'Cancelada sin cargo',
    cancellation_charge: charge
  });
});

// Reseña
app.post('/api/bookings/:id/review', auth, (req, res) => {
  if (req.user.type !== 'client') return res.status(403).json({ error: 'Solo clientes' });
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating entre 1 y 5' });

  const booking = db.prepare('SELECT * FROM bookings WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!booking || booking.status !== 'completed') return res.status(400).json({ error: 'Solo reservas completadas' });
  if (db.prepare('SELECT id FROM reviews WHERE booking_id=?').get(req.params.id)) return res.status(409).json({ error: 'Ya reseñaste esta reserva' });

  db.prepare('INSERT INTO reviews (booking_id,client_id,business_id,rating,comment) VALUES (?,?,?,?,?)').run(req.params.id, req.user.id, booking.business_id, rating, comment);

  const avg = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as total FROM reviews WHERE business_id=?').get(booking.business_id);
  db.prepare('UPDATE businesses SET rating=?, total_reviews=? WHERE id=?').run(avg.avg.toFixed(1), avg.total, booking.business_id);

  res.status(201).json({ message: '¡Reseña publicada!' });
});

// ── ARRANCAR ──────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`⏳ HOURFIX API corriendo en puerto ${PORT}`));
