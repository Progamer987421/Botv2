// captchaSolver.js
// Reads a Minecraft map item held in the bot's hand (128x128 pixels),
// segments the pixel grid into character columns, pattern-matches each
// column against known letter templates, and returns the decoded string.
//
// Map color palette: Minecraft uses a 4-shade-per-base-color system.
// We treat any non-background pixel as "ink" — background is usually
// color index 0 (transparent/black) or the lightest shade of grey/white.

// ── Constants ──────────────────────────────────────────────────────
const MAP_SIZE       = 128;   // Minecraft maps are always 128x128
const CHAR_WIDTH     = 8;     // pixels per character column (approx)
const CHAR_HEIGHT    = MAP_SIZE;
const INK_THRESHOLD  = 4;     // min ink pixels in a column to count as part of a char
const COL_GAP        = 2;     // blank columns between characters

// ── Background color indices ───────────────────────────────────────
// Index 0 = transparent, indices 119/120 = white/light grey (common bg)
const BG_COLORS = new Set([0, 1, 119, 120, 121, 122]);

// ── Letter templates ───────────────────────────────────────────────
// Each letter is a 5-wide × 7-tall binary bitmap (1 = ink, 0 = blank).
// These are standard Minecraft font proportions rendered at map scale.
// Stored as column arrays (left→right), each column bottom→top.
const TEMPLATES = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01110','10001','10000','10000','10000','10001','01110'],
  D: ['11100','10010','10001','10001','10001','10010','11100'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01110','10001','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['01110','00100','00100','00100','00100','00100','01110'],
  J: ['00111','00010','00010','00010','00010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10001','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','11011','10001'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00110','01000','10000','11111'],
  '3': ['11111','00001','00010','00110','00001','10001','01110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['00110','01000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00010','01100'],
};

// Pre-compile templates into column bit-arrays for fast comparison
const COMPILED = {};
for (const [ch, rows] of Object.entries(TEMPLATES)) {
  // rows[0] = top row, rows[6] = bottom row
  // Each row string is '01110' etc (5 wide)
  COMPILED[ch] = rows.map(r => r.split('').map(Number));
}

// ── Core solver ────────────────────────────────────────────────────

/**
 * Decode a Minecraft map's color data into a string.
 * @param {Buffer|Uint8Array} mapData  - 128*128 bytes, one color index per pixel
 * @returns {string} decoded word (uppercase), or '' if nothing found
 */
function solveMapCaptcha(mapData) {
  if (!mapData || mapData.length < MAP_SIZE * MAP_SIZE) return '';

  // 1. Convert to 2D grid: grid[y][x] = colorIndex
  const grid = [];
  for (let y = 0; y < MAP_SIZE; y++) {
    grid.push(mapData.slice(y * MAP_SIZE, (y + 1) * MAP_SIZE));
  }

  // 2. Find the ink bounding box (crop out border/padding)
  let minX = MAP_SIZE, maxX = 0, minY = MAP_SIZE, maxY = 0;
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      if (!BG_COLORS.has(grid[y][x])) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX >= maxX || minY >= maxY) return '';

  // 3. Build ink column profile (how many ink pixels per x column)
  const inkCols = [];
  for (let x = minX; x <= maxX; x++) {
    let count = 0;
    for (let y = minY; y <= maxY; y++) {
      if (!BG_COLORS.has(grid[y][x])) count++;
    }
    inkCols.push({ x, count });
  }

  // 4. Segment into character blobs by finding gap columns
  const charBlobs = [];
  let blobStart = null;
  for (let i = 0; i < inkCols.length; i++) {
    const { x, count } = inkCols[i];
    if (count >= INK_THRESHOLD) {
      if (blobStart === null) blobStart = x;
    } else {
      if (blobStart !== null) {
        charBlobs.push({ x1: blobStart, x2: inkCols[i - 1].x });
        blobStart = null;
      }
    }
  }
  if (blobStart !== null) charBlobs.push({ x1: blobStart, x2: maxX });

  if (charBlobs.length === 0) return '';

  // 5. For each blob, extract a normalized binary bitmap and match
  let result = '';
  for (const blob of charBlobs) {
    const blobW  = blob.x2 - blob.x1 + 1;
    const blobH  = maxY - minY + 1;
    const bitmap = [];

    // Normalize to 5×7
    const tW = 5, tH = 7;
    for (let ty = 0; ty < tH; ty++) {
      const row = [];
      for (let tx = 0; tx < tW; tx++) {
        // Sample from blob proportionally
        const srcX = blob.x1 + Math.floor((tx / tW) * blobW);
        const srcY = minY  + Math.floor((ty / tH) * blobH);
        row.push(BG_COLORS.has(grid[srcY]?.[srcX] ?? 0) ? 0 : 1);
      }
      bitmap.push(row);
    }

    const ch = matchTemplate(bitmap);
    result += ch;
  }

  return result.toUpperCase();
}

/**
 * Find the best-matching character for a 5×7 binary bitmap.
 * Returns '?' if confidence is too low.
 */
function matchTemplate(bitmap) {
  let bestChar  = '?';
  let bestScore = -1;

  for (const [ch, template] of Object.entries(COMPILED)) {
    let matches = 0, total = 0;
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 5; x++) {
        total++;
        if ((bitmap[y]?.[x] ?? 0) === template[y][x]) matches++;
      }
    }
    const score = matches / total;
    if (score > bestScore) {
      bestScore = score;
      bestChar  = ch;
    }
  }

  // Below 55% match — unrecognized
  return bestScore >= 0.55 ? bestChar : '?';
}

// ── Mineflayer integration ─────────────────────────────────────────

/**
 * Attach captcha-solving logic to a mineflayer bot.
 * Watches for a map item in the main hand, reads its data,
 * decodes the word, and types it in chat.
 *
 * @param {object} bot       - mineflayer bot instance
 * @param {function} log     - logging function (msg) => void
 * @param {object} meta      - bot metadata object (to check/set flags)
 */
function attachCaptchaSolver(bot, log, meta) {
  let solving    = false;
  let attempts   = 0;
  const MAX_ATTEMPTS = 5;

  // Called every time the held item or map data might have changed
  function tryReadMap() {
    if (solving)   return;
    if (!meta.captchaPending) return;

    const held = bot.heldItem;
    if (!held) return;

    // Map items: item name contains 'map'
    if (!held.name || !held.name.includes('map')) return;

    // mineflayer exposes map data via bot.map if the map has been sent
    const mapData = bot.maps?.[held.metadata?.[0]?.value ?? held.nbt?.value?.map?.value];

    if (!mapData?.data) {
      log('Map item held but data not loaded yet — waiting...');
      return;
    }

    solving = true;
    attempts++;
    log(`Reading map captcha (attempt ${attempts})...`);

    const word = solveMapCaptcha(mapData.data);
    log(`Decoded captcha: "${word}"`);

    if (!word || word.includes('?')) {
      log('Low confidence decode — retrying in 1.5s');
      solving = false;
      if (attempts < MAX_ATTEMPTS) {
        setTimeout(tryReadMap, 1500);
      } else {
        log('Max captcha attempts reached — bot will reconnect');
        meta.captchaPending = false;
        try { bot.quit(); } catch (_) {}
      }
      return;
    }

    // Submit the answer
    setTimeout(() => {
      try {
        bot.chat(word.toLowerCase()); // some servers want lowercase
        log(`Submitted captcha answer: "${word.toLowerCase()}"`);
        meta.captchaPending = false;
        solving = false;
        attempts = 0;
      } catch (err) {
        log(`Failed to submit captcha: ${err.message}`);
        solving = false;
      }
    }, 800);
  }

  // Watch for captcha-related messages to set the pending flag
  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().toLowerCase();
    if (
      /captcha|verify|type the word|enter the code|anti.?bot|human check/i.test(text)
    ) {
      log(`Captcha prompt detected: "${text}"`);
      meta.captchaPending = true;
      attempts = 0;
      solving  = false;
      // Give the server 500ms to put the map in hand then try
      setTimeout(tryReadMap, 500);
    }

    // Success messages
    if (
      meta.captchaPending &&
      /correct|verified|passed|welcome|success/i.test(text)
    ) {
      log('Captcha solved successfully');
      meta.captchaPending = false;
      solving  = false;
      attempts = 0;
    }

    // Wrong answer
    if (
      meta.captchaPending &&
      /wrong|incorrect|try again|failed|invalid/i.test(text)
    ) {
      log('Wrong captcha answer — retrying');
      meta.captchaPending = true;
      solving  = false;
      setTimeout(tryReadMap, 1000);
    }
  });

  // Also watch for held item changes — map might arrive without a chat prompt
  bot.on('heldItemChanged', () => {
    if (meta.captchaPending) setTimeout(tryReadMap, 300);
  });

  // Map data update event (fires when server sends map packet)
  bot.on('map', (map) => {
    if (meta.captchaPending) {
      log(`Map data received (id: ${map.id}) — attempting decode`);
      setTimeout(tryReadMap, 200);
    }
  });

  // Fallback: on spawn, always check if captcha is waiting
  bot.on('spawn', () => {
    setTimeout(() => {
      if (meta.captchaPending) tryReadMap();
    }, 1500);
  });
}

module.exports = { attachCaptchaSolver, solveMapCaptcha };
