'use strict';
const jwt = require('jsonwebtoken');
const cfg = require('./config');

const ISSUER = 'flex-tupup-api';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (status, message) => { throw new HttpError(status, message); };

const t = (v, n = 500) => String(v == null ? '' : v).trim().slice(0, n);
const email = v => t(v, 200).toLowerCase();
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const normPhone = v => t(v, 40).replace(/[\s().-]/g, '');
const isPhone = v => /^\+?[0-9]{7,16}$/.test(normPhone(v));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

const toId = v => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) bad(400, 'Identifiant invalide.');
  return n;
};
const money = (v, max = 100000000) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) bad(400, 'Montant invalide.');
  return Math.round(n * 100) / 100;
};

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clientIp = req => String(req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');

const userSafe = u => ({
  id: u.id, name: u.name, email: u.email || '', phone: u.phone || '', role: u.role,
  wallet: Number(u.wallet_balance || 0), wallet_balance: Number(u.wallet_balance || 0),
  created_at: u.created_at
});

const signToken = u => jwt.sign({ sub: String(u.id) }, cfg.jwtSecret, { expiresIn: '14d', issuer: ISSUER });

const isAdminUser = u => !!u && u.role === 'admin' && cfg.adminEmails.has(email(u.email));

module.exports = { ISSUER, HttpError, bad, t, email, isEmail, normPhone, isPhone, num, toId, money, wrap, clientIp, userSafe, signToken, isAdminUser };
