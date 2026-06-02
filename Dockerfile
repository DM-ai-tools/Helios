# ============================================================
# ClickTrends AI Audit — Dockerfile
# Uses system Chromium (apt) instead of Puppeteer's bundled
# Chromium. This is the most reliable approach for Railway/
# Docker environments — no crashpad issues, no missing libs.
# ============================================================

FROM node:20-slim

# Install system Chromium + all libraries it needs
# chromium is the Debian package — already patched for containers
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
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
    --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium we just installed,
# and skip downloading its own bundled Chromium during npm ci.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

ENV NODE_ENV=production

WORKDIR /app

# Install dependencies — Puppeteer download is skipped by PUPPETEER_SKIP_DOWNLOAD
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create writable directories that Chrome needs at runtime
RUN mkdir -p reports \
             /tmp/puppeteer-user-data \
             /tmp/puppeteer-gpt-user-data \
             /tmp/chrome-crashes

# Non-root user for security
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 appuser \
 && chown -R appuser:nodejs /app \
 && chown -R appuser:nodejs /tmp/puppeteer-user-data \
 && chown -R appuser:nodejs /tmp/puppeteer-gpt-user-data \
 && chown -R appuser:nodejs /tmp/chrome-crashes
USER appuser

EXPOSE 3000

# Health check — Railway uses this to confirm the container is serving traffic
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "backend/server.js"]
