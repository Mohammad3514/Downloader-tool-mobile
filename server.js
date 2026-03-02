const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ===========================
   Detect Python command
   On Windows: 'python', on Linux/Render: 'python3'
   =========================== */
let PYTHON_CMD = 'python';

function resolvePython() {
    // Try 'python' first (Windows, some Linux)
    try {
        const v = execSync('python --version', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
        if (v) { PYTHON_CMD = 'python'; console.log('✅ python command:', PYTHON_CMD); return; }
    } catch (_) { }
    // Fallback to 'python3' (Render, Ubuntu, Mac)
    try {
        const v = execSync('python3 --version', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
        if (v) { PYTHON_CMD = 'python3'; console.log('✅ python command:', PYTHON_CMD); return; }
    } catch (_) { }
    console.error('❌ Neither python nor python3 found!');
}

resolvePython();

/* ===========================
   Resolve ffmpeg path
   =========================== */
let FFMPEG_PATH = null;

function resolveFfmpeg() {
    // 1. Try system ffmpeg
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        FFMPEG_PATH = 'ffmpeg';
        console.log('✅ ffmpeg found in system PATH');
        return;
    } catch (_) { }
    // 2. Try imageio_ffmpeg Python package
    for (const pyCmd of [PYTHON_CMD, 'python', 'python3']) {
        try {
            const result = execSync(
                `${pyCmd} -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"`,
                { encoding: 'utf8', timeout: 8000 }
            ).trim();
            if (result && fs.existsSync(result)) {
                FFMPEG_PATH = result;
                console.log('✅ ffmpeg via imageio_ffmpeg:', FFMPEG_PATH);
                return;
            }
        } catch (_) { }
    }
    console.warn('⚠️  ffmpeg NOT found — audio merging may be limited');
}

resolveFfmpeg();

/* ===========================
   Helpers
   =========================== */

/*
  YouTube client cascade for server/datacenter IPs.
  These don't require PO tokens and work on cloud servers.
  Order matters — try most-permissive first.
*/
const YT_CLIENTS = [
    'tv_embedded',   // Smart TV embedded — no PO token needed, reliable
    'web_creator',   // YouTube Studio client — usually not rate-limited
    'mweb',          // mobile web — less restricted than desktop web
    'web_embedded',  // embedded player client
    'android_vr',    // VR Android client — different quota bucket
];

function getYouTubeBypassArgs(url, clientIndex = 0) {
    const isYouTube = /youtube\.com|youtu\.be/i.test(url || '');
    if (!isYouTube) return [];
    const client = YT_CLIENTS[clientIndex] || YT_CLIENTS[0];
    return [
        '--extractor-args', `youtube:player_client=${client}`,
        '--no-check-certificates',
        '--retries', '2',
        '--extractor-retries', '2',
        '--socket-timeout', '30',
        '--ignore-no-formats-error',
    ];
}

function getYtDlpArgs(extraArgs = [], url = '', clientIndex = 0) {
    const ffmpegArgs = (FFMPEG_PATH && FFMPEG_PATH !== 'ffmpeg')
        ? ['--ffmpeg-location', FFMPEG_PATH]
        : [];
    const bypassArgs = getYouTubeBypassArgs(url, clientIndex);
    return { cmd: PYTHON_CMD, args: ['-m', 'yt_dlp', ...ffmpegArgs, ...bypassArgs, ...extraArgs] };
}

/* Try multiple YouTube clients in sequence until one works */
function spawnYtDlp(extraArgs, url) {
    return new Promise((resolve, reject) => {
        const isYouTube = /youtube\.com|youtu\.be/i.test(url || '');
        const maxAttempts = isYouTube ? YT_CLIENTS.length : 1;
        let attempt = 0;

        function tryNext() {
            if (attempt >= maxAttempts) {
                return reject(new Error('All clients failed'));
            }
            const { cmd, args } = getYtDlpArgs(extraArgs, url, attempt);
            const clientName = isYouTube ? YT_CLIENTS[attempt] : 'default';
            console.log(`\n▶ yt-dlp attempt ${attempt + 1}/${maxAttempts} [client: ${clientName}]`);

            let stdout = '', stderr = '';
            const proc = spawn(cmd, args);
            proc.stdout.on('data', d => { stdout += d; });
            proc.stderr.on('data', d => { stderr += d.toString(); });

            proc.on('error', err => reject(err));
            proc.on('close', code => {
                if (code === 0 && stdout.trim()) {
                    console.log(`✅ Succeeded with client: ${clientName}`);
                    return resolve({ stdout, stderr });
                }
                console.warn(`❌ Client ${clientName} failed (code ${code}):`, stderr.slice(-200));
                attempt++;
                tryNext();
            });
        }
        tryNext();
    });
}

function getPlatformInfo(url) {
    const platforms = [
        { name: 'YouTube', pattern: /youtube\.com|youtu\.be/ },
        { name: 'Instagram', pattern: /instagram\.com/ },
        { name: 'TikTok', pattern: /tiktok\.com/ },
        { name: 'Twitter', pattern: /twitter\.com|x\.com/ },
        { name: 'Facebook', pattern: /facebook\.com|fb\.watch/ },
        { name: 'Dailymotion', pattern: /dailymotion\.com/ },
        { name: 'Vimeo', pattern: /vimeo\.com/ },
        { name: 'Reddit', pattern: /reddit\.com/ },
    ];
    for (const p of platforms) if (p.pattern.test(url)) return p;
    return { name: 'Unknown' };
}

/* Build yt-dlp format string from user options */
function buildFormat(opts) {
    const { type, format, quality } = opts;

    if (type === 'audio') {
        // Audio-only: yt-dlp will use -x to extract audio
        return 'bestaudio/best';
    }

    // Video: build height-capped format string
    const h = quality && quality !== 'best' ? parseInt(quality) : null;

    if (FFMPEG_PATH) {
        if (format === 'mp4') {
            return h
                ? `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`
                : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
        }
        if (format === 'webm') {
            return h
                ? `bestvideo[height<=${h}][ext=webm]+bestaudio[ext=webm]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`
                : 'bestvideo[ext=webm]+bestaudio[ext=webm]/bestvideo+bestaudio/best';
        }
        // mkv or any other — use best
        return h
            ? `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`
            : 'bestvideo+bestaudio/best';
    } else {
        // No ffmpeg — single-file formats only
        return h
            ? `best[height<=${h}][ext=mp4]/best[height<=${h}]/best`
            : 'best[ext=mp4]/best';
    }
}


/* Stream file to HTTP response and clean up */
function streamFileToResponse(filePath, filename, res, req) {
    if (!filePath || !fs.existsSync(filePath)) {
        if (!res.headersSent) res.status(500).json({ error: 'Output file not found after download.' });
        return;
    }
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
        '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
        '.opus': 'audio/ogg', '.aac': 'audio/aac',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(filePath, () => { }));
    stream.on('error', () => fs.unlink(filePath, () => { }));

    req.on('close', () => { try { stream.destroy(); } catch (_) { } });
}

/* ===========================
   GET /api/check
   =========================== */
app.get('/api/check', (req, res) => {
    exec(`${PYTHON_CMD} -m yt_dlp --version`, { timeout: 8000 }, (err, stdout) => {
        if (err) return res.json({ status: 'error', ytdlpInstalled: false, ffmpegFound: false });
        res.json({
            status: 'ok',
            ytdlpVersion: stdout.trim(),
            ytdlpInstalled: true,
            ffmpegFound: !!FFMPEG_PATH,
        });
    });
});

/* ===========================
   GET /api/debug  — see raw yt-dlp output for a URL
   =========================== */
app.get('/api/debug', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    try {
        const { stdout, stderr } = await spawnYtDlp(
            ['--dump-json', '--no-playlist', url], url
        );
        res.json({ success: true, stdoutLength: stdout.length, stderr: stderr.slice(-1000) });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

/* ===========================
   GET /api/info
   =========================== */
app.get('/api/info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const platform = getPlatformInfo(url);

    let stdout, stderr;
    try {
        ({ stdout, stderr } = await spawnYtDlp(['--dump-json', '--no-playlist', url], url));
    } catch (e) {
        return res.status(500).json({
            error: 'Could not fetch video info. YouTube may be blocking this server. Try a non-YouTube link or see /api/debug for details.',
            details: e.message,
        });
    }

    try {
        const info = JSON.parse(stdout.trim().split('\n')[0]);
        const allFmts = info.formats || [];

        const seen = new Set();
        const qualities = [];
        allFmts
            .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.height)
            .forEach(f => {
                const label = `${f.height}p`;
                if (!seen.has(label)) {
                    seen.add(label);
                    qualities.push({ formatId: f.format_id, label, height: f.height, ext: f.ext, hasAudio: true, fps: f.fps, filesize: f.filesize || f.filesize_approx || null });
                }
            });

        qualities.sort((a, b) => b.height - a.height);
        qualities.unshift({ formatId: 'best', label: 'Best Quality (HD)', height: 9999, ext: 'mp4', hasAudio: true, isBest: true });

        res.json({
            title: info.title || 'Unknown',
            thumbnail: info.thumbnail || null,
            duration: info.duration || null,
            uploader: info.uploader || info.channel || 'Unknown',
            viewCount: info.view_count || null,
            platform: platform.name,
            qualities,
            originalUrl: url,
            ffmpegAvailable: !!FFMPEG_PATH,
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to parse video info', details: e.message });
    }
});

/* ===========================
   GET /api/download
   Params: url, type(video|audio), format, quality, audioQuality, savePath, title
   =========================== */
app.get('/api/download', (req, res) => {
    const {
        url,
        type = 'video',       // video | audio
        format = 'mp4',       // mp4 | webm | mkv | mp3 | m4a | flac
        quality = 'best',     // best | 2160 | 1080 | 720 | 480 | 360 | 240
        audioQuality = '0',   // 0=best, 5≈128k, 9=worst
        savePath = '',        // local folder to save instead of streaming
        title = 'video',
    } = req.query;

    if (!url) return res.status(400).json({ error: 'URL is required' });

    const safeTitle = title.replace(/[^\w\s\-]/g, '').trim().slice(0, 60) || 'video';
    const ext = type === 'audio' ? format : (format || 'mp4');
    const filename = `${safeTitle}.${ext}`;

    // Unique temp ID
    const tempId = `vs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const tempTemplate = path.join(os.tmpdir(), `${tempId}.%(ext)s`);

    // Determine destination: temp (stream) or local folder
    const saveLocally = savePath && savePath.trim();
    let finalOutputTemplate;

    if (saveLocally) {
        try {
            const dir = savePath.trim();
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            finalOutputTemplate = path.join(dir, `${safeTitle}.%(ext)s`);
        } catch (e) {
            return res.status(400).json({ error: `Cannot create save directory: ${e.message}` });
        }
    } else {
        finalOutputTemplate = tempTemplate;
    }

    // Build yt-dlp argument list
    let ytArgs = ['--no-playlist', '--no-part', '--no-mtime'];

    if (type === 'audio') {
        // Audio extraction
        ytArgs.push('-x');
        ytArgs.push('--audio-format', format);   // mp3 | m4a | flac | opus | aac
        ytArgs.push('--audio-quality', audioQuality);
        ytArgs.push('-f', 'bestaudio/best');
    } else {
        // Video download
        const fmtStr = buildFormat({ type, format, quality });
        ytArgs.push('-f', fmtStr);
        ytArgs.push('--merge-output-format', format === 'webm' ? 'webm' : format === 'mkv' ? 'mkv' : 'mp4');
    }

    ytArgs.push('-o', finalOutputTemplate, url);

    const { cmd, args } = getYtDlpArgs(ytArgs, url);

    console.log(`\n📥 Download request`);
    console.log(`   URL: ${url}`);
    console.log(`   Type: ${type} | Format: ${format} | Quality: ${quality}`);
    console.log(`   Save: ${saveLocally ? savePath : '→ stream to browser'}`);

    const proc = spawn(cmd, args);
    let stderrBuf = '';

    proc.stderr.on('data', d => {
        const line = d.toString().trim();
        stderrBuf += line + '\n';
        console.log('[yt-dlp]', line);
    });

    proc.on('error', err => {
        if (!res.headersSent) res.status(500).json({ error: 'Failed to start download: ' + err.message });
    });

    proc.on('close', code => {
        if (code !== 0) {
            if (!res.headersSent) res.status(500).json({
                error: 'Download failed. The URL may be invalid or the video unavailable.',
                details: stderrBuf.slice(-600)
            });
            return;
        }

        if (saveLocally) {
            // Find what file was written
            const outFile = findOutputFile(
                '', // use savePath scan
                savePath.trim(),
                safeTitle
            ) || path.join(savePath.trim(), filename);
            res.json({ success: true, savedTo: outFile, message: `Saved to ${savePath.trim()}` });
        } else {
            const outFile = findOutputFile(tempId);
            streamFileToResponse(outFile, filename, res, req);
        }
    });

    req.on('close', () => { try { proc.kill('SIGTERM'); } catch (_) { } });
});

/* ===========================
   GET /api/default-folder
   Returns the user's default Downloads directory
   =========================== */
app.get('/api/default-folder', (req, res) => {
    const downloads = path.join(os.homedir(), 'Downloads');
    res.json({ path: downloads, exists: fs.existsSync(downloads) });
});

/* ===========================
   POST /api/validate-folder
   Check if a given path is writable
   =========================== */
app.post('/api/validate-folder', express.json(), (req, res) => {
    const { folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ valid: false, error: 'No path provided' });
    try {
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }
        fs.accessSync(folderPath, fs.constants.W_OK);
        res.json({ valid: true });
    } catch (e) {
        res.json({ valid: false, error: e.message });
    }
});

/* ===========================
   Helpers (fixed findOutputFile)
   =========================== */
function findOutputFile(tempId, dir, baseName) {
    try {
        const searchDir = dir || os.tmpdir();
        const prefix = tempId || baseName;
        const files = fs.readdirSync(searchDir)
            .filter(f => f.startsWith(prefix))
            .map(f => path.join(searchDir, f))
            .filter(f => fs.statSync(f).isFile());
        return files.length > 0 ? files[0] : null;
    } catch (_) { return null; }
}

/* ===========================
   Fallback — serve frontend
   =========================== */
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ===========================
   Start
   =========================== */
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 VidSnap Server`);
    console.log(`📱 http://localhost:${PORT}`);
    console.log(`🎬 ffmpeg: ${FFMPEG_PATH || '❌ NOT FOUND'}`);
    console.log(`\nPress Ctrl+C to stop.\n`);
});
