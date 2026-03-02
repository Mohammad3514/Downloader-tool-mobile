# ==========================================
#  VidSnap — Dockerfile
#  Node.js 20 + Python3 + yt-dlp + ffmpeg
# ==========================================

FROM node:20-slim

# Install system deps
# python-is-python3 → creates 'python' symlink so server.js can call 'python'
RUN apt-get update && apt-get install -y \
  python3 \
  python3-pip \
  python3-venv \
  python-is-python3 \
  ffmpeg \
  curl \
  && rm -rf /var/lib/apt/lists/*

# Always install LATEST yt-dlp at build time
# (yt-dlp updates very frequently to keep up with YouTube changes)
RUN pip3 install --break-system-packages --upgrade yt-dlp

# Verify everything works
RUN python --version \
  && python3 --version \
  && python -m yt_dlp --version \
  && ffmpeg -version | head -1

# Working directory
WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Render injects $PORT at runtime (default 10000)
EXPOSE 10000

# Update yt-dlp on every container start too (catches updates between deploys)
CMD sh -c "pip3 install --break-system-packages --upgrade yt-dlp -q && node server.js"
