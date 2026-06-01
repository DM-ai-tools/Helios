# ClickTrends AI Audit Platform

An AI-powered marketing audit platform that crawls websites, runs parallel Claude AI analysis across 6 specialist plugins, and generates comprehensive audit reports.

## Features

- **Website Crawler** — Scrapes 10+ pages, extracts meta signals, CTAs, schema, social links
- **Perplexity Web Research** — Live competitor intelligence, keyword research & SERP data
- **6 Parallel AI Plugins** (each with a dedicated Claude API key):
  - SEO Audit
  - Competitive Brief
  - Campaign Plan
  - Content & Copy
  - Email Sequence
  - Brand Review
- **PDF Report Generation** — Professional PDF via Puppeteer/OpenAI
- **Redis Caching** — Fast data retrieval and 7-day audit persistence

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Set up environment variables
cp .env.example .env
# Fill in your API keys

# 3. Start the server
npm start
```

Server runs at `http://localhost:3000`

## Environment Variables

See [.env.example](.env.example) for all required variables. Set these in Railway's dashboard.

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (plugin 1: brand-review) |
| `ANTHROPIC_API_KEY_2` | Claude API key (plugin 2: campaign-plan) |
| `ANTHROPIC_API_KEY_3` | Claude API key (plugin 3: competitive-brief) |
| `ANTHROPIC_API_KEY_4` | Claude API key (plugin 4: content-copy) |
| `ANTHROPIC_API_KEY_5` | Claude API key (plugin 5: email-sequence) |
| `ANTHROPIC_API_KEY_6` | Claude API key (plugin 6: seo-audit) |
| `OPENROUTER_API_KEY` | OpenRouter key for Perplexity web research |
| `REDIS_URL` | Redis connection URL (Railway adds this automatically) |
| `OPEN_AI_APIKEY` | OpenAI key for PDF report generation |
| `BASE_URL` | Public URL of your Railway deployment (e.g. https://your-app.railway.app) |

## Railway Deployment

1. Connect your GitHub repo to Railway
2. Add a **Redis** service in Railway (REDIS_URL is automatically injected)
3. Set all environment variables from the table above in the Railway dashboard
4. Railway will auto-detect the `Dockerfile` and deploy

## Tech Stack

- **Backend**: Node.js 20, Express
- **AI**: Anthropic Claude (claude-sonnet-4-5), OpenAI GPT
- **Web Research**: Perplexity via OpenRouter
- **Cache**: Redis
- **PDF**: Puppeteer + OpenAI
- **Frontend**: Vanilla HTML/CSS/JS
