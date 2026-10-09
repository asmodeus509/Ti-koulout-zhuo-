'use strict';
// Routes publiques + espace client : jeux, packs, pubs, commandes, notifications, parrainage, classement
const express = require('express');
const { pool } = require('./db');
const { auth, optionalUser } = require('./middleware');
const { notifyAdmin, notifyUser, getSetting } = require('./events');
const cfg = require('./config');
const { bad, t, num, toId, wrap, isAdminUser } = require('./utils');

const router = express.Router();

/* ---------- Sorties (alias lus par le frontend) ---------- */
const packOut = p => ({
  id: p.id, name: p.name, pack: p.name, description: p.description, price: Number(p.price), currency: p.currency,
  image_url: p.image_url, image: p.image_url, img: p.image_url, qty: p.qty, quantity: p.qty,
  category: p.category, popular: !!p.popular, active: p.active, sort_order: p.sort_order
});
const orderOut = o => ({
  ...o,
  price: Number(o.price), amount: Number(o.price),
  plan: o.pack, uid: o.player_id, playerId: o.player_id, accountName: o.player_name,
  customer: o.customer_name, date: o.created_at, order_id: o.id
});
module.exports.orderOut = orderOut;
module.exports.packOut = packOut;

/* ---------- Catalogue ---------- */
router.get('/games', wrap(async (req, res) => {
  const games = (await pool.query('SELECT * FROM games WHERE active ORDER BY sort_order,id')).rows;
  const packs = (await pool.query('SELECT p.* FROM game_packs p JOIN games g ON g.id=p.game_id WHERE p.active AND g.active ORDER BY p.sort_order,p.id')).rows;
  const out = games.map(g => ({
    ...g, image: g.image_url, img: g.image_url,
    packs: packs.filter(p => p.game_id === g.id).map(packOut)
  }));
  res.json({ games: out, data: out });
}));

/* Le frontend attend un TABLEAU direct ici */
router.get('/games/:id/packs', wrap(async (req, res) => {
  const q = await pool.query('SELECT * FROM game_packs WHERE game_id=$1 AND active ORDER BY sort_order,id', [toId(req.params.id)]);
  res.json(q.rows.map(packOut));
}));

router.get('/ads', wrap(async (req, res) => {
  const q = await pool.query('SELECT *,image_url AS image,image_url AS img FROM ads WHERE active ORDER BY sort_order,id DESC');
  res.json({ ads: q.rows, data: q.rows });
}));

router.get('/payment-settings', wrap(async (req, res) => {
  const q = await pool.query('SELECT moncash_number,natcash_number,whatsapp_number,moncash_logo,natcash_logo,updated_at FROM payment_settings WHERE id=1');
  res.json(q.rows[0] || {});
}));

router.get('/tutorial', wrap(async (req, res) => {
  const q = await pool.query('SELECT title,video_url AS "videoUrl",video_poster AS "videoPoster",video_type AS "videoType",active,steps,updated_at FROM tutorial_config WHERE id=1');
  res.json({ tutorial: q.rows[0] || { title: 'Tutoriel FLEX TUPUP', videoUrl: '', active: true, steps: [] } });
}));

router.get('/media', wrap(async (req, res) => {
  const q = await pool.query('SELECT home_image AS home,games,updated_at FROM site_media WHERE id=1');
  res.json(q.rows[0] || { home: '', games: {} });
}));

/* ---------- Règles de checkout par jeu ---------- */
const DEFAULT_RULES = (() => {
  const r = {};
  ['Free Fire', 'eFootball', 'FlexCity', 'Fc Mobile', 'DLS 26', 'Roblox', 'Blood Strike', 'Lords Mobile', 'Call of Duty', 'PUBG']
    .forEach(g => { r[g] = (g === 'Free Fire' || g === 'Blood Strike') ? 'id' : 'number_ref'; });
  return r;
})();
const getRules = async () => ({ ...DEFAULT_RULES, ...(await getSetting('game_rules', {})) });
module.exports.DEFAULT_RULES = DEFAULT_RULES;

router.get('/game-rules', wrap(async (req, res) => {
  const rules = await getRules();
  res.json({ rules, data: { rules } });
}));

/* ---------- Parrainage ---------- */
const refOut = r => ({ id: r.id, code: r.code, affiliate: r.affiliate, active: r.active, createdAt: r.created_at, created_at: r.created_at });
module.exports.refOut = refOut;

router.get('/referrals', optionalUser, wrap(async (req, res) => {
  const q = await pool.query(isAdminUser(req.user) ? 'SELECT * FROM referrals ORDER BY created_at DESC' : 'SELECT * FROM referrals WHERE active ORDER BY created_at DESC');
  const rows = q.rows.map(refOut);
  res.json({ referrals: rows, data: rows });
}));

router.post('/referrals/verify', wrap(async (req, res) => {
  const code = t(req.body && req.body.code, 40).toUpperCase();
  if (!code) return res.json({ valid: false, ok: false, message: 'Antre kòd parrainage la.' });
  const q = await pool.query('SELECT * FROM referrals WHERE code=$1 AND active', [code]);
  if (!q.rowCount) return res.json({ valid: false, ok: false, message: 'Kòd sa a pa valid oswa li pa aktif.' });
  res.json({ valid: true, ok: true, referral: refOut(q.rows[0]) });
}));

/* ---------- Notifications client ---------- */
router.get('/notifications', auth, wrap(async (req, res) => {
  const q = await pool.query(
    'SELECT *,(read_at IS NOT NULL) AS read,created_at AS date FROM notifications WHERE user_id=$1 OR user_id IS NULL ORDER BY created_at DESC LIMIT 100',
    [req.user.id]
  );
  res.json({ notifications: q.rows, data: q.rows });
}));
router.post('/notifications/read-all', auth, wrap(async (req, res) => {
  await pool.query('UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
  res.json({ success: true });
}));
router.all('/notifications/:id/read', auth, wrap(async (req, res) => {
  await pool.query('UPDATE notifications SET read_at=NOW() WHERE id=$1 AND user_id=$2', [toId(req.params.id), req.user.id]);
  res.json({ success: true });
}));

/* ---------- Commandes ---------- */
router.get('/orders', auth, wrap(async (req, res) => {
  const q = await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  const rows = q.rows.map(orderOut);
  res.json({ orders: rows, data: rows });
}));

router.post('/orders', auth, wrap(async (req, res) => {
  const b = req.body || {};
  let game = t(b.game || b.game_name, 120);
  let pack = t(b.pack || b.pack_name || b.plan, 160);
  let price = num(b.price ?? b.amount, NaN);
  let currency = t(b.currency || 'GDS', 10);
  let gameId = null, packId = null, diamonds = Math.max(0, Math.round(num(b.diamonds, 0)));

  // 1) Retrouver le pack en base : par id, sinon par nom de jeu + nom de pack
  let packRow = null;
  const wantedPackId = b.pack_id || b.packId;
  if (wantedPackId && Number.isInteger(Number(wantedPackId))) {
    packRow = (await pool.query(
      'SELECT p.*,g.name game_name FROM game_packs p JOIN games g ON g.id=p.game_id WHERE p.id=$1 AND p.active AND g.active', [Number(wantedPackId)]
    )).rows[0];
    if (!packRow) bad(404, 'Pack indisponible.');
  } else if (game && pack) {
    packRow = (await pool.query(
      'SELECT p.*,g.name game_name FROM game_packs p JOIN games g ON g.id=p.game_id WHERE lower(g.name)=lower($1) AND lower(p.name)=lower($2) AND p.active AND g.active ORDER BY p.id LIMIT 1',
      [game, pack]
    )).rows[0];
  }
  if (packRow) {
    // Le prix du serveur fait foi
    packId = packRow.id; gameId = packRow.game_id; game = packRow.game_name; pack = packRow.name;
    price = Number(packRow.price); currency = packRow.currency;
    if (!diamonds) diamonds = packRow.qty || 0;
  } else if (cfg.strictPrices) {
    bad(404, 'Pack indisponible.');
  }
  if (!game || !pack) bad(400, 'Jeu ak pack obligatwa.');
  if (!Number.isFinite(price) || price <= 0 || price > 100000000) bad(400, 'Montant invalide.');
  price = Math.round(price * 100) / 100;

  // 2) Champs requis selon le jeu
  const rules = await getRules();
  const ruleKey = Object.keys(rules).find(k => k.toLowerCase() === game.toLowerCase());
  const needsId = (ruleKey && rules[ruleKey] === 'id') || /^(free fire|blood strike)$/i.test(game);
  const playerId = t(b.player_id || b.playerId || b.account_id || b.uid, 180);
  const playerName = t(b.player_name || b.playerName || b.accountName || b.account_name || b.in_game_name || b.username, 180);
  const phone = t(b.phone || b.customerPhone || b.whatsapp || b.phone_number, 100);
  if (needsId && (!playerId || !playerName)) bad(400, 'ID kont ak non jwè obligatwa.');
  if (/roblox|dream league|\bdls\b/i.test(game) && !phone) bad(400, 'Nimewo telefòn/WhatsApp obligatwa.');

  let referral = t(b.referral || b.referral_code, 40).toUpperCase();
  if (referral) {
    const r = await pool.query('SELECT code FROM referrals WHERE code=$1 AND active', [referral]);
    if (!r.rowCount) referral = '';
  }

  // 3) Débit du wallet + création de la commande (transaction atomique)
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = await c.query('SELECT wallet_balance FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    if (Number(u.rows[0].wallet_balance) < price) bad(400, 'Balance insuffisant.');
    await c.query('UPDATE users SET wallet_balance=wallet_balance-$1,updated_at=NOW() WHERE id=$2', [price, req.user.id]);
    const q = await c.query(
      `INSERT INTO orders(user_id,game_id,game,pack_id,pack,price,currency,player_id,player_name,phone,customer_name,referral,diamonds,status,charged)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'En attente',TRUE) RETURNING *`,
      [req.user.id, gameId, game, packId, pack, price, currency, playerId, playerName, phone, t(b.customer_name || b.customer || req.user.name, 120), referral, diamonds]
    );
    await c.query('COMMIT');
    const balance = Number(u.rows[0].wallet_balance) - price;
    notifyAdmin('new_order', 'Nouvo commande', game + ' • ' + pack + ' • ' + price, { order_id: q.rows[0].id });
    res.status(201).json({ order: orderOut(q.rows[0]), data: orderOut(q.rows[0]), balance, wallet: balance, message: 'Commande enregistrée.' });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}));

/* ---------- Classement mensuel (💎 commandés ce mois, fuseau Haïti) ---------- */
router.get('/leaderboard/monthly', optionalUser, wrap(async (req, res) => {
  const q = await pool.query(`
    SELECT u.id,u.name,SUM(COALESCE(NULLIF(o.diamonds,0),p.qty,0))::bigint AS diamonds
    FROM orders o
    JOIN users u ON u.id=o.user_id
    LEFT JOIN game_packs p ON p.id=o.pack_id
    WHERE o.created_at >= (date_trunc('month', NOW() AT TIME ZONE 'America/Port-au-Prince') AT TIME ZONE 'America/Port-au-Prince')
      AND o.status NOT IN('Refusé','Rejected','Annulé','Cancelled')
    GROUP BY u.id,u.name
    HAVING SUM(COALESCE(NULLIF(o.diamonds,0),p.qty,0)) > 0
    ORDER BY diamonds DESC, MIN(o.created_at) ASC
    LIMIT 100`);
  const me = req.user ? String(req.user.id) : null;
  const top = q.rows.map((r, i) => ({ rank: i + 1, pseudo: r.name, diamonds: Number(r.diamonds), me: me === String(r.id) }));
  res.json({ top, month: new Date().toISOString().slice(0, 7) });
}));

module.exports = router;
module.exports.orderOut = orderOut;
module.exports.packOut = packOut;
module.exports.refOut = refOut;
module.exports.DEFAULT_RULES = DEFAULT_RULES;
