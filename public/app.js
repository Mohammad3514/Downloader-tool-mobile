/* =========================================
   VidSnap — Frontend Application Logic
   ========================================= */

const API_BASE = window.location.origin;

/* ===========================
   State
   =========================== */
let videoData = null;

// Download settings state
const settings = {
    type: 'video',       // 'video' | 'audio'
    videoFormat: 'mp4',  // 'mp4' | 'webm' | 'mkv'
    videoQuality: 'best',
    audioFormat: 'mp3',  // 'mp3' | 'm4a' | 'flac' | 'opus'
    audioQuality: '0',   // '0'=best | '2'=320k | '4'=192k | '5'=128k | '7'=64k
    saveMode: 'browser', // 'browser' | 'folder'
    savePath: '',
};

/* ===========================
   DOM References
   =========================== */
const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const pasteBtn = document.getElementById('pasteBtn');
const clearBtn = document.getElementById('clearBtn');
const inputWrap = document.getElementById('inputWrap');
const loadingSection = document.getElementById('loadingSection');
const errorSection = document.getElementById('errorSection');
const videoSection = document.getElementById('videoSection');
const statusBadge = document.getElementById('statusBadge');

/* ===========================
   PWA Install Prompt
   =========================== */
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredInstallPrompt = e;
    const banner = document.getElementById('installBanner');
    if (banner) banner.classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
    const banner = document.getElementById('installBanner');
    if (banner) banner.classList.add('hidden');
    _deferredInstallPrompt = null;
    showToast('✅ VidSnap installed on home screen!', 'success', 4000);
});

/* ===========================
   Init
   =========================== */
document.addEventListener('DOMContentLoaded', () => {
    checkServerStatus();

    urlInput.addEventListener('input', onInputChange);
    urlInput.addEventListener('paste', () => setTimeout(onInputChange, 10));
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchVideoInfo(); });

    // Install banner buttons
    const installBtn = document.getElementById('installBtn');
    const installDismiss = document.getElementById('installDismiss');
    const installBanner = document.getElementById('installBanner');
    if (installBtn) installBtn.addEventListener('click', async () => {
        if (_deferredInstallPrompt) {
            _deferredInstallPrompt.prompt();
            const { outcome } = await _deferredInstallPrompt.userChoice;
            if (outcome === 'accepted' && installBanner) installBanner.classList.add('hidden');
            _deferredInstallPrompt = null;
        }
    });
    if (installDismiss) installDismiss.addEventListener('click', () => {
        if (installBanner) installBanner.classList.add('hidden');
    });

    // Folder path input: load default Downloads path
    loadDefaultFolder();

    // Folder path input keydown
    const folderInput = document.getElementById('folderPathInput');
    if (folderInput) {
        folderInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') validateFolder(); });
        folderInput.addEventListener('input', () => {
            settings.savePath = folderInput.value.trim();
            const status = document.getElementById('folderStatus');
            if (status) { status.textContent = ''; status.className = 'folder-status'; }
        });
    }
});

async function loadDefaultFolder() {
    try {
        const res = await fetch(`${API_BASE}/api/default-folder`);
        const data = await res.json();
        const input = document.getElementById('folderPathInput');
        if (input && data.path) {
            input.placeholder = data.path;
            settings.savePath = data.path;
        }
    } catch (_) { }
}

/* ===========================
   Server Status Check
   =========================== */
async function checkServerStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/check`);
        const data = await res.json();
        const label = statusBadge.querySelector('.status-label');
        if (data.ytdlpInstalled) {
            statusBadge.className = 'status-badge ok';
            label.textContent = 'Ready';
        } else {
            statusBadge.className = 'status-badge error';
            label.textContent = 'yt-dlp missing';
            showToast('⚠️ yt-dlp not found. Run: pip install yt-dlp', 'error', 5000);
        }
    } catch (_) {
        const label = statusBadge.querySelector('.status-label');
        statusBadge.className = 'status-badge error';
        label.textContent = 'Server error';
    }
}

/* ===========================
   Input Controls
   =========================== */
function onInputChange() {
    const val = urlInput.value.trim();
    clearBtn.classList.toggle('hidden', !val);
    if (val) inputWrap.classList.remove('has-error');
}

pasteBtn.addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        if (text) { urlInput.value = text; onInputChange(); showToast('📋 Pasted!', 'info'); }
    } catch (_) {
        urlInput.focus();
        showToast('Tap the input and paste manually', 'info');
    }
});

clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    clearBtn.classList.add('hidden');
    inputWrap.classList.remove('has-error');
    urlInput.focus();
});

/* ===========================
   Fetch Video Info
   =========================== */
async function fetchVideoInfo() {
    const url = urlInput.value.trim();
    if (!url) {
        inputWrap.classList.add('has-error');
        showToast('Please enter a video URL', 'error');
        return;
    }
    if (!isValidUrl(url)) {
        inputWrap.classList.add('has-error');
        showToast('Please enter a valid URL', 'error');
        return;
    }

    inputWrap.classList.remove('has-error');
    setSection('loading');
    fetchBtn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/api/info?url=${encodeURIComponent(url)}`);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Failed to analyze video');

        videoData = data;
        renderVideoInfo(data);
        setSection('video');
        showToast(`✅ Found: ${data.platform} video`, 'success');
    } catch (err) {
        document.getElementById('errorMessage').textContent = err.message || 'Unknown error';
        setSection('error');
        showToast('Failed to analyze video', 'error');
    } finally {
        fetchBtn.disabled = false;
    }
}

function isValidUrl(str) {
    try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch { return false; }
}

/* ===========================
   Render Video Info
   =========================== */
function renderVideoInfo(data) {
    const thumb = document.getElementById('videoThumb');
    if (data.thumbnail) {
        thumb.src = data.thumbnail;
        thumb.onerror = () => { thumb.src = genPlaceholderThumb(data.platform); };
    } else {
        thumb.src = genPlaceholderThumb(data.platform);
    }

    document.getElementById('platformBadge').textContent = data.platform;
    document.getElementById('videoTitle').textContent = data.title;
    document.getElementById('videoUploader').querySelector('span').textContent = data.uploader || 'Unknown';

    const durEl = document.getElementById('videoDuration');
    if (data.duration) {
        durEl.querySelector('span').textContent = formatDuration(data.duration);
        durEl.classList.remove('hidden');
    } else {
        durEl.classList.add('hidden');
    }

    updateDownloadButton();
}

function genPlaceholderThumb(platform) {
    const colors = {
        YouTube: ['#ff0000', '#cc0000'], Instagram: ['#e1306c', '#833ab4'],
        TikTok: ['#111', '#000'], Twitter: ['#1da1f2', '#0d8ecf'],
        Facebook: ['#1877f2', '#1466d0'], Vimeo: ['#1ab7ea', '#0e8fbc'], Reddit: ['#ff4500', '#cc3a00'],
    };
    const c = colors[platform] || ['#7c3aed', '#5b21b6'];
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='80' viewBox='0 0 120 80'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='${c[0]}'/><stop offset='100%' stop-color='${c[1]}'/></linearGradient></defs><rect width='120' height='80' fill='url(#g)'/><polygon points='46,25 46,55 78,40' fill='rgba(255,255,255,0.7)'/></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function formatDuration(s) {
    if (!s) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

/* ===========================
   Settings State Functions
   =========================== */
function setType(type) {
    settings.type = type;

    document.getElementById('typeVideo').classList.toggle('active', type === 'video');
    document.getElementById('typeAudio').classList.toggle('active', type === 'audio');
    document.getElementById('videoSettings').classList.toggle('hidden', type !== 'video');
    document.getElementById('audioSettings').classList.toggle('hidden', type !== 'audio');

    updateDownloadButton();
}

function setVideoFormat(fmt) {
    settings.videoFormat = fmt;
    setChipActive('videoFormatChips', fmt);
    updateDownloadButton();
}

function setVideoQuality(q) {
    settings.videoQuality = q;
    setChipActive('videoQualityChips', q);
    updateDownloadButton();
}

function setAudioFormat(fmt) {
    settings.audioFormat = fmt;
    setChipActive('audioFormatChips', fmt);
    updateDownloadButton();
}

function setAudioQuality(q) {
    settings.audioQuality = q;
    setChipActive('audioQualityChips', q);
    updateDownloadButton();
}

function setSaveMode(mode) {
    settings.saveMode = mode;
    document.getElementById('saveBrowser').classList.toggle('active', mode === 'browser');
    document.getElementById('saveFolder').classList.toggle('active', mode === 'folder');

    const wrap = document.getElementById('folderPathWrap');
    wrap.classList.toggle('hidden', mode !== 'folder');

    if (mode === 'folder') {
        const input = document.getElementById('folderPathInput');
        // Pre-fill with default Downloads if empty
        if (!input.value.trim()) {
            fetch(`${API_BASE}/api/default-folder`)
                .then(r => r.json())
                .then(d => {
                    if (d.path && !input.value) {
                        input.value = d.path;
                        settings.savePath = d.path;
                    }
                }).catch(() => { });
        }
    }
}

function setChipActive(containerId, value) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('[data-val]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.val === value);
    });
}

/* ===========================
   Update Download Button Label
   =========================== */
function updateDownloadButton() {
    const btnText = document.getElementById('dlBtnText');
    const btnBadge = document.getElementById('dlBtnBadge');
    if (!btnText || !btnBadge) return;

    if (settings.type === 'audio') {
        const fmt = settings.audioFormat.toUpperCase();
        const qLabels = { '0': 'Best', '2': '320kbps', '4': '192kbps', '5': '128kbps', '7': '64kbps' };
        const ql = qLabels[settings.audioQuality] || 'Best';
        btnText.textContent = `Download ${fmt}`;
        btnBadge.textContent = `Audio · ${ql}`;
    } else {
        const fmt = settings.videoFormat.toUpperCase();
        const q = settings.videoQuality === 'best' ? 'HD' : settings.videoQuality + 'p';
        btnText.textContent = `Download ${fmt}`;
        btnBadge.textContent = `${q} + Audio`;
    }
}

/* ===========================
   Validate Save Folder
   =========================== */
async function validateFolder() {
    const input = document.getElementById('folderPathInput');
    const status = document.getElementById('folderStatus');
    const folderPath = input.value.trim();

    if (!folderPath) {
        status.textContent = '⚠️ Please enter a folder path';
        status.className = 'folder-status err';
        return;
    }

    status.textContent = 'Checking...';
    status.className = 'folder-status';

    try {
        const res = await fetch(`${API_BASE}/api/validate-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const data = await res.json();
        if (data.valid) {
            status.textContent = '✓ Folder is valid and writable';
            status.className = 'folder-status ok';
            settings.savePath = folderPath;
            showToast('✅ Save folder confirmed!', 'success');
        } else {
            status.textContent = `✗ ${data.error || 'Invalid folder'}`;
            status.className = 'folder-status err';
        }
    } catch (_) {
        status.textContent = '✗ Could not validate folder';
        status.className = 'folder-status err';
    }
}

/* ===========================
   Download
   =========================== */
async function startDownload() {
    if (!videoData) return;

    const dlBtn = document.getElementById('downloadBtn');
    const progressWrap = document.getElementById('downloadProgress');
    const progressBar = document.getElementById('progressBar');
    const progressLabel = document.getElementById('progressLabel');

    // Determine save path
    const savePath = settings.saveMode === 'folder'
        ? (document.getElementById('folderPathInput')?.value.trim() || settings.savePath)
        : '';

    // Validate folder path if custom mode
    if (settings.saveMode === 'folder' && !savePath) {
        showToast('Please enter a folder path first', 'error');
        return;
    }

    dlBtn.disabled = true;
    progressWrap.classList.remove('hidden');
    progressBar.style.width = '0%';
    progressLabel.textContent = settings.type === 'audio' ? 'Extracting audio...' : 'Downloading & merging...';

    // Animated progress
    let fakeProgress = 0;
    const interval = setInterval(() => {
        if (fakeProgress < 88) {
            fakeProgress += Math.random() * 5;
            progressBar.style.width = Math.min(fakeProgress, 88) + '%';
        }
    }, 700);

    try {
        showToast(settings.type === 'audio' ? '🎵 Extracting audio...' : '⬇️ Starting download...', 'info');

        const params = new URLSearchParams({
            url: videoData.originalUrl,
            type: settings.type,
            format: settings.type === 'audio' ? settings.audioFormat : settings.videoFormat,
            quality: settings.videoQuality,
            audioQuality: settings.audioQuality,
            title: videoData.title,
            ...(savePath ? { savePath } : {}),
        });

        const downloadUrl = `${API_BASE}/api/download?${params}`;

        if (savePath) {
            // "Save to folder" mode — fetch JSON response
            const res = await fetch(downloadUrl);
            const data = await res.json();
            clearInterval(interval);

            if (data.success) {
                progressBar.style.width = '100%';
                progressLabel.textContent = `✅ Saved to: ${data.savedTo || savePath}`;
                showToast(`🎉 Saved to folder!`, 'success', 5000);
            } else {
                throw new Error(data.error || 'Save failed');
            }
        } else {
            // "Browser download" mode — fetch as blob so we detect server errors
            progressLabel.textContent = settings.type === 'audio' ? 'Fetching audio from server...' : 'Fetching video from server...';

            const res = await fetch(downloadUrl);
            clearInterval(interval);

            // Check for HTTP error
            if (!res.ok) {
                let errMsg = `Server error (${res.status})`;
                try {
                    const errData = await res.json();
                    errMsg = errData.error || errMsg;
                    if (errData.details) console.error('yt-dlp stderr:', errData.details);
                } catch (_) { }
                throw new Error(errMsg);
            }

            // If content-type is JSON it means server sent an error object
            const contentType = res.headers.get('Content-Type') || '';
            if (contentType.includes('application/json')) {
                let errMsg = 'Download failed — server returned an error.';
                try {
                    const errData = await res.json();
                    errMsg = errData.error || errMsg;
                } catch (_) { }
                throw new Error(errMsg);
            }

            // Good — stream to blob and trigger save-as dialog
            progressBar.style.width = '95%';
            progressLabel.textContent = 'Preparing file…';
            const blob = await res.blob();
            const ext = settings.type === 'audio' ? settings.audioFormat : settings.videoFormat;
            const safeTitle = (videoData.title.replace(/[^\w\s\-]/g, '').trim().slice(0, 60) || 'video');
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `${safeTitle}.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

            progressBar.style.width = '100%';
            progressLabel.textContent = '✅ Download started — check your browser downloads!';
            showToast('🎉 Download started!', 'success', 4000);
        }
    } catch (err) {
        clearInterval(interval);
        progressBar.style.width = '0%';
        progressLabel.textContent = '✗ Download failed.';
        showToast('❌ ' + (err.message || 'Download failed'), 'error', 5000);
    }

    dlBtn.disabled = false;
}

/* ===========================
   UI State
   =========================== */
function setSection(section) {
    loadingSection.classList.add('hidden');
    errorSection.classList.add('hidden');
    videoSection.classList.add('hidden');
    if (section === 'loading') loadingSection.classList.remove('hidden');
    else if (section === 'error') errorSection.classList.remove('hidden');
    else if (section === 'video') videoSection.classList.remove('hidden');
}

function resetApp() {
    videoData = null;
    urlInput.value = '';
    clearBtn.classList.add('hidden');
    inputWrap.classList.remove('has-error');
    setSection(null);

    const dlBtn = document.getElementById('downloadBtn');
    if (dlBtn) dlBtn.disabled = false;
    const progressWrap = document.getElementById('downloadProgress');
    if (progressWrap) progressWrap.classList.add('hidden');
    const progressBar = document.getElementById('progressBar');
    if (progressBar) progressBar.style.width = '0%';

    // Reset settings UI to defaults
    setType('video');
    setVideoFormat('mp4');
    setVideoQuality('best');
    setAudioFormat('mp3');
    setAudioQuality('0');
    setSaveMode('browser');

    urlInput.focus();
}

/* ===========================
   Toast
   =========================== */
let toastTimeout;
function showToast(message, type = 'info', duration = 2800) {
    let toast = document.querySelector('.toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    clearTimeout(toastTimeout);
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toast.offsetHeight; // force reflow
    toast.classList.add('show');
    toastTimeout = setTimeout(() => toast.classList.remove('show'), duration);
}
