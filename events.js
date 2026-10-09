'use strict';
// Blocages, alertes sécurité, journal d'audit, notifications admin
const { pool } = require('./db');
const { clientIp } = require('./utils');

const blocked = new Set();
const key = (kind, value) => kind + ':' + String(value == null ? '' : value).toLowerCase();
const isBlocked = (kind, value) => blocked.has(key(kind, value));

async function refreshBlocks() {
  try {
    const q = await pool.query('SELECT kind,value FROM security_blocks');
    blocked.clear();
    q.rows.forEach(r => blocked.add(key(r.kind, r.value)));
  } catch (e) { console.error('[blocks]', e.message); }
}

function logSecurity(type, severity, req, details) {
  pool.query(
    'INSERT INTO security_events(type,severity,ip,user_id,path,details) VALUES($1,$2,$3,$4,$5,$6)',
    [type, severity, clientIp(req), req.user ? String(req.user.id) : null, String(req.originalUrl || '').slice(0, 300), JSON.stringify(details || {})]
  ).catch(() => {});
}

function audit(req, action, message, details) {
  pool.query(
    'INSERT INTO audit_logs(admin_id,admin,action,message,details,ip) VALUES($1,$2,$3,$4,$5,$6)',
    [req.user ? req.user.id : null, req.user ? (req.user.email || req.user.phone || '') : '', String(action).slice(0, 120), String(message || '').slice(0, 500), JSON.stringify(details || {}), clientIp(req)]
  ).catch(() => {});
}

function notifyAdmin(type, title, message, payload) {
  pool.query(
    'INSERT INTO admin_notifications(type,title,message,payload) VALUES($1,$2,$3,$4)',
    [String(type).slice(0, 40), String(title).slice(0, 200), String(message).slice(0, 500), JSON.stringify(payload || {})]
  ).catch(() => {});
}

function notifyUser(userId, title, message, client) {
  return (client || pool).query('INSERT INTO notifications(user_id,title,message) VALUES($1,$2,$3)', [userId, title, message]);
}

async function getSetting(k, fallback) {
  const q = await pool.query('SELECT value FROM app_settings WHERE key=$1', [k]);
  return q.rowCount ? q.rows[0].value : fallback;
}
async function setSetting(k, value) {
  await pool.query(
    'INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()',
    [k, JSON.stringify(value)]
  );
}

module.exports = { isBlocked, refreshBlocks, logSecurity, audit, notifyAdmin, notifyUser, getSetting, setSetting };
