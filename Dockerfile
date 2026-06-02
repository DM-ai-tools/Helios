# ============================================================
# ClickTrends AI Audit — Dockerfile
# Uses @sparticuz/chromium — a pre-compiled Chromium with
# crashpad completely removed, purpose-built for containers.
# No apt chromium needed. No bundled Puppeteer Chromium needed.
# ============================================================

FROM node:20-slim

# System libraries that the @sparticuz/chromium binary links against.
# No 'chromium' apt package needed — the binary ships inside the npm package.
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

# Skip downloading Puppeteer's own bundled Chromium — we use @sparticuz/chromium instead
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
# Use npm install (not npm ci) so it reads package.json directly.
# package-lock.json may be stale if dependencies were added without
# running npm install locally (e.g. due to PowerShell execution policy).
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create writable directories Chrome needs at runtime
# /tmp/chromium is where @sparticuz/chromium extracts its binary
RUN mkdir -p reports \
             /tmp/chromium \
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
