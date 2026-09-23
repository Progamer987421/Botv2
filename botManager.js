const mineflayer  = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const { SocksClient } = require('socks');
const ProxyManager = require('./proxyManager');

const SERVER_HOST    = 'play.applemc.fun';
const SERVER_PORT    = 25565;
const SERVER_VERSION = '1.20.1';
const BOT_PASSWORD   = '231182';
const AUTH_DELAY     = 3500; // ms after spawn before sending auth

// ── Username generator ────────────────────────────────────────────
function randomUsername() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const len   = Math.floor(Math.random() * 6) + 6;
  let name    = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
  for (let i = 1; i < len; i++) name += chars[Math.floor(Math.random() * chars.length)];
  return name;
}

class BotManager {
  constructor() {
    this.bots         = {};
    this.meta         = {};
    this.logs         = {};
    this.accounts     = {};
    this.timers       = {};

    // Single static proxy — set via UI, takes priority over ProxyManager pool
    this.staticProxy  = null;

    this.proxyManager = process.env.WEBSHARE_API_KEY
      ? new ProxyManager(process.env.WEBSHARE_API_KEY)
      : null;
    this._proxyReady  = this.proxyManager ? this.proxyManager.init() : Promise.resolve();
  }

  // ── Static proxy ──────────────────────────────────────────────
  setStaticProxy(proxyStr) {
    if (!proxyStr) { this.staticProxy = null; return { ok: true, msg: 'Proxy cleared' }; }
    try {
      this.staticProxy = ProxyManager._parseProxyString(proxyStr);
      return { ok: true, host: this.staticProxy.host, port: this.staticProxy.port };
    } catch (e) {
      return { error: e.message };
    }
  }

  _getProxy() {
    if (this.staticProxy) return this.staticProxy;
    if (this.proxyManager) return this.proxyManager.next();
    return null;
  }

  // ── Create bots ───────────────────────────────────────────────
  createBots(count = 1) {
    const created = [];
    for (let i = 0; i < count; i++) {
      let username;
      do { username = randomUsername(); }
      while (Object.values(this.accounts).find(a => a.username === username));

      const id = username;
      this.accounts[id] = { username, password: BOT_PASSWORD, created: Date.now() };
      this.meta[id] = {
        username,
        status:           'connecting',
        created:          Date.now(),
        reconnects:       0,
        autoRejoin:       false,  // MANUAL only — use /reconnect from UI
        registered:       false,
        verificationKick: false,
        inBanana:         false,
        captchaPending:   false,
        antiBotLocked:    false,
        captchaImage:     null,
        proxy:            null,
        _spawnTime:       0,
      };
      this.logs[id] = [];
      this._proxyReady
        .then(() => this._spawnBot(id))
        .catch(err => this._log(id, `Spawn chain error: ${err.message}`));
      created.push(id);
    }
    return { success: true, created };
  }

  // ── Spawn ─────────────────────────────────────────────────────
  async _spawnBot(id) {
    try {
    if (!this.meta[id]) return;
    const { username } = this.accounts[id];
    const proxy = this._getProxy();
    this.meta[id].proxy = proxy;

    this._log(id, proxy
      ? `Connecting as ${username} via ${proxy.host}:${proxy.port}`
      : `Connecting as ${username} (no proxy)`);

    // Pre-create SOCKS5 socket, hand it to mineflayer via stream option
    let proxyStream = null;
    if (proxy) {
      try {
        const { socket } = await SocksClient.createConnection({
          proxy: {
            host:     proxy.host,
            port:     proxy.port,
            type:     5,
            userId:   proxy.username,
            password: proxy.password,
          },
          command:     'connect',
          destination: { host: SERVER_HOST, port: SERVER_PORT },
        });
        proxyStream = socket;
        this._log(id, `SOCKS5 tunnel established via ${proxy.host}:${proxy.port}`);
      } catch (err) {
        this._log(id, `SOCKS5 error: ${err.message} — direct fallback`);
        if (this.proxyManager && !this.staticProxy) this.proxyManager.markFailed(proxy.host, proxy.port);
        // proxyStream stays null, mineflayer connects direct
      }
    }

    let bot;
    try {
      bot = mineflayer.createBot({
        host:                 SERVER_HOST,
        port:                 SERVER_PORT,
        username,
        version:              SERVER_VERSION,
        auth:                 'offline',
        checkTimeoutInterval: 30000,
        closeTimeout:         240,
        ...(proxyStream ? { stream: proxyStream } : {}),
      });
    } catch (err) {
      this._log(id, `Spawn error: ${err.message}`);
      if (proxyStream) { try { proxyStream.destroy(); } catch (_) {} }
      this._scheduleReconnect(id);
      return;
    }

    bot.loadPlugin(pathfinder);
    // No auto captcha solver — enter captcha manually via UI

    // ── Spawn event — LOCK movement immediately ────────────────
    bot.once('spawn', () => {
      this.meta[id].status        = 'verifying...';
      this.meta[id].antiBotLocked = true;
      this.meta[id]._spawnTime    = Date.now();
      this._log(id, 'Spawned — movement LOCKED, waiting for ANTIBOT clearance');

      // Zero all controls
      ['forward','back','left','right','jump','sneak','sprint'].forEach(k => {
        try { bot.setControlState(k, false); } catch (_) {}
      });
      try { bot.pathfinder.setGoal(null); } catch (_) {}

      // Wait then auth — only if ANTIBOT hasn't kicked us first
      setTimeout(() => {
        if (!this.bots[id]) return;
        this.meta[id].status = 'authing';
        this._log(id, 'Auth delay elapsed — sending credentials');
        if (!this.meta[id].registered) {
          bot.chat(`/register ${BOT_PASSWORD} ${BOT_PASSWORD}`);
          this._log(id, 'Sent /register');
          this.meta[id].registered = true;
          setTimeout(() => {
            if (!this.bots[id]) return;
            bot.chat(`/login ${BOT_PASSWORD}`);
            this._log(id, 'Sent /login');
          }, 1500);
        } else {
          bot.chat(`/login ${BOT_PASSWORD}`);
          this._log(id, 'Sent /login');
        }
      }, AUTH_DELAY);
    });

    // ── Message listener ──────────────────────────────────────
    bot.on('message', (jsonMsg) => {
      const text = jsonMsg.toString();
      this._log(id, `[MSG] ${text}`);

      if (/already registered/i.test(text)) this.meta[id].registered = true;

      // ANTIBOT "stand still" — re-enforce lock
      if (/do not move|please do not move|stand still|don.t move/i.test(text)) {
        this.meta[id].antiBotLocked = true;
        ['forward','back','left','right','jump','sneak','sprint'].forEach(k => {
          try { bot.setControlState(k, false); } catch (_) {}
        });
        try { bot.pathfinder.setGoal(null); } catch (_) {}
        this._log(id, 'ANTIBOT: movement lock confirmed');
      }

      // ANTIBOT clear
      if (this.meta[id].antiBotLocked &&
          /verified|you have passed|verification (complete|passed|successful)|you may (now )?move|bot.?check passed/i.test(text)) {
        this.meta[id].antiBotLocked = false;
        this._log(id, 'ANTIBOT: cleared — movement unlocked');
      }

      // Auth success — stand still, DO NOT route to /server banana automatically
      if (/logged in|successfully authenticated|you are now logged/i.test(text)) {
        this.meta[id].status = 'online ✓';
        this._log(id, 'Authenticated — bot standing still (no auto-routing)');
        // No /server banana. No anti-AFK walk. Bot just stands.
      }

      if (/wrong password|incorrect password/i.test(text)) {
        this._log(id, 'Wrong password — killing bot');
        this.killBot(id);
      }

      if (/connecting you to|sending you to|transferring/i.test(text)) {
        this.meta[id].verificationKick = true;
        this._log(id, 'Server transfer detected');
      }
    });

    bot.on('chat', (uname, message) => {
      if (uname === bot.username) return;
      this._log(id, `<${uname}> ${message}`);
    });

    bot.on('kicked', (reason) => {
      const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this._log(id, `Kicked: ${r}`);
      // Never auto-reconnect — user must hit /reconnect from UI
      const isVerify = /verify|bot.?check|captcha|not a bot|human|challenge|failed the bot/i.test(r);
      this.meta[id].status = isVerify ? 'kicked — ANTIBOT (reconnect manually)' : 'kicked (reconnect manually)';
      this.meta[id].verificationKick = false;
      this.meta[id].captchaImage = null;
      this._cleanup(id);
    });

    bot.on('end', (reason) => {
      this._log(id, `Disconnected: ${reason}`);
      this.meta[id].inBanana = false;
      this._cleanup(id);
      // Never auto-reconnect — user must hit /reconnect from UI
      if (this.meta[id]) this.meta[id].status = 'disconnected (reconnect manually)';
    });

    bot.on('error', (err) => this._log(id, `Error: ${err.message}`));

    bot.on('death', () => {
      this._log(id, 'Died — respawning');
      try { bot.respawn(); } catch (_) {}
    });

    this.meta[id]._spawnTime = Date.now();
    this.bots[id] = bot;
    } catch (err) {
      this._log(id, `_spawnBot uncaught: ${err.message}`);
      if (this.meta[id]) this.meta[id].status = 'error — reconnect manually';
    }
  }

  // ── Commands ──────────────────────────────────────────────────
  runCommand(id, cmd) {
    if (!this.meta[id]) return { error: 'Bot not found' };
    const bot = this.bots[id];
    cmd = cmd.trim();

    switch (cmd) {
      case '/freeze':
        this.meta[id].antiBotLocked = true;
        if (bot) ['forward','back','left','right','jump','sneak','sprint'].forEach(k => {
          try { bot.setControlState(k, false); } catch (_) {}
        });
        return { ok: true, msg: 'Bot frozen' };

      case '/unfreeze':
        this.meta[id].antiBotLocked = false;
        return { ok: true, msg: 'Bot unfrozen' };

      case '/respawn':
        try { if (bot) bot.respawn(); return { ok: true, msg: 'Respawned' }; }
        catch (e) { return { error: e.message }; }

      case '/look_random':
        try {
          if (bot) bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.8, false);
          return { ok: true, msg: 'Looked' };
        } catch (e) { return { error: e.message }; }

      case '/reconnect':
        this.meta[id].autoRejoin = true;
        if (this.bots[id]) { try { this.bots[id].quit(); } catch (_) {} }
        this._cleanup(id);
        setTimeout(() => this._spawnBot(id), 1000);
        return { ok: true, msg: 'Reconnecting...' };

      case '/status':
        return { ok: true, msg: `status=${this.meta[id].status} | locked=${this.meta[id].antiBotLocked} | proxy=${this.meta[id].proxy ? this.meta[id].proxy.host + ':' + this.meta[id].proxy.port : 'direct'}` };
    }

    // Any other /command or message — send to server
    if (!bot) return { error: 'Bot not online' };
    try {
      bot.chat(cmd);
      this._log(id, `[CMD] ${cmd}`);
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  }

  getCaptchaImage(id) {
    if (!this.meta[id]) return { error: 'Bot not found' };
    return { image: this.meta[id].captchaImage || null };
  }

  // ── Getters ───────────────────────────────────────────────────
  getAccounts() {
    return Object.entries(this.accounts).map(([id, a]) => ({
      id,
      username:      a.username,
      password:      a.password,
      created:       new Date(a.created).toISOString(),
      online:        !!this.bots[id],
      status:        this.meta[id]?.status || 'unknown',
      reconnects:    this.meta[id]?.reconnects || 0,
      captchaImage:  this.meta[id]?.captchaImage || null,
      antiBotLocked: this.meta[id]?.antiBotLocked || false,
      uptime:        Math.floor((Date.now() - (this.meta[id]?.created || Date.now())) / 1000),
    }));
  }

  getStatus() {
    return Object.entries(this.meta).map(([id, m]) => ({
      id,
      username:   m.username,
      status:     m.status,
      uptime:     Math.floor((Date.now() - m.created) / 1000),
      reconnects: m.reconnects,
      online:     !!this.bots[id],
      registered: m.registered,
      proxy:      m.proxy ? `${m.proxy.host}:${m.proxy.port}` : 'direct',
    }));
  }

  getProxyStats() {
    if (this.staticProxy) {
      return { enabled: true, mode: 'static', host: this.staticProxy.host, port: this.staticProxy.port, pool: 1, total: 1, residential: 0, failed: 0 };
    }
    if (!this.proxyManager) return { enabled: false };
    return { enabled: true, mode: 'webshare', ...this.proxyManager.getStats() };
  }

  getLogs(id) {
    if (!this.meta[id]) return { error: 'Not found' };
    return { id, logs: this.logs[id].slice(-150) };
  }

  // ── Control ───────────────────────────────────────────────────
  killBot(id) {
    if (!this.meta[id]) return { error: 'Not found' };
    this.meta[id].autoRejoin = false;
    clearTimeout(this.timers[id]);
    if (this.bots[id]) { try { this.bots[id].quit(); } catch (_) {} }
    this._cleanup(id);
    this.meta[id].status = 'killed';
    return { success: true };
  }

  killAll() {
    Object.keys(this.meta).forEach(id => {
      this.meta[id].autoRejoin = false;
      clearTimeout(this.timers[id]);
      if (this.bots[id]) { try { this.bots[id].quit(); } catch (_) {} }
      this._cleanup(id);
      this.meta[id].status = 'killed';
    });
  }

  sendChat(id, message) {
    if (!this.bots[id]) return { error: 'Bot not online' };
    if (!message) return { error: 'message required' };
    this.bots[id].chat(message);
    return { success: true };
  }

  // ── Internal ──────────────────────────────────────────────────
  _scheduleReconnect(id) {
    if (!this.meta[id]) return;
    const delay = Math.min(5000 * Math.pow(1.5, this.meta[id].reconnects), 60000);
    this.meta[id].reconnects++;
    this.meta[id].captchaPending = false;
    this.meta[id].status = `reconnecting (${Math.round(delay / 1000)}s)`;
    this._log(id, `Reconnecting in ${Math.round(delay / 1000)}s`);
    this.timers[id] = setTimeout(() => this._spawnBot(id), delay);
  }

  _randomDelay() { return Math.floor(Math.random() * 5000) + 6000; }

  _cleanup(id) { delete this.bots[id]; }

  _log(id, msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(`[${id}] ${msg}`);
    if (!this.logs[id]) this.logs[id] = [];
    this.logs[id].push(line);
    if (this.logs[id].length > 500) this.logs[id].shift();
  }
}

module.exports = BotManager;
