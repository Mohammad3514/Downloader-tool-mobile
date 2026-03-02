# ==========================================
#  VidSnap — Dockerfile
#  Node.js + Python3 + yt-dlp + ffmpeg
# ==========================================

FROM node:20-slim

# Install system deps: Python 3, pip, ffmpeg
# python-is-python3 creates the 'python' → 'python3' symlink
RUN apt-get update && apt-get install -y \
  python3 \
  python3-pip \
  python3-venv \
  python-is-python3 \
  ffmpeg \
  curl \
  && rm -rf /var/lib/apt/lists/*

# Install yt-dlp system-wide
RUN pip3 install --break-system-packages yt-dlp

# Verify both 'python' and 'python3' both work
RUN python --version && python3 --version && python -m yt_dlp --version && ffmpeg -version | head -1

# Set working directory
WORKDIR /app

# Copy package files and install Node deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the app
COPY . .

# Expose port (Render injects $PORT at runtime)
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3001}/api/check || exit 1

# Start the server
CMD ["node", "server.js"]
