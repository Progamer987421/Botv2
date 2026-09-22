const mineflayer  = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const { SocksClient } = require('socks');
const { attachCaptchaSolver } = require('./captchaSolver');
const ProxyManager = require('./proxyManager');

const SERVER_HOST    = 'play.applemc.fun';
const SERVER_PORT    = 25565;
const SERVER_VERSION = '1.20.1';
const BOT_PASSWORD   = '231182';
const PASSWORD_DELAY = 3000; // ms after spawn before sending /register + /login

// ── Username generator ────────────────────────────────────────────
function randomUsername() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const len   = Math.floor(Math.random() * 6) + 6; // 6–11 chars
  let name    = '';
  // Ensure starts with a letter
  name += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
  for (let i = 1; i < len; i++) {
    name += chars[Math.floor(Math.random() * chars.length)];
  }
  return name;
}

class BotManager {
  constructor() {
    this.bots         = {};   // id -> mineflayer bot
    this.meta         = {};   // id -> metadata
    this.logs         = {};   // id -> string[]
    this.accounts     = {};   // id -> { username, password, created }
    this.timers       = {};   // id -> reconnect timer
    this.proxyManager = process.env.WEBSHARE_API_KEY
      ? new ProxyManager(process.env.WEBSHARE_API_KEY)
      : null;
    this._proxyReady  = this.proxyManager ? this.proxyManager.init() : Promise.resolve();
  }

  // ── Public: create N bots ─────────────────────────────────────
  createBots(count = 1) {
    const created = [];
    for (let i = 0; i < count; i++) {
      let username;
      do { username = randomUsername(); }
      while (Object.values(this.accounts).find(a => a.username === username));

      const id = `${username}`;
      this.accounts[id] = { username, password: BOT_PASSWORD, created: Date.now() };
      this.meta[id] = {
        username,
        status:           'connecting',
        created:          Date.now(),
        reconnects:       0,
        autoRejoin:       true,
        registered:       false,
        verificationKick: false,
        inBanana:         false,
        captchaPending:   false,
        proxy:            null,  // assigned at spawn time
      };
      this.logs[id] = [];

      // Wait for proxy list to be ready, then spawn
      this._proxyReady.then(() => this._spawnBot(id));
      created.push(id);
    }
    return { success: true, created };
  }

  // ── Spawn one bot ─────────────────────────────────────────────
  async _spawnBot(id) {
    const cfg = this.meta[id];
    if (!cfg) return;

    const { username } = this.accounts[id];

    // ── Proxy assignment ──────────────────────────────────────
    const proxy = this.proxyManager ? this.proxyManager.next() : null;
    this.meta[id].proxy = proxy;

    if (proxy) {
      this._log(id, `Connecting as ${username} via ${proxy.host}:${proxy.port} → ${SERVER_HOST}:${SERVER_PORT}`);
    } else {
      this._log(id, `Connecting as ${username} (no proxy) → ${SERVER_HOST}:${SERVER_PORT}`);
    }

    // ── Build SOCKS5 socket if proxy available ────────────────
    let connectFn = undefined;
    if (proxy) {
      connectFn = (client, setSocket) => {
        SocksClient.createConnection({
          proxy: {
            host:     proxy.host,
            port:     proxy.port,
            type:     5,
            userId:   proxy.username,
            password: proxy.password,
          },
          command:     'connect',
          destination: { host: SERVER_HOST, port: SERVER_PORT },
        })
        .then(({ socket }) => {
          setSocket(socket);
        })
        .catch(err => {
          this._log(id, `SOCKS5 error: ${err.message} — marking proxy dead, falling back to direct`);
          // Pull this proxy from the verified pool immediately
          if (this.proxyManager) this.proxyManager.markFailed(proxy.host, proxy.port);
          const net = require('net');
          setSocket(net.connect({ host: SERVER_HOST, port: SERVER_PORT }));
        });
      };
    }

    let bot;
    try {
      bot = mineflayer.createBot({
        host:                  SERVER_HOST,
        port:                  SERVER_PORT,
        username,
        version:               SERVER_VERSION,
        auth:                  'offline',
        checkTimeoutInterval:  30000,
        closeTimeout:          240,
        ...(connectFn ? { connect: connectFn } : {}),
      });
    } catch (err) {
      this._log(id, `Spawn error: ${err.message}`);
      this._scheduleReconnect(id);
      return;
    }

    bot.loadPlugin(pathfinder);

    // ── Captcha solver ─────────────────────────────────────────
    attachCaptchaSolver(bot, (msg) => this._log(id, `[CAPTCHA] ${msg}`), this.meta[id]);

    // ── Spawn ──────────────────────────────────────────────────
    bot.once('spawn', () => {
      this.meta[id].status           = 'verifying...';
      this.meta[id].verificationKick = false;
      this.meta[id].inBanana         = false;
      this._log(id, 'Spawned — passing bot-check, waiting...');

      // After bot-check phase the server kicks and lets real players back in.
      // We wait PASSWORD_DELAY ms for auth prompts — if we're still alive
      // past that, we're through the check and should auth + route.
      setTimeout(() => {
        if (!this.bots[id]) return;

        this.meta[id].status = 'authing';
        this._log(id, 'Bot-check passed — sending auth');

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
      }, PASSWORD_DELAY);
    });

    // ── Message listener — auth + routing ─────────────────────
    bot.on('message', (jsonMsg) => {
      const text = jsonMsg.toString();
      this._log(id, `[MSG] ${text}`);

      if (/already registered/i.test(text)) {
        this.meta[id].registered = true;
      }

      // Confirmed in — send /server banana once
      if (/logged in|successfully authenticated|you are now logged/i.test(text)) {
        this.meta[id].status = 'online ✓ auth';
        this._log(id, 'Authenticated — routing to banana');
        this._startAntiAFK(id, bot);

        if (!this.meta[id].inBanana) {
          this.meta[id].inBanana = true;
          setTimeout(() => {
            if (!this.bots[id]) return;
            bot.chat('/server banana');
            this._log(id, 'Sent /server banana');
            this.meta[id].status = 'online ✓ banana';
          }, 1000);
        }
      }

      if (/wrong password|incorrect password/i.test(text)) {
        this._log(id, 'Wrong password — killing bot');
        this.killBot(id);
      }

      // Some servers say "connecting to banana" then kick-to-transfer
      if (/connecting you to|sending you to|transferring/i.test(text)) {
        this._log(id, 'Server transfer in progress — will reconnect if needed');
        this.meta[id].verificationKick = true; // treat next disconnect as fast-rejoin
      }
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this._log(id, `<${username}> ${message}`);
    });

    bot.on('kicked', (reason) => {
      const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this._log(id, `Kicked: ${reasonStr}`);

      // Detect verification / bot-check kick patterns
      const isVerifyKick =
        this.meta[id].verificationKick ||
        /verify|bot.?check|captcha|not a bot|human|challenge|kicked for flying|moving too fast/i.test(reasonStr) ||
        // Very short sessions (under 6s) almost always mean a bot-check kick
        (Date.now() - (this.meta[id]._spawnTime || 0)) < 6000;

      if (isVerifyKick) {
        this.meta[id].status           = 'bot-check kick — rejoining';
        this.meta[id].verificationKick = false;
        this._cleanup(id);
        if (this.meta[id]?.autoRejoin) {
          const delay = this._randomDelay();
          this._log(id, `ANTIBOT kick — rejoining in ${(delay/1000).toFixed(1)}s`);
          this.meta[id].status = `antibot — rejoining in ${(delay/1000).toFixed(1)}s`;
          this.timers[id] = setTimeout(() => this._spawnBot(id), delay);
        }
      } else {
        this.meta[id].status = 'kicked';
        this._cleanup(id);
        if (this.meta[id]?.autoRejoin) this._scheduleReconnect(id);
      }
    });

    bot.on('end', (reason) => {
      this._log(id, `Disconnected: ${reason}`);
      const wasBananaTransfer = this.meta[id]?.inBanana &&
        (Date.now() - (this.meta[id]._spawnTime || 0)) < 15000;

      this.meta[id].inBanana = false;
      this._cleanup(id);

      if (this.meta[id]?.autoRejoin) {
        if (wasBananaTransfer) {
          const delay = this._randomDelay();
          this._log(id, `Server transfer — rejoining in ${(delay/1000).toFixed(1)}s`);
          this.meta[id].status = `transferring — rejoining in ${(delay/1000).toFixed(1)}s`;
          this.timers[id] = setTimeout(() => this._spawnBot(id), delay);
        } else {
          this._scheduleReconnect(id);
        }
      }
    });

    bot.on('error', (err) => {
      this._log(id, `Error: ${err.message}`);
    });

    bot.on('death', () => {
      this._log(id, 'Died — respawning');
      try { bot.respawn(); } catch (_) {}
    });

    this.meta[id]._spawnTime = Date.now();
    this.bots[id] = bot;
  }

  // ── Anti-AFK ─────────────────────────────────────────────────
  _startAntiAFK(id, bot) {
    let tick = 0;
    const iv = setInterval(() => {
      if (!this.bots[id]) { clearInterval(iv); return; }
      tick++;

      // Random look every 30s
      if (tick % 6 === 0) {
        bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.8, false);
      }

      // Short walk every 2min
      if (tick % 24 === 0) {
        const pos = bot.entity?.position;
        if (pos) {
          const dx = Math.floor((Math.random() - 0.5) * 8);
          const dz = Math.floor((Math.random() - 0.5) * 8);
          try {
            const mcData   = require('minecraft-data')(bot.version);
            const movements = new Movements(bot, mcData);
            bot.pathfinder.setMovements(movements);
            bot.pathfinder.setGoal(new GoalBlock(
              Math.floor(pos.x) + dx,
              Math.floor(pos.y),
              Math.floor(pos.z) + dz
            ));
          } catch (_) {}
        }
      }

      // Sneak toggle every 5min
      if (tick % 60 === 0) {
        bot.setControlState('sneak', true);
        setTimeout(() => { if (this.bots[id]) bot.setControlState('sneak', false); }, 1500);
      }
    }, 5000);
  }

  // Random delay between 5s and 10s
  _randomDelay() {
    return Math.floor(Math.random() * 5000) + 5000;
  }

  // ── Reconnect ─────────────────────────────────────────────────
  _scheduleReconnect(id) {
    if (!this.meta[id]) return;
    const delay = Math.min(5000 * Math.pow(1.5, this.meta[id].reconnects), 60000);
    this.meta[id].reconnects++;
    this.meta[id].inBanana        = false;
    this.meta[id].captchaPending  = false;
    this.meta[id].status   = `reconnecting (${Math.round(delay / 1000)}s)`;
    this._log(id, `Reconnecting in ${Math.round(delay / 1000)}s`);
    this.timers[id] = setTimeout(() => this._spawnBot(id), delay);
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

  // ── Getters ───────────────────────────────────────────────────
  getAccounts() {
    return Object.entries(this.accounts).map(([id, a]) => ({
      id,
      username:   a.username,
      password:   a.password,
      created:    new Date(a.created).toISOString(),
      online:     !!this.bots[id],
      status:     this.meta[id]?.status || 'unknown',
      reconnects: this.meta[id]?.reconnects || 0,
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
    if (!this.proxyManager) return { enabled: false };
    return {
      enabled: true,
      ...this.proxyManager.getStats(),
    };
  }

  getLogs(id) {
    if (!this.meta[id]) return { error: 'Not found' };
    return { id, logs: this.logs[id].slice(-100) };
  }

  // ── Internal ──────────────────────────────────────────────────
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
