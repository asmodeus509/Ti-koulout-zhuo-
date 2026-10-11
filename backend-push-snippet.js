// === FLEX TUPUP — Push notifications (backend Node/Express) ===
// 1) npm i web-push
// 2) npx web-push generate-vapid-keys   -> mete VAPID_PUBLIC / VAPID_PRIVATE nan variab anviwonman Render
// 3) kole kòd sa a nan backend la (adapte `auth` ak `db` ak sistèm ou a)
const webpush = require('web-push');
webpush.setVapidDetails('mailto:ou@example.com', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

const subs = new Map(); // userId -> [subscription]  (METE NAN DATABASE pou l pa pèdi lè Render rdemare)

app.get('/api/push/public-key', (req, res) => res.json({ publicKey: process.env.VAPID_PUBLIC }));

app.post('/api/push/subscribe', auth, (req, res) => {
  const list = subs.get(req.user.id) || [];
  if (!list.some(s => s.endpoint === req.body.endpoint)) list.push(req.body);
  subs.set(req.user.id, list);
  res.json({ ok: true });
});

async function pushToUser(userId, title, body) {
  for (const s of subs.get(userId) || []) {
    try { await webpush.sendNotification(s, JSON.stringify({ title, body })); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { /* abònman ekspire: retire l */ } }
  }
}

// Rele sa lè admin valide:
//   apre konfime yon depo wallet:  pushToUser(deposit.user_id, 'Wallet ou valide 🎉', `+${deposit.amount} HTG`);
//   apre valide/refize yon komand: pushToUser(order.user_id,  'Komand ou valide ✅', `${order.game} • ${order.pack}`);

// Wout piblik pou foto Home (menm done ak PUT /api/admin/media):
// app.get('/api/media', (req, res) => res.json(db.media));   // { home, games }
