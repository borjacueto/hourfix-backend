require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'hourfix_secret_2026';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'borjacueto@gmail.com';

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
    description TEXT,
    address TEXT,
    zone TEXT,
    city TEXT DEFAULT 'Gijón',
    rating REAL DEFAULT 0,
    total_reviews INTEGER DEFAULT 0,
    plan TEXT DEFAULT 'free',
    commission_rate REAL DEFAULT 0.15,
    active INTEGER DEFAULT 1,
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

console.log('✅ Base de datos iniciada');

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

// ── FUNCIÓN DE EMAIL ──────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.log('⚠️ RESEND_API_KEY no configurada, email no enviado');
    return;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'HOURFIX <onboarding@resend.dev>',
        to: [to],
        subject: subject,
        html: html
      })
    });

    const data = await response.json();
    if (response.ok) {
      console.log(`✅ Email enviado a ${to}`);
    } else {
      console.error('Error enviando email:', data);
    }
  } catch (err) {
    console.error('Error en sendEmail:', err);
  }
}

// ── HEALTH CHECK ──────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'HOURFIX API funcionando ✅', version: '1.0' }));

// ── AUTH EMPRESAS ─────────────────────────────────────────────────────
app.post('/api/auth/business/register', async (req, res) => {
  const { name, email, password, phone, category, description, address, zone } = req.body;
  
  if (!name || !email || !password || !category)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  
  if (db.prepare('SELECT id FROM businesses WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Email ya registrado' });

  const hashedPassword = bcrypt.hashSync(password, 10);

  const result = db.prepare(
    'INSERT INTO businesses (name,email,password,phone,category,address,zone) VALUES (?,?,?,?,?,?,?)'
  ).run(name, email, hashedPassword, phone, category, address, zone);

  const token = jwt.sign({ id: result.lastInsertRowid, type: 'business', name }, JWT_SECRET, { expiresIn: '30d' });

  // Email al negocio
  await sendEmail(
    email,
    '¡Bienvenido a HOURFIX!',
    `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #D86018;">¡Bienvenido a HOURFIX, ${name}!</h1>
      <p>Tu negocio ha sido registrado correctamente en nuestra plataforma.</p>
      <p><strong>Próximos pasos:</strong></p>
      <ol>
        <li>Añade tus servicios y precios</li>
        <li>Configura tus horarios disponibles</li>
        <li>¡Empieza a recibir reservas!</li>
      </ol>
      <p>Te contactaremos pronto con más información sobre el lanzamiento en Gijón y Oviedo.</p>
      <p style="color: #666; font-size: 0.9rem;">Si no solicitaste este registro, ignora este email.</p>
    </div>
    `
  );

  // Email al admin (ti)
  await sendEmail(
    ADMIN_EMAIL,
    `🔔 Nuevo registro: ${name}`,
    `
    <div style="font-family: Arial, sans-serif;">
      <h2 style="color: #D86018;">Nuevo negocio registrado</h2>
      <table style="border-collapse: collapse; width: 100%;">
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Nombre:</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${name}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Email:</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${email}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Teléfono:</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${phone || 'No proporcionado'}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Categoría:</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${category}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Zona:</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${zone || 'No especificada'}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Dirección:</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${address || 'No proporcionada'}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Descripción:</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${description || 'No proporcionada'}</td></tr>
      </table>
      <p style="margin-top: 20px; color: #666;">Registrado el ${new Date().toLocaleString('es-ES')}</p>
    </div>
    `
  );

  res.status(201).json({
    message: '¡Empresa registrada!',
    token,
    business: { id: result.lastInsertRowid, name, email, category, plan: 'free' }
  });
});

app.post('/api/auth/business/login', (req, res) => {
  const { email, password } = req.body;
  const business = db.prepare('SELECT * FROM businesses WHERE email = ?').get(email);
  if (!business || !bcrypt.compareSync(password, business.password))
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  
  const token = jwt.sign({ id: business.id, type: 'business', name: business.name }, JWT_SECRET, { expiresIn: '30d' });
  const { password: _, ...businessData } = business;
  res.json({ token, business: businessData });
});

// ── AUTH CLIENTES ─────────────────────────────────────────────────────
app.post('/api/auth/client/register', (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Faltan campos obligatorios' });
  if (db.prepare('SELECT id FROM clients WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Email ya registrado' });

  const hashedPassword = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO clients (name,email,password,phone) VALUES (?,?,?,?)').run(name, email, hashedPassword, phone);
  const token = jwt.sign({ id: result.lastInsertRowid, type: 'client', name }, JWT_SECRET, { expiresIn: '30d' });
  
  res.status(201).json({ message: '¡Bienvenido a HOURFIX!', token, client: { id: result.lastInsertRowid, name, email } });
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
app.get('/api/businesses', (req, res) => {
  const { category, date, time } = req.query;
  let query = `SELECT b.id, b.name, b.category, b.zone, b.city, b.rating, b.total_reviews,
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

app.get('/api/businesses/:id', (req, res) => {
  const biz = db.prepare('SELECT id,name,category,zone,rating,total_reviews FROM businesses WHERE id = ?').get(req.params.id);
  if (!biz) return res.status(404).json({ error: 'No encontrado' });
  const services = db.prepare('SELECT id,name,duration_minutes,price FROM services WHERE business_id = ? AND active = 1').all(req.params.id);
  const slots = db.prepare("SELECT date,time FROM availability WHERE business_id = ? AND status = 'available' AND date >= date('now') ORDER BY date,time").all(req.params.id);
  res.json({ ...biz, services, available_slots: slots });
});

app.get('/api/businesses/me/profile', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.user.id);
  const { password, ...data } = biz;
  res.json(data);
});

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

app.get('/api/businesses/me/services', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  res.json(db.prepare('SELECT * FROM services WHERE business_id = ?').all(req.user.id));
});

app.post('/api/businesses/me/services', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const { name, duration_minutes, price } = req.body;
  if (!name || !duration_minutes || !price) return res.status(400).json({ error: 'Faltan campos' });
  const r = db.prepare('INSERT INTO services (business_id,name,duration_minutes,price) VALUES (?,?,?,?)').run(req.user.id, name, duration_minutes, price);
  res.status(201).json({ id: r.lastInsertRowid, name, duration_minutes, price, active: 1 });
});

app.put('/api/businesses/me/services/:id', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const { name, duration_minutes, price, active } = req.body;
  db.prepare('UPDATE services SET name=COALESCE(?,name), duration_minutes=COALESCE(?,duration_minutes), price=COALESCE(?,price), active=COALESCE(?,active) WHERE id=? AND business_id=?').run(name, duration_minutes, price, active, req.params.id, req.user.id);
  res.json({ message: 'Servicio actualizado' });
});

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
  const upsert = db.prepare(`INSERT INTO availability (business_id,date,time,status) VALUES (?,?,?,?) ON CONFLICT(business_id,date,time) DO UPDATE SET status=excluded.status WHERE status!='booked'`);
  db.transaction(() => slots.forEach(s => upsert.run(req.user.id, s.date, s.time, s.status || 'available')))();
  res.json({ message: `${slots.length} slots actualizados` });
});

// ── RESERVAS ──────────────────────────────────────────────────────────
app.post('/api/bookings', auth, (req, res) => {
  if (req.user.type !== 'client') return res.status(403).json({ error: 'Solo clientes' });
  const { business_id, service_id, date, time } = req.body;
  const slot = db.prepare("SELECT * FROM availability WHERE business_id=? AND date=? AND time=? AND status='available'").get(business_id, date, time);
  if (!slot) return res.status(409).json({ error: 'Horario no disponible' });
  const service = db.prepare('SELECT * FROM services WHERE id=? AND business_id=? AND active=1').get(service_id, business_id);
  if (!service) return res.status(404).json({ error: 'Servicio no encontrado' });
  const biz = db.prepare('SELECT * FROM businesses WHERE id=?').get(business_id);
  const commission = parseFloat((service.price * biz.commission_rate).toFixed(2));
  let code = genCode();
  while (db.prepare('SELECT id FROM bookings WHERE confirmation_code=?').get(code)) code = genCode();
  
  const bookingId = db.transaction(() => {
    const r = db.prepare('INSERT INTO bookings (client_id,business_id,service_id,availability_id,date,time,price,commission_amount,confirmation_code) VALUES (?,?,?,?,?,?,?,?,?)').run(req.user.id, business_id, service_id, slot.id, date, time, service.price, commission, code);
    db.prepare("UPDATE availability SET status='booked' WHERE id=?").run(slot.id);
    return r.lastInsertRowid;
  })();

  res.status(201).json({
    message: '¡Reserva confirmada!',
    booking: { id: bookingId, confirmation_code: code, date, time, service: service.name, price: service.price, business: { name: biz.name, address: biz.address, phone: biz.phone, zone: biz.zone } }
  });
});

app.get('/api/bookings/my', auth, (req, res) => {
  if (req.user.type === 'client') {
    res.json(db.prepare('SELECT b.*, s.name as service_name, bu.name as business_name, bu.address, bu.phone FROM bookings b JOIN services s ON s.id=b.service_id JOIN businesses bu ON bu.id=b.business_id WHERE b.client_id=? ORDER BY b.date DESC').all(req.user.id));
  } else {
    res.json(db.prepare('SELECT b.*, s.name as service_name, c.name as client_name, c.phone as client_phone FROM bookings b JOIN services s ON s.id=b.service_id JOIN clients c ON c.id=b.client_id WHERE b.business_id=? ORDER BY b.date ASC').all(req.user.id));
  }
});

app.get('/api/bookings/pending', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  res.json(db.prepare("SELECT b.*, s.name as service_name, c.name as client_name FROM bookings b JOIN services s ON s.id=b.service_id JOIN clients c ON c.id=b.client_id WHERE b.business_id=? AND b.status='pending' ORDER BY b.created_at ASC").all(req.user.id));
});

app.put('/api/bookings/:id/confirm', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id=? AND business_id=?').get(req.params.id, req.user.id);
  if (!booking) return res.status(404).json({ error: 'No encontrada' });
  db.prepare("UPDATE bookings SET status='confirmed' WHERE id=?").run(req.params.id);
  res.json({ message: 'Reserva aceptada ✅' });
});

app.put('/api/bookings/:id/reject', auth, (req, res) => {
  if (req.user.type !== 'business') return res.status(403).json({ error: 'Solo empresas' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id=? AND business_id=?').get(req.params.id, req.user.id);
  if (!booking) return res.status(404).json({ error: 'No encontrada' });
  db.prepare("UPDATE availability SET status='available' WHERE id=?").run(booking.availability_id);
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(req.params.id);
  res.json({ message: 'Reserva rechazada. Slot liberado.' });
});

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
  res.json({ message: charge > 0 ? `Cancelada con cargo de ${charge}€ (menos de 24h)` : 'Cancelada sin cargo', cancellation_charge: charge });
});

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

// ── LISTA DE ESPERA ───────────────────────────────────────────────────
app.post('/api/waitlist', async (req, res) => {
  const { name, email, category, city, monthly_bookings, monthly_cancellations, avg_price, main_barrier, willingness_to_pay, comments } = req.body;
  
  if (!name || !email || !category) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  // Guardamos en la tabla de businesses con password temporal
  try {
    const hashedPassword = bcrypt.hashSync('waitlist_' + Date.now(), 10);
    db.prepare(
      'INSERT INTO businesses (name, email, password, category, zone, description) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      name,
      email,
      hashedPassword,
      category,
      city || '',
      `LISTA_ESPERA: ${JSON.stringify({ monthly_bookings, monthly_cancellations, avg_price, main_barrier, willingness_to_pay, comments })}`
    );
  } catch (err) {
    // Si el email ya existe, lo ignoramos silenciosamente
    console.log('Email duplicado en lista de espera:', email);
  }

  // Email al negocio
  await sendEmail(
    email,
    '¡Estás en la lista de HOURFIX!',
    `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #D86018;">¡Bienvenido a HOURFIX, ${name}!</h1>
      <p>Has sido añadido a nuestra lista de espera para el lanzamiento en <strong>${city || 'Gijón/Oviedo'}</strong>.</p>
      <p><strong>Te contactaremos antes del lanzamiento</strong> para darte acceso prioritario y configurar tu perfil.</p>
      <h3 style="color: #D86018; margin-top: 2rem;">¿Qué puedes esperar?</h3>
      <ul style="line-height: 1.8;">
        <li>💰 <strong>Recupera el dinero de cancelaciones</strong> — Cobramos automáticamente el 50% si cancelan con menos de 24h</li>
        <li>📅 <strong>Solo tus huecos libres</strong> — Tus clientes habituales siguen como siempre</li>
        <li>🎯 <strong>Clientes nuevos verificados</strong> — Sin curiosos ni no-shows</li>
        <li>📍 <strong>Top posición garantizada</strong> — Los primeros registros aparecen siempre arriba</li>
      </ul>
      <p style="margin-top: 2rem; color: #666; font-size: 0.9rem;">Si no solicitaste esto, ignora este email.</p>
    </div>
    `
  );

  // Email al admin (con datos limpios)
  await sendEmail(
    ADMIN_EMAIL,
    `🔔 Lista de espera: ${name} (${category})`,
    `
    <div style="font-family: Arial, sans-serif;">
      <h2 style="color: #D86018;">Nuevo negocio en lista de espera</h2>
      <table style="border-collapse: collapse; width: 100%; margin-bottom: 2rem;">
        <tr style="background: #FFF8F0;">
          <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Nombre</td>
          <td style="padding: 12px; border: 1px solid #ddd;">${name}</td>
        </tr>
        <tr>
          <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Email</td>
          <td style="padding: 12px; border: 1px solid #ddd;"><a href="mailto:${email}">${email}</a></td>
        </tr>
        <tr style="background: #FFF8F0;">
          <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Categoría</td>
          <td style="padding: 12px; border: 1px solid #ddd;"><strong>${category}</strong></td>
        </tr>
        <tr>
          <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Ciudad</td>
          <td style="padding: 12px; border: 1px solid #ddd;">${city || 'No especificada'}</td>
        </tr>
      </table>

      <h3 style="color: #D86018;">📊 Datos de negocio</h3>
      <table style="border-collapse: collapse; width: 100%; margin-bottom: 2rem;">
        <tr>
          <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Citas al mes</td>
          <td style="padding: 12px; border: 1px solid #ddd;">${monthly_bookings || 'No respondió'}</td>
        </tr>
        <tr style="background: #FFEBEE;">
          <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Cancelaciones al mes</td>
          <td style="padding: 12px; border: 1px solid #ddd;"><strong style="color: #C62828;">${monthly_cancellations || 'No respondió'}</strong></td>
        </tr>
        <tr>
          <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Precio medio servicio</td>
          <td style="padding: 12px; border: 1px solid #ddd;">${avg_price || 'No respondió'}</td>
        </tr>
      </table>

      <h3 style="color: #D86018;">💭 Interés y barreras</h3>
      <table style="border-collapse: collapse; width: 100%;">
        <tr>
          <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Principal barrera</td>
          <td style="padding: 12px; border: 1px solid #ddd;">${main_barrier || 'No respondió'}</td>
        </tr>
        <tr style="background: #E8F5E9;">
          <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold;">Dispuesto a pagar</td>
          <td style="padding: 12px; border: 1px solid #ddd;"><strong style="color: #2E7D32;">${willingness_to_pay || 'No respondió'}</strong></td>
        </tr>
        ${comments ? `
        <tr>
          <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold; vertical-align: top;">Comentarios</td>
          <td style="padding: 12px; border: 1px solid #ddd;">${comments}</td>
        </tr>
        ` : ''}
      </table>

      <p style="margin-top: 20px; color: #666; font-size: 0.9rem;">
        Registrado el ${new Date().toLocaleString('es-ES')}
      </p>
    </div>
    `
  );

  res.status(201).json({ message: 'Añadido a la lista de espera' });
});

// ── ARRANCAR ──────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`⏳ HOURFIX API corriendo en puerto ${PORT}`));
