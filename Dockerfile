# ============================================================
# ClickTrends AI Audit — Dockerfile
# Multi-stage build optimized for Railway deployment
# ============================================================

# ─── Stage 1: Install dependencies ───────────────────────────
FROM node:20-slim AS deps

# Install system deps needed by Puppeteer (headless Chromium)
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
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Copy the Puppeteer config BEFORE npm ci so Chromium is downloaded
# to the path defined by cacheDirectory (/app/.cache/puppeteer).
# Without this, Puppeteer uses its default location (/root/.cache/puppeteer)
# which is never transferred to the runner stage.
COPY .puppeteerrc.cjs ./

# Install all production dependencies + download Puppeteer's bundled Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
ENV NODE_ENV=production
RUN npm ci --omit=dev

# ─── Stage 2: Production image ────────────────────────────────
FROM node:20-slim AS runner

# Install runtime-only system deps for Puppeteer
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
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
    wget \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules (with Puppeteer's Chromium) from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy the Puppeteer Chromium cache from the deps stage.
# This is the binary that npm ci downloaded into /app/.cache/puppeteer
# (the path set by .puppeteerrc.cjs in stage 1).
COPY --from=deps /app/.cache ./.cache

# Copy application source
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY package*.json ./
COPY .puppeteerrc.cjs ./

# Create reports directory (PDF output)
RUN mkdir -p reports

# Pre-create writable /tmp dirs that Chrome needs in restricted containers
# (userDataDir and crash-dumps-dir — must exist and be writable by appuser)
RUN mkdir -p /tmp/puppeteer-user-data /tmp/puppeteer-gpt-user-data /tmp/chrome-crashes

# Use a non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser && \
    chown -R appuser:nodejs /app
USER appuser

# Puppeteer: use the bundled Chromium from node_modules (already present from deps stage)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
ENV NODE_ENV=production
EXPOSE 3000

# Health check — Railway uses this to confirm the container is serving traffic
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the application
CMD ["node", "backend/server.js"]
