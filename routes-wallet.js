'use strict';
const express = require('express');
const { pool } = require('./db');
const { auth } = require('./middleware');
const { notifyAdmin } = require('./events');
const cfg = require('./config');
const { bad, t, money, wrap } = require('./utils');

const router = express.Router();

/* Sortie dépôt : ajoute les alias lus par le frontend (tx, note, date) */
const depositOut = d => ({
  ...d,
  amount: Number(d.amount),
  tx: d.transaction_reference,
  note: d.customer_note || '',
  date: d.created_at
});
module.exports.depositOut = depositOut;

const myDeposits = id => pool.query('SELECT * FROM wallet_deposits WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [id]);

router.get('/wallet', auth, wrap(async (req, res) => {
  const u = (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [req.user.id])).rows[0];
  const d = (await myDeposits(req.user.id)).rows.map(depositOut);
  const balance = Number(u.wallet_balance);
  res.json({ balance, wallet: balance, wallet_balance: balance, deposits: d, history: d });
}));

router.get('/wallet/deposits', auth, wrap(async (req, res) => {
  const d = (await myDeposits(req.user.id)).rows.map(depositOut);
  res.json({ deposits: d, data: d });
}));

router.post(['/wallet/deposits', '/wallet/deposit', '/wallet/recharge', '/deposits'], auth, wrap(async (req, res) => {
  const b = req.body || {};
  const rawMethod = t(b.method || b.payment_method, 30);
  const method = /natcash/i.test(rawMethod) ? 'NatCash' : /moncash/i.test(rawMethod) ? 'MonCash' : '';
  if (!method) bad(400, 'Chwazi MonCash oswa NatCash.');
  const amount = money(b.amount, cfg.limits.maxDeposit);
  if (amount < cfg.limits.minDeposit) bad(400, 'Montant invalide.');
  const ref = t(b.transaction_reference || b.transactionReference || b.reference || b.transaction_code || b.code || b.tx, 180);
  if (ref.length < 4) bad(400, 'Kòd tranzaksyon obligatwa.');

  const pending = await pool.query("SELECT COUNT(*)::int n FROM wallet_deposits WHERE user_id=$1 AND status='pending'", [req.user.id]);
  if (pending.rows[0].n >= cfg.limits.maxPendingDeposits) bad(429, 'Twòp demann an atant. Tann admin lan trete yo.');

  try {
    const q = await pool.query(
      'INSERT INTO wallet_deposits(user_id,method,amount,transaction_reference,phone,customer_note) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, method, amount, ref, t(b.phone || b.phone_number, 100), t(b.note, 140)]
    );
    notifyAdmin('new_deposit', 'Nouvelle recharge', method + ' • ' + amount + ' • ' + req.user.name, { deposit_id: q.rows[0].id });
    const d = depositOut(q.rows[0]);
    res.status(201).json({ deposit: d, data: d, message: 'Demann recharge voye pou verifikasyon.' });
  } catch (e) {
    if (e.code === '23505') bad(409, 'Kòd tranzaksyon sa a deja itilize.');
    throw e;
  }
}));

module.exports = router;
module.exports.depositOut = depositOut;
