'use strict';
const cfg = require('./config');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { init } = require('./db');
const { refreshBlocks } = require('./events');
const { HttpError } = require('./utils');
const mw = require('./middleware');

const app = express();
app.set('trust proxy', 1);            // Render est derrière un proxy : vraie IP du client
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: (origin, cb) =>
    !origin || cfg.clientOrigins.includes('*') || cfg.clientOrigins.includes(origin)
      ? cb(null, true)
      : cb(new HttpError(403, 'Origin not allowed by CLIENT_ORIGIN'))
}));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));
app.use(mw.ipBlock);

const health = (req, res) => res.json({ ok: true, service: 'flex-tupup-backend', version: '2.0.0', time: new Date().toISOString() });
app.get(['/', '/health', '/api/health'], health);

app.use('/api', mw.activityLog);
app.use(['/api/auth/login', '/api/login', '/api/admin/login', '/api/auth/register'], mw.authLimiter);

// Routes publiques + client
app.use('/api', require('./routes-auth'));
app.use('/api', require('./routes-wallet'));
app.use('/api', require('./routes-shop'));
// Routes admin : toutes protégées (connexion + email dans ADMIN_EMAILS)
app.use('/api/admin', mw.auth, mw.adminOnly, require('./routes-admin'), require('./routes-admin-ops'));

app.use((req, res) => res.status(404).json({ error: 'Route API introuvable.', path: req.path }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || (err.type === 'entity.too.large' ? 413 : err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error('[API]', err.stack || err.message);
  const msg = status === 500 ? 'Erreur interne du serveur.' : err.message;
  res.status(status).json({ error: msg, message: msg });
});

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.message));

init()
  .then(refreshBlocks)
  .then(() => app.listen(cfg.port, '0.0.0.0', () => console.log('Flex Tupup API v2 running on port ' + cfg.port)))
  .catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
