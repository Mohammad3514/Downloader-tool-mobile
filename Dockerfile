# ==========================================
#  VidSnap — Dockerfile
#  Node.js + Python + yt-dlp + ffmpeg
# ==========================================

FROM node:20-slim

# Install system deps: Python, pip, ffmpeg
RUN apt-get update && apt-get install -y \
  python3 \
  python3-pip \
  python3-venv \
  ffmpeg \
  curl \
  && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip (system-wide, no venv needed in Docker)
RUN pip3 install --break-system-packages yt-dlp

# Verify installations
RUN python3 -m yt_dlp --version && ffmpeg -version | head -1

# Set working directory
WORKDIR /app

# Copy package files and install Node deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the app
COPY . .

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3001/api/check || exit 1

# Start the server
CMD ["node", "server.js"]
