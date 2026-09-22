/**
 * proxyManager.js
 * Fetches, filters (residential only), verifies, and rotates Webshare proxies.
 * Requires: WEBSHARE_API_KEY in .env
 *
 * Webshare proxy_type values: "residential" | "datacenter" | "isp"
 * Only "residential" proxies pass the filter.
 * Each proxy is verified via a live SOCKS5 connection before entering rotation.
 */

const https        = require('https');
const net          = require('net');
const { SocksClient } = require('socks');

const WEBSHARE_API   = 'proxy.webshare.io';
const LIST_PATH      = '/api/v2/proxy/list/?mode=direct&page=1&page_size=250';
const REFRESH_MS     = 10 * 60 * 1000;  // re-fetch list every 10 min
const VERIFY_TIMEOUT = 8000;            // ms per proxy verification attempt
const VERIFY_HOST    = 'checkip.amazonaws.com';
const VERIFY_PORT    = 80;
const MAX_VERIFY_CONCURRENCY = 20;      // parallel verification slots

class ProxyManager {
  /**
   * Two modes:
   *   new ProxyManager(apiKey)          — Webshare rotation pool (original behaviour)
   *   ProxyManager.fromSingle(proxyStr) — single static proxy, no API key needed
   *
   * proxyStr format (SOCKS5 or HTTP):
   *   socks5://user:pass@host:port
   *   http://user:pass@host:port
   *   host:port                         (unauthenticated)
   *   host:port:user:pass               (colon-delimited shorthand)
   */
  constructor(apiKey) {
    if (!apiKey) throw new Error('[ProxyManager] WEBSHARE_API_KEY is required');
    this.apiKey     = apiKey;
    this._static    = false;

    this.verified   = [];
    this.failed     = new Set();
    this.cursor     = 0;
    this._refreshTimer = null;
    this.stats = { total: 0, residential: 0, verified: 0, failed: 0 };
  }

  // ── Static single-proxy factory ───────────────────────────────
  static fromSingle(proxyStr) {
    if (!proxyStr || typeof proxyStr !== 'string') {
      throw new Error('[ProxyManager] proxyStr is required for single-proxy mode');
    }

    const instance = Object.create(ProxyManager.prototype);
    instance.apiKey          = null;
    instance._static         = true;
    instance.failed          = new Set();
    instance.cursor          = 0;
    instance._refreshTimer   = null;
    instance.stats           = { total: 1, residential: 1, verified: 0, failed: 0 };

    const parsed = ProxyManager._parseProxyString(proxyStr);
    instance.verified = [];           // filled in init()
    instance._staticProxy = parsed;   // stash for verification
    return instance;
  }

  // ── Parse proxy string into { host, port, username, password } ─
  static _parseProxyString(str) {
    str = str.trim();

    // URI form: socks5://user:pass@host:port  or  http://user:pass@host:port
    if (/^(socks5?|https?):\/\//i.test(str)) {
      const url = new URL(str);
      return {
        host:     url.hostname,
        port:     parseInt(url.port, 10),
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        proxy_type: 'custom',
        latency:  0,
      };
    }

    // Colon-delimited: host:port  or  host:port:user:pass
    const parts = str.split(':');
    if (parts.length === 2) {
      return { host: parts[0], port: parseInt(parts[1], 10), proxy_type: 'custom', latency: 0 };
    }
    if (parts.length === 4) {
      return { host: parts[0], port: parseInt(parts[1], 10), username: parts[2], password: parts[3], proxy_type: 'custom', latency: 0 };
    }

    throw new Error(`[ProxyManager] Cannot parse proxy string: "${str}"`);
  }

  // ── Boot ──────────────────────────────────────────────────────
  async init() {
    if (this._static) {
      // Verify the single proxy and load it if it passes; load it unconditionally if verify fails (let bot report it)
      const result = await this._verifyProxy(this._staticProxy);
      if (result.ok) {
        this.verified = [result.proxy];
        this.stats.verified = 1;
        console.log(`[ProxyManager] Single proxy verified — ${this._staticProxy.host}:${this._staticProxy.port}`);
      } else {
        // Still put it in the pool — bot will surface the error naturally
        this.verified = [{ ...this._staticProxy, latency: 9999 }];
        this.stats.verified = 1;
        console.warn(`[ProxyManager] Single proxy failed verification (${result.reason}) — loading anyway`);
      }
      return;
    }

    await this._fetchAndVerify();
    this._refreshTimer = setInterval(() => this._fetchAndVerify(), REFRESH_MS);
    console.log(`[ProxyManager] Ready — ${this.verified.length} residential verified proxies`);
  }

  // ── Round-robin, verified pool only ──────────────────────────
  next() {
    if (this.verified.length === 0) return null;
    const proxy = this.verified[this.cursor % this.verified.length];
    this.cursor++;
    return proxy;
  }

  count()    { return this.verified.length; }
  getStats() { return { ...this.stats, pool: this.verified.length }; }

  // ── Fetch → filter → verify pipeline ─────────────────────────
  async _fetchAndVerify() {
    const raw = await this._fetchProxies();
    if (!raw.length) return;

    this.stats.total = raw.length;

    // Step 1: residential filter
    const residential = raw.filter(p =>
      typeof p.proxy_type === 'string' &&
      p.proxy_type.toLowerCase() === 'residential'
    );
    this.stats.residential = residential.length;

    console.log(`[ProxyManager] ${raw.length} total → ${residential.length} residential`);

    // Step 2: skip known-failed, verify rest in parallel batches
    const toVerify = residential.filter(p => !this.failed.has(`${p.host}:${p.port}`));
    const results  = await this._verifyBatch(toVerify);

    // Step 3: rebuild verified pool, sort by latency ascending
    const fresh = results.filter(r => r.ok).map(r => r.proxy);
    fresh.sort((a, b) => a.latency - b.latency);

    this.verified       = fresh;
    this.stats.verified = fresh.length;
    this.stats.failed   = this.failed.size;

    // Reset cursor so round-robin doesn't OOB after pool shrinks
    this.cursor = 0;

    console.log(`[ProxyManager] Verified pool: ${this.verified.length} proxies | Failed: ${this.failed.size}`);
  }

  // ── Parallel verification with concurrency cap ────────────────
  async _verifyBatch(proxies) {
    const results = [];
    let   i       = 0;

    const worker = async () => {
      while (i < proxies.length) {
        const proxy = proxies[i++];
        const result = await this._verifyProxy(proxy);
        results.push(result);
        if (!result.ok) {
          this.failed.add(`${proxy.host}:${proxy.port}`);
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(MAX_VERIFY_CONCURRENCY, proxies.length || 1) },
      () => worker()
    );
    await Promise.all(workers);
    return results;
  }

  // ── Single proxy verification via SOCKS5 ─────────────────────
  _verifyProxy(proxy) {
    return new Promise((resolve) => {
      const start = Date.now();
      const key   = `${proxy.host}:${proxy.port}`;

      const timeout = setTimeout(() => {
        resolve({ ok: false, proxy, reason: 'timeout' });
      }, VERIFY_TIMEOUT);

      SocksClient.createConnection({
        proxy: {
          host:     proxy.host,
          port:     proxy.port,
          type:     5,
          userId:   proxy.username,
          password: proxy.password,
        },
        command:     'connect',
        destination: { host: VERIFY_HOST, port: VERIFY_PORT },
        timeout:     VERIFY_TIMEOUT,
      })
      .then(({ socket }) => {
        clearTimeout(timeout);
        const latency = Date.now() - start;
        socket.destroy();

        console.log(`[ProxyManager] ✓ ${key} (${latency}ms, ${proxy.proxy_type})`);
        resolve({ ok: true, proxy: { ...proxy, latency } });
      })
      .catch((err) => {
        clearTimeout(timeout);
        console.log(`[ProxyManager] ✗ ${key} — ${err.message}`);
        resolve({ ok: false, proxy, reason: err.message });
      });
    });
  }

  // ── Webshare REST: GET proxy list ─────────────────────────────
  _fetchProxies() {
    return new Promise((resolve) => {
      const options = {
        hostname: WEBSHARE_API,
        path:     LIST_PATH,
        method:   'GET',
        headers:  { Authorization: `Token ${this.apiKey}` },
      };

      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            if (!json.results || !Array.isArray(json.results)) {
              console.error('[ProxyManager] Unexpected API shape:', raw.slice(0, 300));
              return resolve([]);
            }
            const proxies = json.results.map(p => ({
              host:       p.proxy_address,
              port:       p.port,
              username:   p.username,
              password:   p.password,
              proxy_type: p.proxy_type || 'unknown',  // "residential"|"datacenter"|"isp"
              country:    p.country_code || '??',
            }));
            resolve(proxies);
          } catch (e) {
            console.error('[ProxyManager] Parse error:', e.message);
            resolve([]);
          }
        });
      });

      req.on('error', (err) => {
        console.error('[ProxyManager] Fetch error:', err.message);
        resolve([]);
      });

      req.end();
    });
  }

  // ── Mark a proxy as bad mid-session (called by botManager on SOCKS fail) ──
  markFailed(host, port) {
    const key = `${host}:${port}`;
    this.failed.add(key);
    this.verified = this.verified.filter(p => `${p.host}:${p.port}` !== key);
    console.log(`[ProxyManager] Marked ${key} as failed — pool now ${this.verified.length}`);
  }

  stop() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
  }
}

module.exports = ProxyManager;
