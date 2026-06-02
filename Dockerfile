# ============================================================
# ClickTrends AI Audit — Dockerfile
# Based on official Puppeteer troubleshooting guide:
# https://pptr.dev/troubleshooting
#
# Strategy: Install ALL official Debian dependencies listed by
# the Puppeteer docs, then use @sparticuz/chromium with the
# binary baked into the image at a fixed path during build.
# Run as root to avoid all permission issues in Railway.
# ============================================================

FROM node:20-slim

# ALL Debian dependencies listed in https://pptr.dev/troubleshooting
# under "Chrome doesn't launch on Linux > Debian Dependencies"
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
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
    fonts-noto-color-emoji \
    --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# Skip Puppeteer's own bundled Chromium — we use @sparticuz/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /app

# Install dependencies — npm install (not npm ci) so it reads package.json
# directly in case package-lock.json is stale
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── Pre-bake the @sparticuz/chromium binary into the image ─────
# Run extraction as root during build. The binary is decompressed
# to /app/chromium-binary and marked executable. This is a permanent
# file in the image layer — no runtime writes to /tmp needed.
RUN mkdir -p /app/chromium-binary
RUN node -e " \
  const { execSync } = require('child_process'); \
  import('@sparticuz/chromium').then(async (mod) => { \
    const chromium = mod.default; \
    const p = await chromium.executablePath('/app/chromium-binary'); \
    console.log('[Build] @sparticuz/chromium extracted to:', p); \
    execSync('chmod -R 755 /app/chromium-binary'); \
    execSync('ls -lh /app/chromium-binary'); \
  }).catch(err => { console.error('[Build] Extraction failed:', err); process.exit(1); }); \
"

# Confirm the binary exists and is executable before continuing
RUN test -f /app/chromium-binary && echo '[Build] Binary OK' || (echo '[Build] Binary MISSING' && exit 1)

# Set the path so both service files find it immediately
ENV CHROMIUM_BINARY_PATH=/app/chromium-binary

# Copy application source
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create writable directories the app needs at runtime
RUN mkdir -p reports

# ── Run as root ────────────────────────────────────────────────
# Per Puppeteer docs, running as non-root in containers requires
# sandbox configuration. Since we use --no-sandbox in our launch
# args (trusted internal content only), running as root is safe
# and eliminates all permission-related launch failures.
# Do NOT add a USER directive — keep root for Railway compatibility.

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "backend/server.js"]
