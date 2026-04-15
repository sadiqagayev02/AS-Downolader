const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// ═══════════════════════════════════════════════════════════════════════════════
// YENI: yt-dlp binary download (Render.com free tier üçün)
// ═══════════════════════════════════════════════════════════════════════════════

const YT_DLP_PATH = '/tmp/yt-dlp';

async function downloadYtDlp() {
  if (fs.existsSync(YT_DLP_PATH)) {
    console.log('✅ yt-dlp already exists');
    return YT_DLP_PATH;
  }

  console.log('📥 Downloading yt-dlp...');
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(YT_DLP_PATH);
    https.get('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        fs.chmodSync(YT_DLP_PATH, 0o755);
        console.log('✅ yt-dlp downloaded successfully');
        resolve(YT_DLP_PATH);
      });
    }).on('error', (err) => {
      fs.unlinkSync(YT_DLP_PATH);
      reject(err);
    });
  });
}

// Global yt-dlp command
let YT_DLP = 'yt-dlp'; // fallback

// ═══════════════════════════════════════════════════════════════════════════════
// PREMIUM CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  INVIDIOUS_INSTANCES: [
    'https://iv.datura.network',
    'https://iv.nboeck.de', 
    'https://iv.melmac.space',
    'https://vid.puffyan.us',
    'https://yt.artemislena.eu',
  ],
  
  RETRY: {
    maxAttempts: 3,
    baseDelay: 1000,
    maxDelay: 5000,
    backoffMultiplier: 2,
  },
  
  USER_AGENTS: [
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  ],
  
  YT_STRATEGIES: [
    { name: 'tv_embedded', args: '--extractor-args "youtube:player_client=tv_embedded"' },
    { name: 'ios', args: '--extractor-args "youtube:player_client=ios"' },
    { name: 'android_vr', args: '--extractor-args "youtube:player_client=android_vr"' },
    { name: 'web_creator', args: '--extractor-args "youtube:player_client=web_creator"' },
  ],
};

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ═══════════════════════════════════════════════════════════════════════════════
// PREMIUM HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getRandomUserAgent() {
  return CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function smartRetry(operation, context = '') {
  let lastError;
  for (let attempt = 1; attempt <= CONFIG.RETRY.maxAttempts; attempt++) {
    try {
      console.log(`🔄 ${context} - Attempt ${attempt}/${CONFIG.RETRY.maxAttempts}`);
      return await operation();
    } catch (err) {
      lastError = err;
      console.log(`⚠️ ${context} - Attempt ${attempt} failed: ${err.message.substring(0, 100)}`);
      
      if (attempt < CONFIG.RETRY.maxAttempts) {
        const delay = Math.min(
          CONFIG.RETRY.baseDelay * Math.pow(CONFIG.RETRY.backoffMultiplier, attempt - 1),
          CONFIG.RETRY.maxDelay
        );
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&\n?#]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function formatDuration(secs) {
  if (!secs) return '00:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  return `${m}:${s.toString().padStart(2,'0')}`;
}

function sanitizeTitle(title) {
  return (title || 'video')
    .replace(/[^\w\s\u0400-\u04FF\u0100-\u024F-]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 80) || 'video';
}

// ═══════════════════════════════════════════════════════════════════════════════
// COOKIE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function createTempCookieFile(cookieString, fileId) {
  if (!cookieString || typeof cookieString !== 'string' || !cookieString.trim()) {
    return null;
  }
  try {
    const cookieFile = path.join('/tmp', `yt_cookie_${fileId}.txt`);
    const lines = [
      '# Netscape HTTP Cookie File',
      '',
    ];

    cookieString.split(';').forEach(pair => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) return;
      const name = pair.substring(0, eqIdx).trim();
      const value = pair.substring(eqIdx + 1).trim();
      if (!name) return;
      lines.push(`.youtube.com\tTRUE\t/\tFALSE\t${Math.floor(Date.now()/1000)+86400*30}\t${name}\t${value}`);
    });

    fs.writeFileSync(cookieFile, lines.join('\n'));
    return cookieFile;
  } catch (e) {
    return null;
  }
}

function deleteTempFile(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREMIUM YOUTUBE INFO
// ═══════════════════════════════════════════════════════════════════════════════

async function getYouTubeInfoPremium(url, cookieString = null) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');

  const invidiousPromise = Promise.race([
    getInvidiousInfoParallel(videoId),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Invidious timeout')), 8000))
  ]);

  const ytDlpPromise = cookieString 
    ? getYouTubeInfoWithCookie(url, cookieString)
    : getYouTubeInfoStrategic(url);

  try {
    const result = await Promise.race([
      invidiousPromise,
      ytDlpPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('All timeout')), 15000))
    ]);
    return result;
  } catch (err) {
    try {
      return await getInvidiousInfoParallel(videoId);
    } catch (_) {
      return cookieString 
        ? await getYouTubeInfoWithCookie(url, cookieString)
        : await getYouTubeInfoStrategic(url);
    }
  }
}

async function getInvidiousInfoParallel(videoId) {
  const promises = CONFIG.INVIDIOUS_INSTANCES.map(async (instance) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const res = await fetch(`${instance}/api/v1/videos/${videoId}`, {
        signal: controller.signal,
        headers: { 'User-Agent': getRandomUserAgent() }
      });
      
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      const data = await res.json();
      if (!data.formatStreams && !data.adaptiveFormats) throw new Error('No formats');
      
      return { instance, data };
    } catch (err) {
      return { instance, error: err.message };
    }
  });

  const results = await Promise.all(promises);
  const success = results.find(r => r.data);
  
  if (!success) throw new Error('All Invidious failed');
  
  console.log(`✅ Invidious: ${success.instance}`);
  return processInvidiousData(success.data);
}

function processInvidiousData(data) {
  const qualities = [];
  const seen = new Set();

  if (data.formatStreams) {
    for (const fmt of data.formatStreams) {
      if (!fmt.resolution || fmt.resolution === 'null') continue;
      const parts = fmt.resolution.split('x');
      const height = parseInt(parts[parts.length - 1]);
      
      let label;
      if (height >= 720) label = '720p HD';
      else if (height >= 480) label = '480p';
      else if (height >= 360) label = '360p';
      else continue;
      
      if (seen.has(label)) continue;
      seen.add(label);
      
      qualities.push({
        label,
        value: String(height),
        formatId: fmt.itag,
        url: fmt.url,
        audioUrl: null,
        filesize: fmt.size ? parseInt(fmt.size) : null,
        ext: 'mp4',
        isDash: false,
        needsMerge: false,
        source: 'invidious',
      });
    }
  }

  if (data.adaptiveFormats) {
    const videoFormats = data.adaptiveFormats
      .filter(f => f.type?.includes('video') && f.url)
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    
    const audioFormats = data.adaptiveFormats
      .filter(f => f.type?.includes('audio') && f.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    
    const bestAudio = audioFormats[0];

    const v1080 = videoFormats.find(f => f.height >= 1080);
    if (v1080 && bestAudio && !seen.has('1080p Full HD')) {
      seen.add('1080p Full HD');
      qualities.unshift({
        label: '1080p Full HD',
        value: '1080',
        formatId: v1080.itag,
        url: v1080.url,
        audioUrl: bestAudio.url,
        filesize: (v1080.size ? parseInt(v1080.size) : 0) + (bestAudio.size ? parseInt(bestAudio.size) : 0),
        ext: 'mp4',
        isDash: true,
        needsMerge: true,
        source: 'invidious',
      });
    }
  }

  if (data.adaptiveFormats) {
    const audio = data.adaptiveFormats
      .filter(f => f.type?.includes('audio'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    
    if (audio) {
      qualities.push({
        label: 'MP3 (Audio)',
        value: 'audio',
        formatId: audio.itag,
        url: audio.url,
        audioUrl: null,
        filesize: audio.size ? parseInt(audio.size) : null,
        ext: 'm4a',
        isDash: false,
        needsMerge: false,
        source: 'invidious',
      });
    }
  }

  return {
    title: data.title || 'YouTube Video',
    thumbnail: data.videoThumbnails?.[0]?.url || data.thumbnailUrl || '',
    duration: formatDuration(data.lengthSeconds || 0),
    uploader: data.author || '',
    platform: 'youtube',
    qualities,
  };
}

async function getYouTubeInfoWithCookie(url, cookieString) {
  const fileId = crypto.randomBytes(8).toString('hex');
  const cookieFile = createTempCookieFile(cookieString, fileId);
  
  try {
    const cookieArg = cookieFile ? `--cookies "${cookieFile}"` : '';
    // YENI: Use YT_DLP variable instead of hardcoded 'yt-dlp'
    const cmd = `${YT_DLP} ${cookieArg} --dump-json --no-playlist --socket-timeout 20 "${url}"`;
    
    const { stdout } = await execPromise(cmd, { 
      timeout: 30000,
      maxBuffer: 20 * 1024 * 1024 
    });
    
    return processYtDlpData(JSON.parse(stdout));
  } finally {
    deleteTempFile(cookieFile);
  }
}

async function getYouTubeInfoStrategic(url) {
  const strategies = [...CONFIG.YT_STRATEGIES].sort(() => Math.random() - 0.5);
  
  for (const strategy of strategies) {
    try {
      console.log(`🎯 Strategy: ${strategy.name}`);
      // YENI: Use YT_DLP variable
      const cmd = `${YT_DLP} ${strategy.args} --dump-json --no-playlist --socket-timeout 15 --user-agent "${getRandomUserAgent()}" "${url}"`;
      
      const { stdout } = await execPromise(cmd, { 
        timeout: 25000,
        maxBuffer: 20 * 1024 * 1024 
      });
      
      console.log(`✅ Strategy success: ${strategy.name}`);
      return processYtDlpData(JSON.parse(stdout));
    } catch (err) {
      console.log(`❌ Strategy failed: ${strategy.name}`);
      await sleep(500);
    }
  }
  
  throw new Error('All strategies failed');
}

function processYtDlpData(info) {
  const qualities = [];
  const formats = info.formats || [];
  const seen = new Set();

  const bestAudio = formats
    .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

  const combined = formats.filter(f => 
    f.vcodec && f.vcodec !== 'none' && 
    f.acodec && f.acodec !== 'none' &&
    f.height && f.height <= 720
  ).sort((a, b) => (b.height || 0) - (a.height || 0));

  for (const fmt of combined) {
    const label = fmt.height >= 720 ? '720p HD' : 
                  fmt.height >= 480 ? '480p' : 
                  fmt.height >= 360 ? '360p' : `${fmt.height}p`;
    
    if (seen.has(label)) continue;
    seen.add(label);
    
    qualities.push({
      label,
      value: String(fmt.height),
      formatId: fmt.format_id,
      url: fmt.url,
      audioUrl: null,
      filesize: fmt.filesize || fmt.filesize_approx || null,
      ext: fmt.ext || 'mp4',
      isDash: false,
      needsMerge: false,
      source: 'ytdlp',
    });
  }

  const videoOnly = formats.filter(f => 
    f.vcodec && f.vcodec !== 'none' && 
    (!f.acodec || f.acodec === 'none') &&
    f.height && f.height >= 1080
  ).sort((a, b) => (b.height || 0) - (a.height || 0));

  const v1080 = videoOnly.find(f => f.height >= 1080 && f.height < 1440);
  if (v1080 && bestAudio && !seen.has('1080p Full HD')) {
    seen.add('1080p Full HD');
    qualities.unshift({
      label: '1080p Full HD',
      value: '1080',
      formatId: v1080.format_id,
      url: v1080.url,
      audioUrl: bestAudio.url,
      filesize: (v1080.filesize || 0) + (bestAudio.filesize || 0),
      ext: v1080.ext || 'mp4',
      isDash: true,
      needsMerge: true,
      source: 'ytdlp',
    });
  }

  if (bestAudio) {
    qualities.push({
      label: 'MP3 (Audio)',
      value: 'audio',
      formatId: bestAudio.format_id,
      url: bestAudio.url,
      audioUrl: null,
      filesize: bestAudio.filesize || null,
      ext: bestAudio.ext || 'm4a',
      isDash: false,
      needsMerge: false,
      source: 'ytdlp',
    });
  }

  return {
    title: info.title || 'YouTube Video',
    thumbnail: info.thumbnail || '',
    duration: formatDuration(info.duration || 0),
    uploader: info.uploader || info.channel || '',
    platform: 'youtube',
    qualities,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIKTOK INFO
// ═══════════════════════════════════════════════════════════════════════════════

async function getTikTokInfoPremium(url) {
  return await smartRetry(async () => {
    const apiHosts = [
      'api22-normal-c-useast2a.tiktokv.com',
      'api16-normal-c-useast2a.tiktokv.com',
    ];
    
    for (const host of apiHosts) {
      try {
        const args = `--extractor-args "tiktok:api_hostname=${host}"`;
        // YENI: Use YT_DLP variable
        const cmd = `${YT_DLP} ${args} --dump-json --no-playlist --socket-timeout 15 --user-agent "${getRandomUserAgent()}" "${url}"`;
        
        const { stdout } = await execPromise(cmd, { 
          timeout: 25000,
          maxBuffer: 15 * 1024 * 1024 
        });
        
        const data = JSON.parse(stdout);
        console.log(`✅ TikTok: ${host}`);
        return processTikTokData(data);
      } catch (err) {
        console.log(`❌ TikTok ${host}: ${err.message.substring(0, 80)}`);
        await sleep(800);
      }
    }
    
    throw new Error('All TikTok strategies failed');
  }, 'TikTok Info');
}

function processTikTokData(data) {
  const qualities = [];
  
  const bestVideo = data.formats?.find(f => 
    f.vcodec !== 'none' && f.height >= 720
  ) || data.formats?.[0];
  
  if (bestVideo) {
    qualities.push({
      label: bestVideo.height >= 720 ? 'HD Video' : 'SD Video',
      value: 'video',
      formatId: bestVideo.format_id,
      url: bestVideo.url,
      audioUrl: null,
      filesize: bestVideo.filesize || null,
      ext: 'mp4',
      isDash: false,
      needsMerge: false,
      source: 'tiktok',
    });
  }

  const audio = data.formats?.find(f => 
    f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
  );
  
  if (audio) {
    qualities.push({
      label: 'MP3 (Audio)',
      value: 'audio',
      formatId: audio.format_id,
      url: audio.url,
      audioUrl: null,
      filesize: audio.filesize || null,
      ext: 'm4a',
      isDash: false,
      needsMerge: false,
      source: 'tiktok',
    });
  }

  return {
    title: data.title || 'TikTok Video',
    thumbnail: data.thumbnail || '',
    duration: formatDuration(data.duration || 0),
    uploader: data.uploader || data.creator || '',
    platform: 'tiktok',
    qualities,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSTAGRAM INFO
// ═══════════════════════════════════════════════════════════════════════════════

async function getInstagramInfoPremium(url) {
  return await smartRetry(async () => {
    // YENI: Use YT_DLP variable
    const cmd = `${YT_DLP} --dump-json --no-playlist --socket-timeout 20 --user-agent "${getRandomUserAgent()}" "${url}"`;
    
    const { stdout } = await execPromise(cmd, { 
      timeout: 30000,
      maxBuffer: 15 * 1024 * 1024 
    });
    
    const data = JSON.parse(stdout);
    return processInstagramData(data);
  }, 'Instagram Info');
}

function processInstagramData(data) {
  const qualities = [];
  
  const bestFormat = data.formats?.find(f => 
    f.vcodec !== 'none' && f.height >= 720
  ) || data.formats?.[0];
  
  if (bestFormat) {
    qualities.push({
      label: bestFormat.height >= 720 ? 'HD Video' : 'SD Video',
      value: 'video',
      formatId: bestFormat.format_id,
      url: bestFormat.url,
      audioUrl: null,
      filesize: bestFormat.filesize || null,
      ext: 'mp4',
      isDash: false,
      needsMerge: false,
      source: 'instagram',
    });
  }

  const audio = data.formats?.find(f => 
    f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
  );
  
  if (audio) {
    qualities.push({
      label: 'MP3 (Audio)',
      value: 'audio',
      formatId: audio.format_id,
      url: audio.url,
      audioUrl: null,
      filesize: audio.filesize || null,
      ext: 'm4a',
      isDash: false,
      needsMerge: false,
      source: 'instagram',
    });
  }

  return {
    title: data.title || 'Instagram Video',
    thumbnail: data.thumbnail || '',
    duration: formatDuration(data.duration || 0),
    uploader: data.uploader || data.creator || '',
    platform: 'instagram',
    qualities,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIVERSAL WEB EXTRACTOR
// ═══════════════════════════════════════════════════════════════════════════════

async function getUniversalInfo(url) {
  return await smartRetry(async () => {
    // YENI: Use YT_DLP variable
    const cmd = `${YT_DLP} --dump-json --no-playlist --socket-timeout 20 --user-agent "${getRandomUserAgent()}" "${url}"`;
    
    const { stdout } = await execPromise(cmd, { 
      timeout: 30000,
      maxBuffer: 15 * 1024 * 1024 
    });
    
    const data = JSON.parse(stdout);
    return processUniversalData(data, url);
  }, 'Universal Info');
}

function processUniversalData(data, url) {
  const qualities = [];
  
  const videoFormats = data.formats?.filter(f => 
    f.vcodec !== 'none' && f.url
  ).sort((a, b) => (b.height || 0) - (a.height || 0)) || [];
  
  const bestVideo = videoFormats[0];
  if (bestVideo) {
    qualities.push({
      label: bestVideo.height ? `${bestVideo.height}p` : 'Best Quality',
      value: bestVideo.height ? String(bestVideo.height) : 'best',
      formatId: bestVideo.format_id,
      url: bestVideo.url,
      audioUrl: null,
      filesize: bestVideo.filesize || null,
      ext: bestVideo.ext || 'mp4',
      isDash: false,
      needsMerge: false,
      source: 'universal',
    });
  }

  const audio = data.formats?.find(f => 
    f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
  );
  
  if (audio) {
    qualities.push({
      label: 'MP3 (Audio)',
      value: 'audio',
      formatId: audio.format_id,
      url: audio.url,
      audioUrl: null,
      filesize: audio.filesize || null,
      ext: audio.ext || 'm4a',
      isDash: false,
      needsMerge: false,
      source: 'universal',
    });
  }

  let platform = 'other';
  if (url.includes('facebook.com')) platform = 'facebook';
  else if (url.includes('twitter.com') || url.includes('x.com')) platform = 'twitter';
  else if (url.includes('reddit.com')) platform = 'reddit';
  else if (url.includes('vimeo.com')) platform = 'vimeo';
  else if (url.includes('dailymotion.com')) platform = 'dailymotion';
  else if (url.includes('soundcloud.com')) platform = 'soundcloud';

  return {
    title: data.title || 'Video',
    thumbnail: data.thumbnail || '',
    duration: formatDuration(data.duration || 0),
    uploader: data.uploader || data.creator || '',
    platform,
    qualities: qualities.length > 0 ? qualities : [{
      label: 'Best Quality',
      value: 'best',
      formatId: 'best',
      url: null,
      audioUrl: null,
      filesize: null,
      ext: 'mp4',
      isDash: false,
      needsMerge: false,
      source: 'universal',
    }],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: 'premium-v2.0',
    features: ['1080p-DASH', 'MP3-Universal', 'Smart-Retry', 'Parallel-Invidious']
  });
});

app.post('/api/info', async (req, res) => {
  const { url, cookieString } = req.body;
  
  if (!url) {
    return res.status(400).json({ success: false, error: 'URL tələb olunur' });
  }

  console.log(`📡 Premium Info: ${url}`);

  try {
    let result;

    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      result = await getYouTubeInfoPremium(url, cookieString);
    } else if (url.includes('tiktok.com')) {
      result = await getTikTokInfoPremium(url);
    } else if (url.includes('instagram.com')) {
      result = await getInstagramInfoPremium(url);
    } else {
      result = await getUniversalInfo(url);
    }

    if (!result.qualities || result.qualities.length === 0) {
      throw new Error('No formats found');
    }

    res.json({ success: true, data: result });

  } catch (err) {
    console.error(`❌ /api/info xətası: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message,
      fallback: true 
    });
  }
});

app.post('/api/direct-url', async (req, res) => {
  const { url, quality, formatId, cookieString, platform } = req.body;
  
  if (!url || !quality) {
    return res.status(400).json({ success: false, error: 'URL və keyfiyyət tələb olunur' });
  }

  console.log(`🔗 Direct URL: ${url} | Quality: ${quality}`);

  try {
    let directUrl;
    let audioUrl = null;

    if (platform === 'youtube' || url.includes('youtube.com') || url.includes('youtu.be')) {
      if (cookieString && quality === 'audio') {
        const info = await getYouTubeInfoWithCookie(url, cookieString);
        const audioFormat = info.qualities.find(q => q.value === 'audio');
        directUrl = audioFormat?.url;
      } else if (cookieString) {
        const info = await getYouTubeInfoWithCookie(url, cookieString);
        const videoFormat = info.qualities.find(q => q.value === quality);
        directUrl = videoFormat?.url;
        audioUrl = videoFormat?.audioUrl || null;
      } else {
        const info = await getYouTubeInfoStrategic(url);
        const videoFormat = info.qualities.find(q => q.value === quality);
        directUrl = videoFormat?.url;
        audioUrl = videoFormat?.audioUrl || null;
      }
    } else {
      let info;
      if (url.includes('tiktok.com')) {
        info = await getTikTokInfoPremium(url);
      } else if (url.includes('instagram.com')) {
        info = await getInstagramInfoPremium(url);
      } else {
        info = await getUniversalInfo(url);
      }
      
      const format = info.qualities.find(q => q.value === quality);
      directUrl = format?.url;
      audioUrl = format?.audioUrl || null;
    }

    if (!directUrl) {
      throw new Error('Direct URL not found');
    }

    res.json({
      success: true,
      data: {
        directUrl,
        audioUrl,
        quality,
        platform: platform || 'unknown',
      }
    });

  } catch (err) {
    console.error(`❌ /api/direct-url xətası: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVER (with yt-dlp download)
// ═══════════════════════════════════════════════════════════════════════════════

(async () => {
  try {
    // Download yt-dlp before starting server
    YT_DLP = await downloadYtDlp();
    console.log(`✅ Using yt-dlp: ${YT_DLP}`);
  } catch (e) {
    console.log('⚠️ Failed to download yt-dlp, using system fallback');
  }
  
  app.listen(PORT, () => {
    console.log(`🚀 Premium Video Downloader API ${PORT} portunda işləyir`);
    console.log(`📊 Features: 1080p DASH | Universal MP3 | Smart Retry | Parallel Invidious`);
  });
})();
