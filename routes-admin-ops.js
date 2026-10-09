'use strict';
// Outils admin : règles de jeu, parrainage, notifications, journal d'audit, sécurité
const express = require('express');
const { pool } = require('./db');
const { refreshBlocks, setSetting } = require('./events');
const { DEFAULT_RULES, refOut } = require('./routes-shop');
const cfg = require('./config');
const { bad, t, email, toId, wrap, clientIp } = require('./utils');

const router = express.Router();

/* ===== Règles de checkout ===== */
router.put('/game-rules', wrap(async (req, res) => {
  const src = (req.body && (req.body.rules || req.body)) || {}, clean = {};
  for (const [k, v] of Object.entries(src)) if (typeof v === 'string') clean[t(k, 80)] = t(v, 40);
  await setSetting('game_rules', clean);
  res.json({ rules: { ...DEFAULT_RULES, ...clean } });
}));

/* ===== Parrainage ===== */
const refCode = v => {
  const c = t(v, 40).toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(c)) bad(400, 'Code invalide (3-32: A-Z, 0-9, _ ou -).');
  return c;
};

router.get('/referrals', wrap(async (req, res) => {
  const rows = (await pool.query('SELECT * FROM referrals ORDER BY created_at DESC')).rows.map(refOut);
  res.json({ referrals: rows, data: rows });
}));

router.post('/referrals', wrap(async (req, res) => {
  const b = req.body || {}, code = refCode(b.code), affiliate = t(b.affiliate, 160);
  if (!affiliate) bad(400, 'Non/ID afilye obligatwa.');
  const id = t(b.id, 60) || ('REF-' + Date.now().toString(36).toUpperCase());
  try {
    const q = await pool.query('INSERT INTO referrals(id,code,affiliate,active) VALUES($1,$2,$3,$4) RETURNING *', [id, code, affiliate, b.active !== false]);
    res.status(201).json({ referral: refOut(q.rows[0]), data: refOut(q.rows[0]) });
  } catch (e) { if (e.code === '23505') bad(409, 'Code sa a egziste deja.'); throw e; }
}));

async function updateReferral(req, res) {
  const b = req.body || {};
  const old = await pool.query('SELECT * FROM referrals WHERE id=$1', [t(req.params.rid, 60)]);
  if (!old.rowCount) bad(404, 'Kòd pa jwenn.');
  const r = old.rows[0];
  try {
    const q = await pool.query(
      'UPDATE referrals SET code=$1,affiliate=$2,active=$3,updated_at=NOW() WHERE id=$4 RETURNING *',
      [b.code === undefined ? r.code : refCode(b.code), b.affiliate === undefined ? r.affiliate : t(b.affiliate, 160), b.active === undefined ? r.active : b.active !== false, r.id]
    );
    res.json({ referral: refOut(q.rows[0]), data: refOut(q.rows[0]) });
  } catch (e) { if (e.code === '23505') bad(409, 'Code sa a egziste deja.'); throw e; }
}
router.put('/referrals/:rid', wrap(updateReferral));
router.patch('/referrals/:rid', wrap(updateReferral));
router.delete('/referrals/:rid', wrap(async (req, res) => {
  await pool.query('DELETE FROM referrals WHERE id=$1', [t(req.params.rid, 60)]);
  res.json({ success: true });
}));

/* ===== Notifications admin ===== */
const noteOut = n => ({
  id: n.id, type: n.type, title: n.title, message: n.message, read: n.read,
  order: (n.payload && n.payload.order) || undefined, payload: n.payload, created_at: n.created_at, date: n.created_at
});

router.get('/notifications', wrap(async (req, res) => {
  const rows = (await pool.query('SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 200')).rows.map(noteOut);
  res.json({ notifications: rows, data: rows, unread: rows.filter(n => !n.read).length });
}));

/* Le frontend poste ici ses propres notifications (nouvelle commande, demande DM admin…) */
router.post('/notifications', wrap(async (req, res) => {
  const b = req.body || {};
  const payload = b.order ? { order: b.order } : (b.payload && typeof b.payload === 'object' ? b.payload : {});
  const q = await pool.query(
    'INSERT INTO admin_notifications(type,title,message,payload,read) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [t(b.type || 'info', 40), t(b.title || 'Notification', 200), t(b.message, 500), JSON.stringify(payload), b.read === true]
  );
  res.status(201).json({ notification: noteOut(q.rows[0]), data: noteOut(q.rows[0]) });
}));

router.post('/notifications/read-all', wrap(async (req, res) => {
  await pool.query('UPDATE admin_notifications SET read=TRUE WHERE NOT read');
  res.json({ success: true });
}));

router.all(['/notifications/:nid', '/notifications/:nid/read'], wrap(async (req, res) => {
  const nid = toId(req.params.nid);
  if (req.method === 'DELETE') {
    await pool.query('DELETE FROM admin_notifications WHERE id=$1', [nid]);
    return res.json({ success: true });
  }
  if (!['PATCH', 'PUT', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Méthode non autorisée.' });
  const q = await pool.query('UPDATE admin_notifications SET read=$1 WHERE id=$2 RETURNING *', [!(req.body && req.body.read === false), nid]);
  if (!q.rowCount) bad(404, 'Notification pa jwenn.');
  res.json({ notification: noteOut(q.rows[0]), data: noteOut(q.rows[0]) });
}));

/* ===== Journal d'audit ===== */
router.get('/audit-logs', wrap(async (req, res) => {
  const q = await pool.query('SELECT id,admin,action,message,details,ip,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 200');
  res.json({ logs: q.rows, audit_logs: q.rows, data: q.rows });
}));

/* ===== Sécurité ===== */
router.get('/security/events', wrap(async (req, res) => {
  const [events, ips, blocks] = await Promise.all([
    pool.query('SELECT id,type,severity,ip,user_id,path,details,created_at FROM security_events ORDER BY created_at DESC LIMIT 100'),
    pool.query("SELECT ip,COUNT(*)::int n,MAX(created_at) last_at FROM security_events WHERE created_at>NOW()-INTERVAL '7 days' AND ip<>'' GROUP BY ip ORDER BY n DESC LIMIT 10"),
    pool.query('SELECT kind,value,reason,created_at FROM security_blocks ORDER BY created_at DESC LIMIT 200')
  ]);
  res.json({ events: events.rows, topIps: ips.rows, blocks: blocks.rows });
}));

router.post('/security/block', wrap(async (req, res) => {
  const kind = t(req.body.kind, 10), value = t(req.body.value, 200).toLowerCase();
  if (!['ip', 'user', 'email'].includes(kind) || !value) bad(400, 'kind/value invalides.');
  if (kind === 'ip' && value === clientIp(req).toLowerCase()) bad(400, 'Ou pa ka bloke pwòp IP ou.');
  if (kind === 'user') {
    const u = await pool.query('SELECT id,role FROM users WHERE id=$1', [toId(value)]);
    if (!u.rowCount) bad(404, 'Kliyan pa jwenn.');
    if (u.rows[0].role === 'admin') bad(400, 'Ou pa ka bloke yon admin.');
  }
  if (kind === 'email' && cfg.adminEmails.has(email(value))) bad(400, 'Ou pa ka bloke yon admin.');
  await pool.query(
    'INSERT INTO security_blocks(kind,value,reason) VALUES($1,$2,$3) ON CONFLICT(kind,value) DO UPDATE SET reason=$3',
    [kind, value, t(req.body.reason, 300)]
  );
  await refreshBlocks();
  res.json({ success: true });
}));

router.post('/security/unblock', wrap(async (req, res) => {
  await pool.query('DELETE FROM security_blocks WHERE kind=$1 AND value=$2', [t(req.body.kind, 10), t(req.body.value, 200).toLowerCase()]);
  await refreshBlocks();
  res.json({ success: true });
}));

module.exports = router;
