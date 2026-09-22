require('dotenv').config();
const express      = require('express');
const BotManager   = require('./botManager');
const ProxyManager = require('./proxyManager');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const manager = new BotManager();

// Separate ProxyManager instance for on-demand key entry from UI
let uiProxyManager = null;

const auth = (req, res, next) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (process.env.ADMIN_KEY && key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ── Routes ────────────────────────────────────────────────────────
app.get('/status', auth, (req, res) => {
  res.json(manager.getStatus());
});

app.get('/accounts', auth, (req, res) => {
  res.json(manager.getAccounts());
});

app.post('/bot/create', auth, (req, res) => {
  const { count } = req.body;
  const result = manager.createBots(count || 1);
  res.json(result);
});

app.post('/bot/:id/kill', auth, (req, res) => {
  res.json(manager.killBot(req.params.id));
});

app.post('/bot/:id/chat', auth, (req, res) => {
  res.json(manager.sendChat(req.params.id, req.body.message));
});

app.get('/bot/:id/logs', auth, (req, res) => {
  res.json(manager.getLogs(req.params.id));
});

app.post('/killall', auth, (req, res) => {
  manager.killAll();
  res.json({ success: true });
});

// ── Proxy routes ──────────────────────────────────────────────────

// POST /proxy/init — called from UI when user saves Webshare API key
app.post('/proxy/init', auth, async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

  // Tear down old instance if re-keying
  if (uiProxyManager) uiProxyManager.stop();

  uiProxyManager = new ProxyManager(apiKey);
  try {
    await uiProxyManager.init();
    manager.proxyManager = uiProxyManager;          // hand live pool to BotManager
    manager._proxyReady  = Promise.resolve();       // already resolved
    res.json({ ok: true, pool: uiProxyManager.count() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /proxy/stats — live pool numbers for the UI badge
app.get('/proxy/stats', auth, (req, res) => {
  const pm = uiProxyManager || manager.proxyManager;
  if (!pm) return res.json({ pool: 0, total: 0, residential: 0, failed: 0, enabled: false });
  res.json({ enabled: true, ...pm.getStats() });
});

// ── Health / static ───────────────────────────────────────────────
app.get('/health', (req, res) => res.send('OK'));
app.get('/',       (req, res) => res.sendFile(__dirname + '/public/index.html'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[AppleMC BotManager] Running on port ${PORT}`);
});

// Self-ping for Replit free tier
if (process.env.REPLIT_URL) {
  const https = require('https');
  setInterval(() => {
    https.get(`${process.env.REPLIT_URL}/health`, () => {}).on('error', () => {});
  }, 240000);
}
