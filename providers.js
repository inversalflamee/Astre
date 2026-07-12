const axios = require('axios');

// ── Utility: random jitter (0 to maxMs ms) ─────────
function jitter(maxMs = 2000) {
  return Math.random() * maxMs;
}

// ── Utility: retry a function with exponential backoff
async function withRetry(fn, retries = 2, baseDelay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      const delay = baseDelay * Math.pow(2, i) + Math.random() * 500;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ══════════════════════════════════════════════════════
//  Example Providers (replace these with real scrapers)
// ══════════════════════════════════════════════════════

async function providerA({ type, tmdbId, season, episode }) {
  // Stagger the request
  await new Promise(r => setTimeout(r, jitter(800)));

  if (type === 'movie' && tmdbId === 550) {
    return {
      url: 'https://example.com/stream/fightclub.m3u8',
      label: 'Provider A'
    };
  }
  if (type === 'tv' && tmdbId === 1399 && season === 1 && episode === 1) {
    return {
      url: 'https://example.com/stream/got_s1e1.m3u8',
      label: 'Provider A'
    };
  }
  return null;   // not available from this provider
}

async function providerB({ type, tmdbId, season, episode }) {
  await new Promise(r => setTimeout(r, jitter(1200)));

  if (type === 'movie' && tmdbId === 550) {
    return {
      url: 'https://example.com/stream/fightclub_alt.mp4',
      label: 'Provider B'
    };
  }
  // Simulate a failure for Game of Thrones episode
  if (type === 'tv' && tmdbId === 1399 && season === 1 && episode === 1) {
    throw new Error('Temporary failure');
  }
  return null;
}

// ── List of active providers (order doesn’t matter) ──
const providers = [providerA, providerB];

// ══════════════════════════════════════════════════════
//  Provider Runner (retry, verify, emit)
// ══════════════════════════════════════════════════════
async function resolveProvider(providerFn, params) {
  const label = providerFn.name || 'unknown';
  try {
    // 1. Run with retry
    const result = await withRetry(() => providerFn(params), 2, 800);
    if (!result || !result.url) return null;

    // 2. Live verification (HEAD request)
    //    Remove/comment the verification for testing with fake URLs
    try {
      await axios.head(result.url, { timeout: 5000 });
      return result;          // ✅ verified
    } catch {
      console.warn(`${label} failed URL verification`);
      return null;
    }
  } catch (err) {
    console.warn(`${label} failed after retries: ${err.message}`);
    return null;
  }
}

module.exports = { providers, resolveProvider };