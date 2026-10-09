'use strict';
require('dotenv').config();

const list = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);

module.exports = {
  port: Number(process.env.PORT || 10000),
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: process.env.DATABASE_SSL === 'true',
  jwtSecret: process.env.JWT_SECRET || '',
  adminEmails: new Set(list(process.env.ADMIN_EMAILS).map(x => x.toLowerCase())),
  clientOrigins: list(process.env.CLIENT_ORIGIN || '*'),
  maxUploadMb: Math.max(1, Number(process.env.MAX_UPLOAD_MB || 80)),
  // STRICT_PRICES=true : une commande doit correspondre à un pack existant en base (prix serveur obligatoire)
  strictPrices: process.env.STRICT_PRICES === 'true',
  imagekit: {
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY || '',
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY || '',
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || ''
  },
  defaults: {
    moncash: process.env.MONCASH_NUMBER || '',
    natcash: process.env.NATCASH_NUMBER || '',
    whatsapp: process.env.WHATSAPP_NUMBER || ''
  },
  limits: { minDeposit: 1, maxDeposit: 500000, maxPendingDeposits: 20 }
};
