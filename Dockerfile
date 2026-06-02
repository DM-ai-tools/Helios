# ============================================================
# ClickTrends AI Audit — Dockerfile
# Uses @sparticuz/chromium — crashpad-free Chromium binary
# compiled specifically for container environments.
#
# The binary is pre-extracted during build (as root) into /app
# so the non-root appuser never needs to write to /tmp at runtime.
# ============================================================

FROM node:20-slim

# System libraries the Chromium binary links against at runtime
RUN apt-get update && apt-get install -y \
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

# Skip bundled Puppeteer Chromium download — we use @sparticuz/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /app

# Install dependencies (npm install reads package.json directly,
# bypassing any stale package-lock.json)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── Pre-extract @sparticuz/chromium binary during build ────────
# Extracted as root into /app/chromium-binary so the non-root
# appuser never needs to write to /tmp at runtime.
# We set a fixed extraction path via CHROMIUM_PATH so the code
# can find it without needing to decompress again.
RUN node -e "import('@sparticuz/chromium').then(async (mod) => { \
      const chromium = mod.default; \
      const p = await chromium.executablePath('/app/chromium-binary'); \
      console.log('[Docker build] Chromium pre-extracted to:', p); \
    }).catch(e => { console.error(e); process.exit(1); })"

# Mark the binary executable (should already be set by sparticuz, but be explicit)
RUN chmod 755 /app/chromium-binary

# Expose the pre-extracted path as an env variable the service code reads
ENV CHROMIUM_BINARY_PATH=/app/chromium-binary

# Copy application source
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create writable directories the app and Chrome need at runtime
RUN mkdir -p reports \
             /tmp/puppeteer-user-data \
             /tmp/puppeteer-gpt-user-data

# Non-root user for security
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 appuser \
 && chown -R appuser:nodejs /app \
 && chmod 1777 /tmp
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "backend/server.js"]
