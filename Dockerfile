# ============================================================
# ClickTrends AI Audit — Dockerfile
# Based on official Puppeteer troubleshooting guide:
# https://pptr.dev/troubleshooting
#
# Runs as root — eliminates all EACCES/permission issues.
# @sparticuz/chromium extracts its crashpad-free binary to
# /tmp/chromium at first launch (root can always write /tmp).
# ============================================================

FROM node:20-slim

# ALL Debian dependencies listed in https://pptr.dev/troubleshooting
# under "Chrome doesn't launch on Linux > Debian Dependencies"
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# Skip Puppeteer's own bundled Chromium — we use @sparticuz/chromium instead
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /app

# Install dependencies — npm install reads package.json directly
# (bypasses any stale package-lock.json)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create app directories
RUN mkdir -p reports

# No USER directive — run as root.
# Per pptr.dev/troubleshooting, non-root containers require sandbox
# configuration. We use --no-sandbox (trusted internal content).
# Running as root + --no-sandbox is the standard Railway pattern
# and eliminates all EACCES launch failures.
#
# @sparticuz/chromium will extract its binary to /tmp/chromium on
# first launch. Root always has write access to /tmp.

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npm", "start"]
