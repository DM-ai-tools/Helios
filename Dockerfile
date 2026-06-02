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

# Install all production dependencies
# PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false lets Puppeteer download its own Chromium
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

# Copy application source
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY package*.json ./
COPY .puppeteerrc.cjs ./

# Create reports directory (PDF output)
RUN mkdir -p reports

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
