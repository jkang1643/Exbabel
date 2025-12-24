---
name: Expose WebSocket API with Security
overview: Add a secure WebSocket API endpoint (/api/translate) that exposes the transcription and translation engine for external clients, with comprehensive security measures including rate limiting, authentication, input validation, and proper CORS configuration.
todos:
  - id: create-api-handler
    content: Create backend/apiWebSocketHandler.js that wraps solo mode logic and handles API connections
    status: completed
  - id: update-server-routing
    content: Add /api/translate WebSocket endpoint routing in backend/server.js
    status: completed
    dependencies:
      - create-api-handler
  - id: add-message-keys
    content: Add 'transcript' and 'translation' keys to message format in soloModeHandler.js sendWithSequence helper
    status: completed
  - id: handle-pcm-audio
    content: Implement raw PCM audio chunk processing in apiWebSocketHandler.js
    status: completed
    dependencies:
      - create-api-handler
  - id: add-port-config
    content: Add WS_API_PORT environment variable support and separate API server if needed
    status: completed
    dependencies:
      - update-server-routing
  - id: test-multi-client
    content: Verify multiple clients can connect simultaneously and receive independent streams
    status: completed
    dependencies:
      - create-api-handler
      - update-server-routing
---

# Expose Exbabel Backend as WebSocket API (Secure)

## Overview

Add a new secure WebSocket API endpoint (`/api/translate`) that allows external clients (like Python overlay) to connect and receive real-time transcription and translation. The API will include comprehensive security measures: rate limiting, API key authentication, input validation, and proper CORS configuration.

## Security Architecture

```mermaid
graph TB
    Client[External Client] -->|WebSocket + API Key| APIEndpoint[/api/translate]
    Frontend[Browser Frontend] -->|WebSocket| ExistingEndpoint[/translate]
    
    APIEndpoint --> Auth[API Key Auth]
    Auth --> RateLimit[Rate Limiter]
    RateLimit --> Validate[Input Validator]
    Validate --> APIHandler[apiWebSocketHandler.js]
    
    ExistingEndpoint --> SoloHandler[soloModeHandler.js]
    
    APIHandler --> CoreEngine[CoreEngine]
    SoloHandler --> CoreEngine
    
    CoreEngine --> GoogleSpeech[Google Speech API]
    CoreEngine --> OpenAI[OpenAI Translation]
    
    APIHandler -->|JSON Response| Client
    SoloHandler -->|JSON Response| Frontend
```



## Security Requirements

### 1. API Key Authentication

- Require API key in WebSocket connection (query parameter or initial message)
- Store API keys in environment variables or secure key store
- Validate API key before processing any requests
- Support API key rotation without downtime

### 2. Rate Limiting

- Per-client rate limiting (connections, messages per second, audio chunks per second)
- Per-API-key rate limiting (prevent single key abuse)
- Global rate limiting (protect backend resources)
- Configurable limits via environment variables
- Return rate limit errors with retry-after headers

### 3. Input Validation

- Validate language codes against allowed list
- Validate audio chunk size (max size limits)
- Validate audio format (PCM sample rate, bit depth)
- Sanitize all string inputs
- Reject malformed JSON messages
- Timeout handling for slow/stuck connections

### 4. CORS Configuration

- Restrict CORS to specific allowed origins (remove wildcards)
- Remove HTTP fallback in production
- Separate CORS config for API endpoint vs frontend
- Validate Origin header for WebSocket connections

### 5. API Key Management

- Never expose API keys in client code
- Use server-side API key validation
- Support multiple API keys (for different clients/apps)
- Log API key usage for monitoring
- Implement key revocation

## Implementation Plan

### 1. Create API Key Manager

**File**: `backend/apiKeyManager.js`

- Store and validate API keys (from environment variables or database)
- Support multiple keys with metadata (client name, rate limits, etc.)
- Track usage per key
- Implement key rotation

### 2. Create Rate Limiter for WebSocket Connections

**File**: `backend/wsRateLimiter.js`

- Per-connection rate limiting (messages, audio chunks)
- Per-API-key rate limiting
- Global rate limiting
- Sliding window algorithm
- Configurable limits via environment variables

### 3. Create Input Validator

**File**: `backend/inputValidator.js`

- Validate language codes (whitelist approach)
- Validate audio chunk format and size
- Validate message structure
- Sanitize string inputs
- Return clear error messages

### 4. Create Secure API WebSocket Handler

**File**: `backend/apiWebSocketHandler.js`

- Require API key authentication (query param or init message)
- Apply rate limiting before processing
- Validate all inputs
- Transform messages to include `transcript`/`translation` keys
- Handle connection lifecycle securely

### 5. Update Server with Security Middleware

**File**: `backend/server.js`

- Add API endpoint with authentication middleware
- Separate CORS config for API endpoint
- Add security headers
- Rate limit middleware for HTTP endpoints
- Logging for security events

### 6. Update CORS Configuration

**File**: `backend/server.js`

- Remove HTTP fallback in production
- Restrict to specific domains only
- Separate CORS for `/api/*` endpoints
- Validate Origin header

### 7. Add Environment Variables

**File**: `backend/.env.example`

- `WS_API_PORT` - API WebSocket port (default: 5000)
- `API_KEYS` - Comma-separated list of valid API keys
- `RATE_LIMIT_CONNECTIONS_PER_MIN` - Max connections per minute per key
- `RATE_LIMIT_MESSAGES_PER_SEC` - Max messages per second per connection
- `RATE_LIMIT_AUDIO_CHUNKS_PER_SEC` - Max audio chunks per second
- `MAX_AUDIO_CHUNK_SIZE` - Maximum audio chunk size in bytes
- `ALLOWED_ORIGINS` - Comma-separated allowed CORS origins

## Key Files to Modify/Create

1. **[backend/server.js](backend/server.js)**: Add secure `/api/translate` routing, update CORS
2. **[backend/apiWebSocketHandler.js](backend/apiWebSocketHandler.js)**: New - Secure API handler
3. **[backend/apiKeyManager.js](backend/apiKeyManager.js)**: New - API key management
4. **[backend/wsRateLimiter.js](backend/wsRateLimiter.js)**: New - WebSocket rate limiting
5. **[backend/inputValidator.js](backend/inputValidator.js)**: New - Input validation
6. **[backend/soloModeHandler.js](backend/soloModeHandler.js)**: Add `transcript`/`translation` keys

## Message Format

### Incoming (Client → Server)

```json
{
  "type": "init",
  "sourceLang": "en",
  "targetLang": "es"
}
```
```json
{
  "type": "audio",
  "data": <Buffer>  // Raw PCM bytes (validated size/format)
}
```



### Outgoing (Server → Client)

```json
{
  "type": "translation",
  "transcript": "Hello world",
  "translation": "Hola mundo",
  "originalText": "Hello world",
  "translatedText": "Hola mundo",
  "isPartial": true,
  "timestamp": 1234567890
}
```



### Error Messages

```json
{
  "type": "error",
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Rate limit exceeded. Retry after 5 seconds.",
  "retryAfter": 5
}
```



## Security Features

### Rate Limiting

- **Per Connection**: Max 10 messages/second, 50 audio chunks/second
- **Per API Key**: Max 100 connections/minute, 1000 messages/minute
- **Global**: Max 1000 total connections, 10000 messages/minute
- Configurable via environment variables

### Input Validation

- Language codes: Whitelist from `languageConfig.js`
- Audio chunks: Max 64KB, PCM format only, sample rate 16kHz
- Message size: Max 1MB per message
- Connection timeout: 5 minutes idle timeout

### Authentication

- API key required in query: `ws://host:port/api/translate?apiKey=xxx`
- Or send in initial message: `{ "type": "auth", "apiKey": "xxx" }`
- Invalid/missing key: Close connection with error

### CORS