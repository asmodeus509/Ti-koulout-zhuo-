'use strict';
// Routes administrateur (montées sur /api/admin avec auth + adminOnly) : clients, recharges, commandes, catalogue, médias, pubs
const express = require('express');
const { pool } = require('./db');
const { upload, uploadFile, resolveImage } = require('./storage');
const { notifyUser } = require('./events');
const { depositOut } = require('./routes-wallet');
const { orderOut, packOut } = require('./routes-shop');
const { bad, t, num, toId, money, wrap, userSafe } = require('./utils');

const router = express.Router();
const REFUSED = ['Refusé', 'Rejected', 'Annulé', 'Cancelled'];

/* ===== Tableau de bord ===== */
router.get('/dashboard', wrap(async (req, res) => {
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0].n;
  const [users, orders, pendingOrders, pendingDeposits, liability, confirmed, today] = await Promise.all([
    one('SELECT COUNT(*)::int n FROM users'),
    one('SELECT COUNT(*)::int n FROM orders WHERE status<>ALL($1)', [REFUSED]),
    one("SELECT COUNT(*)::int n FROM orders WHERE status IN('En attente','Pending')"),
    one("SELECT COUNT(*)::int n FROM wallet_deposits WHERE status='pending'"),
    one('SELECT COALESCE(SUM(wallet_balance),0) n FROM users'),
    one("SELECT COALESCE(SUM(amount),0) n FROM wallet_deposits WHERE status='confirmed'"),
    one("SELECT COUNT(*)::int n FROM orders WHERE created_at>=date_trunc('day',NOW() AT TIME ZONE 'America/Port-au-Prince') AT TIME ZONE 'America/Port-au-Prince'")
  ]);
  res.json({
    users, clients: users, orders, pending_orders: pendingOrders, pending_deposits: pendingDeposits,
    wallet_liability: Number(liability), confirmed_deposits_total: Number(confirmed), orders_today: today
  });
}));

/* ===== Clients ===== */
router.get('/users', wrap(async (req, res) => {
  const q = await pool.query('SELECT id,name,email,phone,role,wallet_balance,created_at FROM users ORDER BY created_at DESC LIMIT 2000');
  const rows = q.rows.map(userSafe);
  res.json({ users: rows, data: rows });
}));

router.patch('/users/:id/role', wrap(async (req, res) => {
  const role = t(req.body.role, 20), uid = toId(req.params.id);
  if (!['customer', 'admin'].includes(role)) bad(400, 'Rôle invalide.');
  if (uid === Number(req.user.id) && role !== 'admin') bad(400, 'Ou pa ka retire pwòp aksè admin ou.');
  const q = await pool.query('UPDATE users SET role=$1,updated_at=NOW() WHERE id=$2 RETURNING *', [role, uid]);
  if (!q.rowCount) bad(404, 'Kliyan pa jwenn.');
  res.json({ user: userSafe(q.rows[0]) });
}));

/* Ajustement manuel du wallet : { amount, type: 'credit'|'debit', note } */
router.post('/users/:id/wallet', wrap(async (req, res) => {
  const uid = toId(req.params.id), amount = money(req.body.amount), debit = /debit|retrait|remove/i.test(String(req.body.type || ''));
  const note = t(req.body.note, 250);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const q = await c.query('SELECT wallet_balance FROM users WHERE id=$1 FOR UPDATE', [uid]);
    if (!q.rowCount) bad(404, 'Kliyan pa jwenn.');
    if (debit && Number(q.rows[0].wallet_balance) < amount) bad(400, 'Balance insuffisant.');
    const r = await c.query('UPDATE users SET wallet_balance=wallet_balance+$1,updated_at=NOW() WHERE id=$2 RETURNING *', [debit ? -amount : amount, uid]);
    await notifyUser(uid, debit ? 'Wallet débité' : 'Wallet crédité', (debit ? 'Retrait de ' : 'Ajout de ') + amount + ' GDS par l’administration.' + (note ? ' ' + note : ''), c);
    await c.query('COMMIT');
    res.json({ user: userSafe(r.rows[0]), balance: Number(r.rows[0].wallet_balance) });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}));

/* ===== Recharges wallet ===== */
router.get(['/deposits', '/wallet/deposits', '/wallet-deposits', '/recharges', '/topups'], wrap(async (req, res) => {
  const q = await pool.query(
    'SELECT d.*,u.name customer_name,u.email customer_email,u.phone customer_phone,u.name user_name FROM wallet_deposits d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 1000'
  );
  const rows = q.rows.map(depositOut);
  res.json({ deposits: rows, data: rows });
}));

async function reviewDeposit(req, res, status) {
  const note = t(req.body && (req.body.note || req.body.admin_note), 500);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const q = await c.query('SELECT * FROM wallet_deposits WHERE id=$1 FOR UPDATE', [toId(req.params.id)]);
    if (!q.rowCount) bad(404, 'Recharge pa jwenn.');
    const d = q.rows[0];
    if (d.status !== 'pending') bad(409, 'Recharge sa a deja trete.');
    await c.query('UPDATE wallet_deposits SET status=$1,admin_note=$2,reviewed_by=$3,reviewed_at=NOW() WHERE id=$4', [status, note, req.user.id, d.id]);
    let balance = null;
    if (status === 'confirmed') {
      const u = await c.query('UPDATE users SET wallet_balance=wallet_balance+$1,updated_at=NOW() WHERE id=$2 RETURNING wallet_balance', [d.amount, d.user_id]);
      balance = Number(u.rows[0].wallet_balance);
    }
    await notifyUser(
      d.user_id,
      status === 'confirmed' ? 'Recharge confirmée' : 'Recharge refusée',
      status === 'confirmed' ? `Recharge ${d.method} de ${d.amount} GDS confirmée.` : `Recharge refusée. ${note}`.trim(),
      c
    );
    await c.query('COMMIT');
    res.json({ success: true, status, balance, user_id: d.user_id, message: status === 'confirmed' ? 'Wallet crédité.' : 'Recharge refusée.' });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
router.post('/deposits/:id/confirm', wrap((req, res) => reviewDeposit(req, res, 'confirmed')));
router.post('/deposits/:id/approve', wrap((req, res) => reviewDeposit(req, res, 'confirmed')));
router.post('/deposits/:id/refuse', wrap((req, res) => reviewDeposit(req, res, 'refused')));
router.post('/deposits/:id/reject', wrap((req, res) => reviewDeposit(req, res, 'refused')));
router.all('/deposits/:id', wrap((req, res, next) => {
  if (!['PATCH', 'PUT'].includes(req.method)) return next();
  const s = String(req.body && req.body.status || '').toLowerCase();
  if (/confirm|approv/.test(s)) return reviewDeposit(req, res, 'confirmed');
  if (/refus|reject/.test(s)) return reviewDeposit(req, res, 'refused');
  bad(400, 'Statut invalide (confirmed ou refused).');
}));

/* ===== Commandes ===== */
router.get('/orders', wrap(async (req, res) => {
  const q = await pool.query('SELECT o.*,u.name user_name,u.email user_email,u.phone user_phone FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 2000');
  const rows = q.rows.map(orderOut);
  res.json({ orders: rows, data: rows });
}));

const ORDER_STATUSES = ['En attente', 'En cours', 'Terminé', 'Livré', 'Refusé', 'Annulé', 'Pending', 'Processing', 'Approved', 'Completed', 'Rejected', 'Cancelled'];
router.all(['/orders/:id', '/orders/:id/status'], wrap(async (req, res, next) => {
  if (!['PATCH', 'PUT'].includes(req.method)) return next();
  const status = t(req.body.status, 40);
  if (!ORDER_STATUSES.includes(status)) bad(400, 'Statut invalide.');
  const c = await pool.connect();
  let row;
  try {
    await c.query('BEGIN');
    const old = await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [toId(req.params.id)]);
    if (!old.rowCount) bad(404, 'Commande pa jwenn.');
    const prev = old.rows[0];
    // Commande refusée => remboursement automatique (une seule fois)
    if (REFUSED.includes(status) && !REFUSED.includes(prev.status) && prev.charged) {
      await c.query('UPDATE users SET wallet_balance=wallet_balance+$1,updated_at=NOW() WHERE id=$2', [prev.price, prev.user_id]);
      await c.query('UPDATE orders SET charged=FALSE WHERE id=$1', [prev.id]);
    }
    row = (await c.query('UPDATE orders SET status=$1,admin_note=$2,updated_at=NOW() WHERE id=$3 RETURNING *', [status, t(req.body.note, 500), prev.id])).rows[0];
    await notifyUser(prev.user_id, 'Mise à jour commande', `Commande #${prev.id}: ${status}`, c);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  res.json({ order: orderOut(row), data: orderOut(row) });
}));

/* ===== Jeux & packs ===== */
const slugify = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

router.get('/games', wrap(async (req, res) => {
  const games = (await pool.query('SELECT * FROM games ORDER BY sort_order,id')).rows;
  const packs = (await pool.query('SELECT * FROM game_packs ORDER BY sort_order,id')).rows;
  const out = games.map(g => ({ ...g, image: g.image_url, img: g.image_url, packs: packs.filter(p => p.game_id === g.id).map(packOut) }));
  res.json({ games: out, data: out });
}));

router.post('/games', wrap(async (req, res) => {
  const b = req.body || {};
  const name = t(b.name || b.game, 120);
  if (!name) bad(400, 'Non jwèt obligatwa.');
  const image = await resolveImage(b.image_url ?? b.imageUrl ?? b.image ?? b.logo, 'games');
  try {
    const q = await pool.query(
      'INSERT INTO games(name,slug,image_url,active,fields,sort_order) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, t(b.slug || slugify(name), 140) || ('game-' + Date.now()), image, b.active !== false, JSON.stringify(Array.isArray(b.fields) ? b.fields : []), num(b.sort_order)]
    );
    res.status(201).json({ game: q.rows[0], data: q.rows[0] });
  } catch (e) { if (e.code === '23505') bad(409, 'Jwèt sa a egziste deja.'); throw e; }
}));

async function updateGame(req, res) {
  const gid = toId(req.params.id), b = req.body || {};
  const old = await pool.query('SELECT * FROM games WHERE id=$1', [gid]);
  if (!old.rowCount) bad(404, 'Jeu pa jwenn.');
  const g = old.rows[0];
  const image = await resolveImage(b.image_url ?? b.imageUrl ?? b.image ?? b.logo ?? g.image_url, 'games');
  const q = await pool.query(
    'UPDATE games SET name=$1,slug=$2,image_url=$3,active=$4,fields=$5,sort_order=$6,updated_at=NOW() WHERE id=$7 RETURNING *',
    [t(b.name ?? g.name, 120), t(b.slug ?? g.slug, 140), image, b.active === undefined ? g.active : !!b.active, JSON.stringify(Array.isArray(b.fields) ? b.fields : g.fields), num(b.sort_order, g.sort_order), gid]
  );
  res.json({ game: q.rows[0], data: q.rows[0] });
}
router.put('/games/:id', wrap(updateGame));
router.patch('/games/:id', wrap(updateGame));
router.delete('/games/:id', wrap(async (req, res) => {
  const q = await pool.query('UPDATE games SET active=FALSE,updated_at=NOW() WHERE id=$1 RETURNING id', [toId(req.params.id)]);
  if (!q.rowCount) bad(404, 'Jeu pa jwenn.');
  res.json({ success: true });
}));

router.post('/games/:id/packs', wrap(async (req, res) => {
  const b = req.body || {}, name = t(b.name || b.pack, 160);
  if (!name) bad(400, 'Non pack obligatwa.');
  const price = num(b.price, NaN);
  if (!Number.isFinite(price) || price < 0) bad(400, 'Prix invalide.');
  const gid = toId(req.params.id);
  if (!(await pool.query('SELECT 1 FROM games WHERE id=$1', [gid])).rowCount) bad(404, 'Jeu pa jwenn.');
  const image = await resolveImage(b.image_url ?? b.imageUrl ?? b.image ?? b.logo, 'packs');
  const q = await pool.query(
    'INSERT INTO game_packs(game_id,name,description,price,currency,image_url,qty,category,popular,active,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [gid, name, t(b.description, 500), price, t(b.currency || 'GDS', 10), image, Math.round(num(b.qty ?? b.quantity)), t(b.category || 'Diamonds', 100), !!b.popular, b.active !== false, num(b.sort_order)]
  );
  res.status(201).json({ pack: packOut(q.rows[0]), data: packOut(q.rows[0]) });
}));

async function updatePack(req, res) {
  const pid = toId(req.params.pid || req.params.id), b = req.body || {};
  const old = await pool.query('SELECT * FROM game_packs WHERE id=$1' + (req.params.gid ? ' AND game_id=$2' : ''), req.params.gid ? [pid, toId(req.params.gid)] : [pid]);
  if (!old.rowCount) bad(404, 'Pack pa jwenn.');
  const p = old.rows[0];
  const price = num(b.price ?? p.price, NaN);
  if (!Number.isFinite(price) || price < 0) bad(400, 'Prix invalide.');
  const image = await resolveImage(b.image_url ?? b.imageUrl ?? b.image ?? b.logo ?? p.image_url, 'packs');
  const q = await pool.query(
    'UPDATE game_packs SET name=$1,description=$2,price=$3,currency=$4,image_url=$5,qty=$6,category=$7,popular=$8,active=$9,sort_order=$10,updated_at=NOW() WHERE id=$11 RETURNING *',
    [t(b.name ?? b.pack ?? p.name, 160), t(b.description ?? p.description, 500), price, t(b.currency ?? p.currency, 10), image,
      Math.round(num(b.qty ?? b.quantity, p.qty)), t(b.category ?? p.category, 100), b.popular === undefined ? p.popular : !!b.popular,
      b.active === undefined ? p.active : !!b.active, num(b.sort_order, p.sort_order), pid]
  );
  res.json({ pack: packOut(q.rows[0]), data: packOut(q.rows[0]) });
}
router.put('/games/:gid/packs/:pid', wrap(updatePack));
router.patch('/games/:gid/packs/:pid', wrap(updatePack));
router.patch('/packs/:id', wrap(updatePack));
router.put('/packs/:id', wrap(updatePack));

async function deletePack(req, res) {
  const pid = toId(req.params.pid || req.params.id);
  const q = await pool.query('UPDATE game_packs SET active=FALSE,updated_at=NOW() WHERE id=$1 RETURNING id', [pid]);
  if (!q.rowCount) bad(404, 'Pack pa jwenn.');
  res.json({ success: true });
}
router.delete('/games/:gid/packs/:pid', wrap(deletePack));
router.delete('/packs/:id', wrap(deletePack));

/* ===== Paiement / WhatsApp ===== */
router.get('/payment-settings', wrap(async (req, res) => {
  res.json((await pool.query('SELECT * FROM payment_settings WHERE id=1')).rows[0] || {});
}));
router.put('/payment-settings', wrap(async (req, res) => {
  const b = req.body || {};
  const old = (await pool.query('SELECT * FROM payment_settings WHERE id=1')).rows[0] || {};
  const q = await pool.query(
    'UPDATE payment_settings SET moncash_number=$1,natcash_number=$2,whatsapp_number=$3,moncash_logo=$4,natcash_logo=$5,updated_at=NOW() WHERE id=1 RETURNING *',
    [t(b.moncash_number ?? b.monCashNumber ?? old.moncash_number, 100), t(b.natcash_number ?? b.natCashNumber ?? old.natcash_number, 100),
      t(b.whatsapp_number ?? b.whatsappNumber ?? b.whatsapp ?? old.whatsapp_number, 100),
      await resolveImage(b.moncash_logo ?? b.monCashLogo ?? old.moncash_logo, 'logos'), await resolveImage(b.natcash_logo ?? b.natCashLogo ?? old.natcash_logo, 'logos')]
  );
  res.json({ settings: q.rows[0], data: q.rows[0], ...q.rows[0] });
}));

const settingsGet = wrap(async (req, res) => {
  const q = await pool.query('SELECT whatsapp_number FROM payment_settings WHERE id=1');
  const wa = q.rows[0] ? q.rows[0].whatsapp_number : '';
  res.json({ whatsapp: wa, wa, whatsapp_number: wa });
});
const settingsPut = wrap(async (req, res) => {
  const b = req.body || {}, wa = t(b.whatsapp ?? b.wa ?? b.whatsapp_number, 100);
  await pool.query('UPDATE payment_settings SET whatsapp_number=$1,updated_at=NOW() WHERE id=1', [wa]);
  res.json({ whatsapp: wa, wa, whatsapp_number: wa });
});
router.get(['/settings', '/config'], settingsGet);
router.put(['/settings', '/config'], settingsPut);

/* ===== Médias du site ===== */
router.get('/media', wrap(async (req, res) => {
  res.json((await pool.query('SELECT home_image AS home,games,updated_at FROM site_media WHERE id=1')).rows[0] || { home: '', games: {} });
}));
router.put('/media', wrap(async (req, res) => {
  const b = req.body || {};
  const cur = (await pool.query('SELECT home_image,games FROM site_media WHERE id=1')).rows[0] || { home_image: '', games: {} };
  const home = await resolveImage(b.home ?? b.home_image ?? cur.home_image, 'media');
  const out = {};
  for (const [k, v] of Object.entries(b.games && typeof b.games === 'object' ? b.games : cur.games)) out[t(k, 80)] = await resolveImage(v, 'media');
  const q = await pool.query('UPDATE site_media SET home_image=$1,games=$2,updated_at=NOW() WHERE id=1 RETURNING *', [home, JSON.stringify(out)]);
  res.json({ media: q.rows[0], data: q.rows[0] });
}));

/* ===== Tutoriel ===== */
router.put('/tutorial', wrap(async (req, res) => {
  const b = req.body || {};
  const q = await pool.query(
    'UPDATE tutorial_config SET title=$1,video_url=$2,video_poster=$3,video_type=$4,active=$5,steps=$6,updated_at=NOW() WHERE id=1 RETURNING title,video_url AS "videoUrl",video_poster AS "videoPoster",video_type AS "videoType",active,steps,updated_at',
    [t(b.title || 'Tutoriel FLEX TUPUP', 200), t(b.videoUrl || b.video_url, 2000), await resolveImage(b.videoPoster || b.video_poster, 'tutorial'), t(b.videoType || b.video_type || 'video/mp4', 100), b.active !== false, JSON.stringify(Array.isArray(b.steps) ? b.steps : [])]
  );
  res.json({ tutorial: q.rows[0], data: q.rows[0] });
}));
router.post('/tutorial/video', upload.single('video'), wrap(async (req, res) => {
  if (!req.file) bad(400, 'Fichier video manquant (champ video).');
  if (!req.file.mimetype.startsWith('video/')) bad(415, 'Voye yon videyo.');
  const r = await uploadFile(req.file, 'tutorial');
  res.status(201).json({ url: r.url, videoUrl: r.url, video_url: r.url, data: { url: r.url, videoUrl: r.url } });
}));

/* ===== Upload général ===== */
router.post('/upload', upload.single('file'), wrap(async (req, res) => {
  if (req.file) {
    const r = await uploadFile(req.file, 'uploads');
    return res.status(201).json({ url: r.url, imageUrl: r.url, videoUrl: r.url, data: { url: r.url } });
  }
  const u = t(req.body.url || req.body.image_url, 2000);
  if (!/^https:\/\//i.test(u)) bad(400, 'Bay fichye oswa URL HTTPS.');
  res.json({ url: u, imageUrl: u, videoUrl: u });
}));

/* ===== Publicités ===== */
router.get('/ads', wrap(async (req, res) => {
  const q = await pool.query('SELECT *,image_url AS image,image_url AS img FROM ads ORDER BY sort_order,id DESC');
  res.json({ ads: q.rows, data: q.rows });
}));
router.post('/ads/upload', upload.any(), wrap(async (req, res) => {
  const f = (req.files || [])[0];
  if (!f) bad(400, 'Fichye imaj manke.');
  if (!f.mimetype.startsWith('image/')) bad(415, 'Piblisite dwe yon imaj.');
  const r = await uploadFile(f, 'ads');
  res.status(201).json({ url: r.url, imageUrl: r.url, data: { url: r.url } });
}));
router.post('/ads', wrap(async (req, res) => {
  const b = req.body || {};
  const img = await resolveImage(b.image_url ?? b.imageUrl ?? b.image ?? b.url, 'ads');
  if (!/^https?:\/\//i.test(img)) bad(400, 'URL imaj HTTPS oswa imaj upload obligatwa.');
  const q = await pool.query(
    'INSERT INTO ads(title,image_url,target_url,price,active,sort_order) VALUES($1,$2,$3,$4,$5,$6) RETURNING *,image_url AS image,image_url AS img',
    [t(b.title, 200), img, t(b.target_url ?? b.targetUrl, 2000), num(b.price), b.active !== false, num(b.sort_order)]
  );
  res.status(201).json({ ad: q.rows[0], data: q.rows[0] });
}));
async function updateAd(req, res) {
  const aid = toId(req.params.id), b = req.body || {};
  const old = await pool.query('SELECT * FROM ads WHERE id=$1', [aid]);
  if (!old.rowCount) bad(404, 'Pub pa jwenn.');
  const a = old.rows[0];
  const img = await resolveImage(b.image_url ?? b.imageUrl ?? b.image ?? b.url ?? a.image_url, 'ads');
  const q = await pool.query(
    'UPDATE ads SET title=$1,image_url=$2,target_url=$3,price=$4,active=$5,sort_order=$6 WHERE id=$7 RETURNING *,image_url AS image,image_url AS img',
    [t(b.title ?? a.title, 200), img, t(b.target_url ?? b.targetUrl ?? a.target_url, 2000), num(b.price, Number(a.price)), b.active === undefined ? a.active : !!b.active, num(b.sort_order, a.sort_order), aid]
  );
  res.json({ ad: q.rows[0], data: q.rows[0] });
}
router.patch('/ads/:id', wrap(updateAd));
router.put('/ads/:id', wrap(updateAd));
router.delete('/ads/:id', wrap(async (req, res) => {
  const q = await pool.query('DELETE FROM ads WHERE id=$1 RETURNING id', [toId(req.params.id)]);
  if (!q.rowCount) bad(404, 'Pub pa jwenn.');
  res.json({ success: true });
}));

module.exports = router;
