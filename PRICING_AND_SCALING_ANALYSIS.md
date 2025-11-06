# Pricing & Scaling Analysis

**Last Updated:** Current configuration analysis

---

## Executive Summary

This document provides:
- **Current API call costs** and pricing breakdown
- **1 hour of continuous speech** cost estimate (primary benchmark)
- **Scaling analysis** for multiple users
- **Architecture recommendations** for 100+ users
- **Cost optimization strategies**

---

## Current API Usage Patterns

### Primary APIs Used

1. **Google Cloud Speech-to-Text** (Transcription)
   - Model: `latest_long`
   - Streaming recognition
   - Used in Solo Mode

2. **OpenAI Chat Completions API** (Translation)
   - Model: `gpt-4o-mini`
   - Used for: Partial translations (live updates) + Final translations
   - Temperature: 0.2 (partials), 0.3 (finals)
   - Max tokens: 16,000 per request

3. **OpenAI Realtime API** (Alternative transcription/translation)
   - Model: `gpt-realtime` / `gpt-4o-transcribe`
   - Used in: Host Mode, Legacy Mode
   - WebSocket-based streaming

---

## Cost Breakdown: Single API Call

### OpenAI GPT-4o-mini Translation Call

**Current Configuration:**
- Model: `gpt-4o-mini`
- Max tokens: 16,000
- Typical usage: Partial translations (50-500 chars) + Final translations (100-2000 chars)

**Pricing (as of 2024):**
- Input: **$0.15 per 1M tokens**
- Output: **$0.60 per 1M tokens**

**Example: Single Partial Translation Call**

Assumptions:
- Input text: 100 characters ≈ 25 tokens (English)
- System prompt: ~150 tokens
- Output translation: 120 characters ≈ 30 tokens (Spanish)

**Token Calculation:**
```
Input tokens:
  - System prompt: 150 tokens
  - User text: 25 tokens
  - Total input: 175 tokens

Output tokens:
  - Translation: 30 tokens
```

**Cost per Call:**
```
Input cost:  (175 / 1,000,000) × $0.15  = $0.00002625
Output cost: (30 / 1,000,000) × $0.60   = $0.000018
Total:                                    = $0.00004425 per call
≈ $0.000044 per partial translation
```

**Example: Single Final Translation Call**

Assumptions:
- Input text: 500 characters ≈ 125 tokens
- System prompt: ~150 tokens
- Output translation: 600 characters ≈ 150 tokens

**Token Calculation:**
```
Input tokens: 275 tokens
Output tokens: 150 tokens
```

**Cost per Call:**
```
Input cost:  (275 / 1,000,000) × $0.15  = $0.00004125
Output cost: (150 / 1,000,000) × $0.60  = $0.00009
Total:                                    = $0.00013125 per call
≈ $0.00013 per final translation
```

### Google Cloud Speech-to-Text

**Pricing (as of 2024):**
- Streaming recognition: **$0.006 per 15 seconds** of audio
- Minimum charge: 1 second

**Cost per Second:**
```
$0.006 / 15 seconds = $0.0004 per second
```

**Cost per Minute:**
```
$0.0004 × 60 = $0.024 per minute
```

---

### Gemini 2.5 Flash Cost Reference (Historical Pricing)

The project previously used Google’s Gemini 2.5 Flash 001 model. Pricing below is taken from the user’s billing export (no discounts applied):

| SKU | Description | Unit | Rate | Notes |
|-----|-------------|------|------|-------|
| 328F-4ACF-2C92 | Audio input tokens | 1,000,000 tokens | **$3.00** | BidiGenerateContent audio input token count |
| A121-4A0A-8C2E | Text input tokens | 1,000,000 tokens | **$0.50** | BidiGenerateContent text input tokens |
| 5410-AB73-BCB9 | Text output tokens | 1,000,000 tokens | **$2.00** | BidiGenerateContent text output tokens |

**Comparative Notes:**
- The current OpenAI `gpt-4o-mini` configuration (input $0.15 / 1M, output $0.60 / 1M) is ~5× cheaper for input tokens and ~3× cheaper for output tokens than Gemini 2.5 Flash 001.
- Audio input pricing was $3.00 per 1M tokens for Gemini; OpenAI partial translation currently relies on pre-transcribed text instead of direct audio tokens, reducing cost exposure.
- Google Speech-to-Text (`$0.024/min`) remains the same regardless of the downstream translation engine.

---

## 1 Hour Continuous Speech: Cost Analysis

### Scenario: 1 Hour of Active Speech Translation

**Assumptions:**
- Continuous speech for 60 minutes
- Average speaking rate: 150 words/minute
- Average word length: 5 characters
- Translation updates: Every 2 characters or 20ms (current settings)
- Cache hit rate: 30% (estimated based on repetition)

### Transcription Costs (Google Speech)

```
60 minutes × $0.024/minute = $1.44
```

### Translation Costs (OpenAI GPT-4o-mini)

**Text Volume:**
```
60 minutes × 150 words/min × 5 chars/word = 45,000 characters
≈ 11,250 tokens (input)
```

**Translation Call Frequency:**

Current settings:
- Updates every 2 characters OR every 20ms
- Average word: 5 characters
- Updates per word: ~2.5 updates
- Words per minute: 150
- Updates per minute: 150 × 2.5 = 375 updates/minute

**With 30% cache hit rate:**
```
Effective updates: 375 × 0.7 = 262.5 API calls/minute
Total calls (60 min): 262.5 × 60 = 15,750 calls
```

**Average tokens per call:**
- Input: 175 tokens (system + text)
- Output: 30 tokens (translation)

**Total Cost Calculation:**
```
Input tokens:  15,750 calls × 175 tokens = 2,756,250 tokens
Output tokens: 15,750 calls × 30 tokens = 472,500 tokens

Input cost:  (2,756,250 / 1,000,000) × $0.15 = $0.413
Output cost: (472,500 / 1,000,000) × $0.60  = $0.284
Subtotal:                                      = $0.697
```

**Plus Final Translations:**
- Assumes 1 final per 10 seconds of speech (natural pauses)
- 60 minutes = 360 finals
- Average 500 chars per final

```
360 finals × $0.00013 = $0.047
```

### Total Cost: 1 Hour Continuous Speech

| Service | Cost |
|---------|------|
| Google Speech (transcription) | $1.44 |
| OpenAI Partial Translations | $0.697 |
| OpenAI Final Translations | $0.047 |
| **TOTAL** | **$2.18** |

**Cost per Minute:** $2.18 / 60 = **$0.036/minute**

**Cost per Hour:** **$2.18/hour**

---

## Scaling Analysis: Multiple Users

### Current Architecture Limitations

**Single Server Bottlenecks:**
1. **API Rate Limits:**
   - OpenAI: ~3,500 requests/minute (Tier 1)
   - Google Speech: ~1,000 concurrent streams per project

2. **Concurrent Request Handling:**
   - Current: `MAX_CONCURRENT = 3` per language pair
   - Single server can handle ~10-20 concurrent users efficiently

3. **Memory/CPU:**
   - In-memory caching (200 entries partial, 100 entries final)
   - WebSocket connections: ~1 per user
   - Estimated: 50-100 users per server (depending on hardware)

### Cost Projections: Multiple Users

| Users | Hours/Day | Cost/Hour | Daily Cost | Monthly Cost |
|-------|----------|-----------|------------|--------------|
| 1 | 1 | $2.18 | $2.18 | $65.40 |
| 10 | 1 | $2.18 | $21.80 | $654.00 |
| 50 | 1 | $2.18 | $109.00 | $3,270.00 |
| 100 | 1 | $2.18 | $218.00 | $6,540.00 |
| 100 | 8 | $2.18 | $1,744.00 | $52,320.00 |

**Assumptions:**
- Each user averages 1 hour of speech per day
- Costs scale linearly (no bulk discounts)
- Cache hit rates remain at 30%

### Load Capacity Analysis

**Current Single Server Capacity:**

| Resource | Limit | Users Supported |
|----------|-------|-----------------|
| OpenAI API Rate (3,500 req/min) | 3,500 req/min | ~14 users (at 250 req/min each) |
| Google Speech Streams | 1,000 concurrent | 1,000 users |
| WebSocket Connections | ~10,000 | 10,000 users |
| Memory (caching) | ~50MB | 50-100 users |
| CPU (translation processing) | Varies | 20-50 users |

**Bottleneck:** OpenAI API rate limits (most restrictive)

---

## Scaling Architecture: 100+ Users

### Recommended Architecture Changes

#### 1. **Horizontal Scaling with Load Balancing**

```
[Load Balancer]
    ↓
[Server 1] [Server 2] [Server 3] ... [Server N]
    ↓           ↓           ↓              ↓
[Redis Cache] [Database] [Message Queue]
```

**Benefits:**
- Distribute API calls across multiple servers
- Each server handles 20-50 users
- Shared cache reduces duplicate API calls

**Implementation:**
- Use Redis for shared caching
- Load balancer (nginx/HAProxy) for WebSocket connections
- Stateless servers (session data in Redis)

#### 2. **Redis-Based Caching Layer**

**Current:** In-memory cache (per server)
**Recommended:** Redis cluster for shared cache

**Benefits:**
- Cache hits across all servers
- Estimated cache hit rate: 30% → 50-60%
- Reduces API calls by 20-30%

**Cost Impact:**
- 100 users: $6,540/month → **$4,578/month** (30% reduction)

#### 3. **Message Queue for Translation Requests**

**Current:** Direct API calls (blocking)
**Recommended:** Queue-based async processing

**Architecture:**
```
[User Request] → [Queue] → [Worker Pool] → [OpenAI API]
```

**Benefits:**
- Better rate limit management
- Retry logic for failed requests
- Priority queuing (partials before finals)
- Burst handling

**Tools:**
- RabbitMQ / AWS SQS / Redis Queue
- Worker pool: 10-20 workers per server

#### 4. **API Key Rotation & Rate Limit Management**

**Current:** Single API key
**Recommended:** Multiple API keys with rotation

**Strategy:**
- 5-10 OpenAI API keys (different tiers)
- Round-robin or least-used selection
- Automatic fallback on rate limit errors

**Capacity Increase:**
- Single key: 3,500 req/min
- 10 keys: 35,000 req/min
- Supports: ~140 concurrent users

#### 5. **Database for Translation History**

**Current:** In-memory (lost on restart)
**Recommended:** PostgreSQL/MongoDB

**Benefits:**
- Persistent translation history
- Analytics and usage tracking
- Better cache key management
- User session persistence

#### 6. **CDN for Static Assets**

**Current:** Served from server
**Recommended:** CloudFront / Cloudflare

**Benefits:**
- Reduced server load
- Faster frontend delivery
- Lower bandwidth costs

### Recommended Stack for 100+ Users

```
Frontend:
  - React app (static hosting: S3 + CloudFront)
  - WebSocket connections to load balancer

Backend:
  - Node.js servers (3-5 instances)
  - Load balancer (nginx/HAProxy)
  - Redis cluster (caching + sessions)
  - PostgreSQL (translation history)
  - RabbitMQ / Redis Queue (translation jobs)
  - Monitoring: Prometheus + Grafana

Infrastructure:
  - AWS / GCP / Azure
  - Auto-scaling group (2-10 servers)
  - Database: RDS / Cloud SQL
  - Cache: ElastiCache (Redis)
```

### Cost Optimization Strategies

#### 1. **Aggressive Caching**

**Current:** 30% cache hit rate
**Target:** 60% cache hit rate

**Implementation:**
- Redis with longer TTL (5-10 minutes)
- Cache key optimization (normalize text)
- Pre-warming cache with common phrases

**Savings:** 30% reduction in API calls

#### 2. **Batch Translation Requests**

**Current:** Individual requests per update
**Recommended:** Batch similar requests

**Implementation:**
- Collect 5-10 similar translations
- Send as single batch request
- Distribute results back to users

**Savings:** 20-30% reduction in API calls

#### 3. **Smart Throttling**

**Current:** Fixed 20ms throttle
**Recommended:** Adaptive throttling based on:
- User activity level
- API rate limit status
- Cache hit rate

**Savings:** 10-15% reduction during peak

#### 4. **Translation Quality Tiers**

**Strategy:**
- Fast tier: GPT-4o-mini (current)
- Quality tier: GPT-4o (optional, premium users)
- Free tier: Cached translations only

**Savings:** Reduce costs for free users

#### 5. **User Rate Limiting**

**Implementation:**
- Free tier: 10 minutes/hour
- Paid tier: Unlimited
- Enterprise: Custom limits

**Benefits:** Predictable costs, prevents abuse

---

## Cost Projections: Optimized Architecture

### 100 Users (Optimized)

**Assumptions:**
- 60% cache hit rate (vs 30%)
- Batch processing: 20% reduction
- Smart throttling: 10% reduction
- Effective API call reduction: 50%

**Cost Calculation:**
```
Base cost: $6,540/month
Optimized: $6,540 × 0.5 = $3,270/month
Infrastructure: $500/month (servers, Redis, DB)
Total: $3,770/month
```

**Cost per User:** $3.77/month

### 500 Users (Optimized)

**Assumptions:**
- Same optimizations
- 10 servers (auto-scaling)
- Shared Redis cluster

**Cost Calculation:**
```
API costs: $32,700/month (500 × $65.40)
Optimized: $16,350/month (50% reduction)
Infrastructure: $2,000/month
Total: $18,350/month
```

**Cost per User:** $3.67/month

### 1,000 Users (Optimized)

**Cost Calculation:**
```
API costs: $65,400/month
Optimized: $32,700/month
Infrastructure: $4,000/month
Total: $36,700/month
```

**Cost per User:** $3.67/month

---

## Architecture Recommendations Summary

### For 10-50 Users (Current Scale)

**Recommended:**
- ✅ Single server (current architecture)
- ✅ In-memory caching (current)
- ✅ Direct API calls (current)
- ✅ Add: Basic monitoring

**Monthly Cost:** $65 - $3,270
**Infrastructure Cost:** $50-200/month

### For 50-200 Users

**Recommended:**
- ✅ 2-3 servers (load balanced)
- ✅ Redis cache (shared)
- ✅ Message queue (RabbitMQ/Redis)
- ✅ Database (PostgreSQL)
- ✅ API key rotation (3-5 keys)

**Monthly Cost:** $3,270 - $13,080
**Infrastructure Cost:** $500-1,000/month

### For 200-1,000 Users

**Recommended:**
- ✅ 5-10 servers (auto-scaling)
- ✅ Redis cluster (high availability)
- ✅ Message queue cluster
- ✅ Database cluster (read replicas)
- ✅ API key rotation (10+ keys)
- ✅ CDN for frontend
- ✅ Monitoring & alerting

**Monthly Cost:** $13,080 - $65,400
**Infrastructure Cost:** $2,000-5,000/month

---

## Key Metrics & Monitoring

### Critical Metrics to Track

1. **API Usage:**
   - Requests per minute
   - Tokens consumed
   - Rate limit errors
   - Cost per hour/day

2. **Performance:**
   - Translation latency (p50, p95, p99)
   - Cache hit rate
   - Queue depth
   - Server CPU/memory

3. **User Metrics:**
   - Active users
   - Average session length
   - API calls per user
   - Cost per user

### Recommended Monitoring Stack

- **Prometheus:** Metrics collection
- **Grafana:** Dashboards
- **AlertManager:** Rate limit alerts
- **Custom:** Cost tracking dashboard

---

## Cost Optimization Checklist

### Immediate (Low Effort, High Impact)

- [ ] Implement Redis caching (30% → 50% hit rate)
- [ ] Add API key rotation (2-3 keys)
- [ ] Implement user rate limiting
- [ ] Add cost tracking/monitoring

**Estimated Savings:** 20-30%

### Short Term (Medium Effort)

- [ ] Implement message queue
- [ ] Batch translation requests
- [ ] Optimize cache keys
- [ ] Add translation quality tiers

**Estimated Savings:** Additional 20-30%

### Long Term (High Effort)

- [ ] Horizontal scaling architecture
- [ ] Database for history/analytics
- [ ] CDN for static assets
- [ ] Advanced monitoring & alerting

**Estimated Savings:** Enables 10x scale

---

## Summary

### Current Costs

- **1 hour continuous speech:** $2.18 (OpenAI + Google Speech)
- **Gemini 2.5 Flash reference:** $3.00 / 1M audio tokens, $0.50 / 1M text input, $2.00 / 1M text output
- **1 user/month (1hr/day):** $65.40
- **10 users/month:** $654.00
- **100 users/month:** $6,540.00

### Scaling Capacity

- **Current architecture:** 20-50 users
- **With optimizations:** 200-500 users
- **With full scaling:** 1,000+ users

### Cost per User (Optimized)

- **10-50 users:** $3.50-4.00/user/month
- **50-200 users:** $3.50-3.70/user/month
- **200-1,000 users:** $3.50-3.70/user/month

### Next Steps

1. **Immediate:** Add Redis caching + API key rotation
2. **Short term:** Implement message queue + batching
3. **Long term:** Full horizontal scaling architecture

---

## Notes

- All costs are estimates based on current OpenAI pricing (subject to change)
- Google Speech pricing is per-second billing
- Cache hit rates improve with more users (more repetition)
- Infrastructure costs vary by cloud provider
- Consider reserved instances for predictable workloads

