require('dotenv').config();

// Prevent any stray unhandled promise rejection from crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNCAUGHT] Unhandled promise rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT] Exception:', err.message);
});
const express      = require('express');
const BotManager   = require('./botManager');
const ProxyManager = require('./proxyManager');

const app     = express();
const PORT    = process.env.PORT || 3000;
const manager = new BotManager();

app.use(express.json());
app.use(express.static('public'));

// ── Auth middleware ───────────────────────────────────────────────
const auth = (req, res, next) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (process.env.ADMIN_KEY && key !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ── Bot routes ────────────────────────────────────────────────────
app.get('/status',        auth, (req, res) => res.json(manager.getStatus()));
app.get('/accounts',      auth, (req, res) => res.json(manager.getAccounts()));

app.post('/bot/create',   auth, (req, res) => res.json(manager.createBots(req.body.count || 1)));
app.post('/killall',      auth, (req, res) => { manager.killAll(); res.json({ success: true }); });

app.post('/bot/:id/kill', auth, (req, res) => res.json(manager.killBot(req.params.id)));
app.post('/bot/:id/chat', auth, (req, res) => res.json(manager.sendChat(req.params.id, req.body.message)));
app.get('/bot/:id/logs',  auth, (req, res) => res.json(manager.getLogs(req.params.id)));

// Custom command
app.post('/bot/:id/cmd',     auth, (req, res) => {
  if (!req.body.cmd) return res.status(400).json({ error: 'cmd required' });
  res.json(manager.runCommand(req.params.id, req.body.cmd));
});

// Captcha image fetch
app.get('/bot/:id/captcha',  auth, (req, res) => res.json(manager.getCaptchaImage(req.params.id)));

// ── Custom account routes ────────────────────────────────────────
app.post('/account/add', auth, (req, res) => {
  const { username, password } = req.body;
  res.json(manager.addCustomAccount(username, password));
});

app.post('/account/:id/connect', auth, (req, res) => {
  res.json(manager.connectCustomAccount(req.params.id));
});

app.delete('/account/:id', auth, (req, res) => {
  res.json(manager.removeCustomAccount(req.params.id));
});

// ── Proxy routes ──────────────────────────────────────────────────

// Webshare pool
app.post('/proxy/init', auth, async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
  try {
    const pm = new ProxyManager(apiKey);
    await pm.init();
    manager.proxyManager = pm;
    manager._proxyReady  = Promise.resolve();
    res.json({ ok: true, pool: pm.count() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Single custom proxy — stored directly on manager, takes priority
app.post('/proxy/custom', auth, (req, res) => {
  const { proxy } = req.body;
  if (proxy === undefined) return res.status(400).json({ error: 'proxy required' });
  const result = manager.setStaticProxy(proxy || null);
  res.json(result);
});

// Stats
app.get('/proxy/stats', auth, (req, res) => res.json(manager.getProxyStats()));

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.send('OK'));
app.get('/',       (_, res) => res.sendFile(__dirname + '/public/index.html'));

app.listen(PORT, '0.0.0.0', () => console.log(`[AppleMC] Running on :${PORT}`));

// Replit keep-alive
if (process.env.REPLIT_URL) {
  const https = require('https');
  setInterval(() => https.get(`${process.env.REPLIT_URL}/health`, () => {}).on('error', () => {}), 240000);
}
