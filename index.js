require('dotenv').config();
console.log('TMDB_KEY loaded:', process.env.TMDB_API_KEY ? process.env.TMDB_API_KEY.slice(0, 6) + '...' : 'UNDEFINED');

const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { getMovieMeta, getTvMeta, getSubtitles } = require('./tmdb');
const { providers, resolveProvider } = require('./providers');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ---- Auth middleware ---- //
function verifyToken(req, res, next) {
  const authHeader = req.headers['x-session-token'];
  if (!authHeader) return res.status(401).json({ error: 'Missing X-Session-Token' });
  try {
    const decoded = jwt.verify(authHeader, process.env.JWT_SECRET);
    req.session = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---- /api/auth ---- //
app.post('/api/auth', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const apiKey = authHeader.split(' ')[1];
  if (apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  const token = jwt.sign({ type: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  res.json({ token });
});

// ---- SSE helpers ---- //
function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendHeartbeat(res) {
  res.write(': heartbeat\n\n');
}

// ---- Core stream logic ---- //
async function streamSources(req, res, type, params) {
  const requestId = uuidv4();
  console.log(`[${requestId}] ${type} request`, params);

  let meta, subtitles;
  try {
    [meta, subtitles] = await Promise.all([
      type === 'movie'
        ? getMovieMeta(params.tmdbId)
        : getTvMeta(params.tmdbId, params.season, params.episode),
      getSubtitles(type, params.tmdbId).catch(() => []),
    ]);
  } catch (err) {
    console.error(`[${requestId}] Failed to fetch metadata:`, err.message);
    sendSSE(res, 'error', { message: 'Failed to fetch metadata', detail: err.message });
    return res.end();
  }

  sendSSE(res, 'meta', { type: 'meta', meta, subtitles, requestId });

  const providerPromises = providers.map(async (providerFn) => {
    const result = await resolveProvider(providerFn, params);
    if (result) {
      sendSSE(res, 'source', { type: 'source', source: { url: result.url, label: result.label }, requestId });
    }
    return result;
  });

  const results = await Promise.allSettled(providerPromises);
  const successful = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;

  sendSSE(res, 'done', { type: 'done', totalSources: successful, requestId });
  res.end();
}

// ---- /movie ---- //
app.get('/movie', verifyToken, async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing movie id' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const heartbeat = setInterval(() => sendHeartbeat(res), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    res.end();
  });

  try {
    await streamSources(req, res, 'movie', { type: 'movie', tmdbId: parseInt(id) });
  } catch (err) {
    console.error('Unhandled error:', err);
    if (!res.writableEnded) {
      sendSSE(res, 'error', { message: 'Internal server error' });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
  }
});

// ---- /tv ---- //
app.get('/tv', verifyToken, async (req, res) => {
  const { id, season, episode } = req.query;
  if (!id || !season || !episode) {
    return res.status(400).json({ error: 'Missing tv id/season/episode' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const heartbeat = setInterval(() => sendHeartbeat(res), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    res.end();
  });

  try {
    await streamSources(req, res, 'tv', {
      type: 'tv',
      tmdbId: parseInt(id),
      season: parseInt(season),
      episode: parseInt(episode),
    });
  } catch (err) {
    console.error('Unhandled error:', err);
    if (!res.writableEnded) {
      sendSSE(res, 'error', { message: 'Internal server error' });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
  }
});

// ---- /player ---- //
app.get('/player', (req, res) => {
  const { id, season, episode } = req.query;
  if (!id) return res.status(400).send('Missing movie or TV id');

  const isTV = season && episode;
  const streamUrl = isTV
    ? `/tv?id=${id}&season=${season}&episode=${episode}`
    : `/movie?id=${id}`;

  const apiKey = process.env.API_KEY;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Player</title>
  <style>
    body { margin: 0; background: #000; display: flex; align-items: center; justify-content: center; height: 100vh; }
    video { width: 100%; height: 100%; object-fit: contain; }
    #status { position: absolute; bottom: 10px; left: 10px; color: #fff; font-family: sans-serif; font-size: 0.8rem; background: rgba(0,0,0,0.6); padding: 4px 8px; border-radius: 4px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>
</head>
<body>
  <video id="player" controls autoplay></video>
  <div id="status">Loading…</div>

  <script>
    const API_KEY = "${apiKey}";
    const video  = document.getElementById('player');
    const status = document.getElementById('status');
    let hlsInstance = null;

    function isMp4(url) {
      try {
        const inner = new URL(url).searchParams.get('url') ?? url;
        return /\.(mp4|mkv)(\\?|$)/i.test(inner);
      } catch { return /\.(mp4|mkv)(\\?|$)/i.test(url); }
    }

    function attachSource(url, label) {
      status.textContent = 'Loading ' + label + '…';
      hlsInstance?.destroy();
      hlsInstance = null;

      if (isMp4(url)) {
        video.src = url;
        video.play().catch(() => {});
        status.textContent = 'Playing ' + label + ' (MP4)';
        return;
      }

      if (Hls.isSupported()) {
        hlsInstance = new Hls();
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
          status.textContent = 'Playing ' + label;
        });
        hlsInstance.on(Hls.Events.ERROR, (_, err) => {
          if (err.fatal) {
            status.textContent = label + ' failed – trying fallback…';
          }
        });
        return;
      }

      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.play().catch(() => {});
        status.textContent = 'Playing ' + label;
        return;
      }

      status.textContent = 'HLS not supported.';
    }

    async function load() {
      const { token } = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + API_KEY }
      }).then(r => r.json());

      const res = await fetch('${streamUrl}', {
        headers: { 'X-Session-Token': token }
      });
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = '';
      let started   = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));

          if (event.type === 'source' && !started) {
            started = true;
            attachSource(event.source.url, event.source.label);
          }
          if (event.type === 'done' && !started) {
            status.textContent = 'No sources available.';
          }
        }
      }
    }

    load();
  </script>
</body>
</html>`;

  res.set('Content-Type', 'text/html');
  res.send(html);
});

// ---- Root (ASCII Art) ---- //
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ASTRE Movies & TV</title>
<style>
body{
    margin:0;
    background:#111;
    color:#fff;
    font-family:Consolas,"Courier New",monospace;
    padding:20px;
}
pre{
    white-space:pre;
    line-height:1;
    font-size:15px;
    margin:0;
}
.info{
    margin-top:18px;
    font-size:18px;
    line-height:1.5;
}
</style>
</head>
<body>
<pre>
 █████╗ ███████╗████████╗██████╗ ███████╗
██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██╔════╝
███████║███████╗   ██║   ██████╔╝█████╗
██╔══██║╚════██║   ██║   ██╔══██╗██╔══╝
██║  ██║███████║   ██║   ██║  ██║███████╗
╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝

███╗   ███╗ ██████╗ ██╗   ██╗██╗███████╗███████╗
████╗ ████║██╔═══██╗██║   ██║██║██╔════╝██╔════╝
██╔████╔██║██║   ██║██║   ██║██║█████╗  ███████╗
██║╚██╔╝██║██║   ██║╚██╗ ██╔╝██║██╔══╝  ╚════██║
██║ ╚═╝ ██║╚██████╔╝ ╚████╔╝ ██║███████╗███████║
╚═╝     ╚═╝ ╚═════╝   ╚═══╝  ╚═╝╚══════╝╚══════╝

████████╗██╗   ██╗
╚══██╔══╝██║   ██║
   ██║   ██║   ██║
   ██║   ╚██╗ ██╔╝
   ██║    ╚████╔╝
   ╚═╝     ╚═══╝
</pre>
<div class="info">
developed by: @astre<br>
project: ASTRE Movies &amp; TV<br>
github: https://github.com/astre<br>
version: v1.0.0
</div>
</body>
</html>`);
});

// ---- Start server ---- //
app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});