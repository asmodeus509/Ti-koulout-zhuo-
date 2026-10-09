'use strict';
const jwt = require('jsonwebtoken');
const cfg = require('./config');
const { pool } = require('./db');
const { isBlocked, logSecurity, audit } = require('./events');
const { ISSUER, email, clientIp, isAdminUser } = require('./utils');

/* Lit le token Bearer et charge l'utilisateur. Retourne { user } ou { error, status }. */
async function userFromRequest(req) {
  const h = req.headers.authorization || '';
  const raw = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!raw) return { status: 401, error: 'Connexion requise.' };
  let payload;
  try { payload = jwt.verify(raw, cfg.jwtSecret, { issuer: ISSUER }); }
  catch (e) { return { status: 401, error: 'Session invalide ou expirée.' }; }
  const q = await pool.query('SELECT * FROM users WHERE id=$1', [payload.sub]);
  if (!q.rowCount) return { status: 401, error: 'Compte introuvable.' };
  let u = q.rows[0];
  if (isBlocked('user', u.id) || (u.email && isBlocked('email', u.email))) return { status: 403, error: 'Compte bloqué.' };
  if (cfg.adminEmails.has(email(u.email)) && u.role !== 'admin') {
    u = (await pool.query("UPDATE users SET role='admin' WHERE id=$1 RETURNING *", [u.id])).rows[0];
  }
  return { user: u };
}

async function auth(req, res, next) {
  try {
    const r = await userFromRequest(req);
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.error });
    req.user = r.user;
    next();
  } catch (e) { next(e); }
}

async function optionalUser(req, res, next) {
  try {
    const r = await userFromRequest(req);
    if (r.user) req.user = r.user;
  } catch (e) { /* visiteur anonyme */ }
  next();
}

function adminOnly(req, res, next) {
  if (isAdminUser(req.user)) return next();
  const msg = 'Accès administrateur refusé. Vérifie ADMIN_EMAILS.';
  res.status(403).json({ error: msg, message: msg });
}

/* IP bloquée => 403 */
function ipBlock(req, res, next) {
  if (isBlocked('ip', clientIp(req))) return res.status(403).json({ error: 'Accès bloqué.' });
  next();
}

/* Limiteur login / inscription : 40 essais / 15 min / IP (en mémoire) */
const hits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60000).unref();

function authLimiter(req, res, next) {
  if (req.method !== 'POST') return next();
  const ip = clientIp(req), now = Date.now();
  let h = hits.get(ip);
  if (!h || h.reset < now) { h = { n: 0, reset: now + 15 * 60 * 1000 }; hits.set(ip, h); }
  h.n++;
  if (h.n > 40) {
    const msg = 'Trop d’essais. Réessaie dans quelques minutes.';
    return res.status(429).json({ error: msg, message: msg });
  }
  const b = req.body || {};
  const who = String(b.email || b.contact || b.username || b.phone || b.login || '').toLowerCase().trim();
  if (who && isBlocked('email', who)) return res.status(403).json({ error: 'Compte bloqué.' });
  next();
}

/* Alertes sécurité + journal d'audit automatiques */
function activityLog(req, res, next) {
  res.on('finish', () => {
    try {
      const s = res.statusCode;
      if (s === 401 && /login/.test(req.path)) logSecurity('login_failed', 'low', req, { login: String((req.body && (req.body.email || req.body.contact)) || '').slice(0, 120) });
      else if (s === 403) logSecurity('access_denied', 'medium', req, {});
      else if (s === 429) logSecurity('rate_limited', 'medium', req, {});
      if (req.method !== 'GET' && req.originalUrl.startsWith('/api/admin') && s < 400 && req.user) {
        audit(req, req.method + ' ' + req.originalUrl.split('?')[0], 'Action admin', { params: req.params });
      }
    } catch (e) { /* ne jamais casser une réponse */ }
  });
  next();
}

module.exports = { auth, optionalUser, adminOnly, ipBlock, authLimiter, activityLog };
