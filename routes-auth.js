'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { auth } = require('./middleware');
const { isBlocked, notifyAdmin } = require('./events');
const cfg = require('./config');
const { bad, t, email, isEmail, isPhone, normPhone, wrap, userSafe, signToken } = require('./utils');

const router = express.Router();

/* Inscription : "contact" peut être un email OU un numéro de téléphone */
router.post('/auth/register', wrap(async (req, res) => {
  const b = req.body || {};
  const candidates = [b.email, b.contact, b.username].filter(Boolean);
  const em = (candidates.find(isEmail) || '').toLowerCase().trim() || null;
  const phoneRaw = [b.phone, b.whatsapp, b.contact, b.username].filter(Boolean).find(isPhone);
  const phone = phoneRaw ? normPhone(phoneRaw) : '';
  const pw = String(b.password || '');

  if (!em && !phone) bad(400, 'Email ou numéro de téléphone requis.');
  if (pw.length < 6) bad(400, 'Mot de passe: 6 caractères minimum.');
  if (b.password_confirmation != null && String(b.password_confirmation) !== pw) bad(400, 'Les mots de passe ne correspondent pas.');
  const name = t(b.name || b.fullName || b.full_name || (em ? em.split('@')[0] : phone), 120);
  if (name.length < 2) bad(400, 'Nom trop court.');

  try {
    const q = await pool.query(
      'INSERT INTO users(name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [name, em, phone, await bcrypt.hash(pw, 12), em && cfg.adminEmails.has(em) ? 'admin' : 'customer']
    );
    notifyAdmin('new_user', 'Nouveau client', name + ' • ' + (em || phone), { user_id: q.rows[0].id });
    res.status(201).json({ token: signToken(q.rows[0]), user: userSafe(q.rows[0]), message: 'Compte créé.' });
  } catch (e) {
    if (e.code === '23505') bad(409, 'Email ou téléphone déjà utilisé.');
    throw e;
  }
}));

/* Connexion par email OU téléphone (alias /login et /admin/login utilisés par le frontend) */
router.post(['/auth/login', '/login', '/admin/login'], wrap(async (req, res) => {
  const b = req.body || {};
  const raw = t(b.email || b.contact || b.username || b.phone || b.login, 200);
  if (!raw) bad(401, 'Identifiant ou mot de passe incorrect.');
  const q = await pool.query(
    "SELECT * FROM users WHERE email=$1 OR (phone<>'' AND phone=$2) ORDER BY (email=$1) DESC LIMIT 1",
    [raw.toLowerCase(), normPhone(raw)]
  );
  if (!q.rowCount || !(await bcrypt.compare(String(b.password || ''), q.rows[0].password_hash))) {
    bad(401, 'Identifiant ou mot de passe incorrect.');
  }
  let u = q.rows[0];
  if (isBlocked('user', u.id) || (u.email && isBlocked('email', u.email))) bad(403, 'Compte bloqué.');
  if (cfg.adminEmails.has(email(u.email)) && u.role !== 'admin') {
    u = (await pool.query("UPDATE users SET role='admin' WHERE id=$1 RETURNING *", [u.id])).rows[0];
  }
  res.json({ token: signToken(u), user: userSafe(u) });
}));

router.get(['/auth/me', '/me'], auth, (req, res) => res.json({ user: userSafe(req.user), ...userSafe(req.user) }));

router.post('/keep-alive', auth, (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

router.post('/auth/change-password', auth, wrap(async (req, res) => {
  const cur = String((req.body && (req.body.current_password || req.body.current)) || '');
  const next = String((req.body && (req.body.new_password || req.body.password)) || '');
  if (next.length < 6) bad(400, 'Nouveau mot de passe: 6 caractères minimum.');
  if (!(await bcrypt.compare(cur, req.user.password_hash))) bad(401, 'Mot de passe actuel incorrect.');
  await pool.query('UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2', [await bcrypt.hash(next, 12), req.user.id]);
  res.json({ success: true, message: 'Mot de passe modifié.' });
}));

module.exports = router;
