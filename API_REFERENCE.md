# Multi-User Translation API Reference

Complete API documentation for the Live Translation Session feature.

---

## 📡 REST API Endpoints

### Base URL
```
http://localhost:3001
```

---

### 1. Create Session

Creates a new live translation session.

**Endpoint:**
```
POST /session/start
```

**Request:**
```http
POST /session/start HTTP/1.1
Content-Type: application/json
```

**Response:**
```json
{
  "success": true,
  "sessionId": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
  "sessionCode": "ABC123",
  "wsUrl": "/translate?role=host&sessionId=xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Error message"
}
```

**Status Codes:**
- `200` - Success
- `500` - Server error

---

### 2. Join Session

Allows a listener to join an existing session.

**Endpoint:**
```
POST /session/join
```

**Request:**
```http
POST /session/join HTTP/1.1
Content-Type: application/json

{
  "sessionCode": "ABC123",
  "targetLang": "es",
  "userName": "John Doe"
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
  "sessionCode": "ABC123",
  "sourceLang": "en",
  "targetLang": "es",
  "wsUrl": "/translate?role=listener&sessionId=xxx&targetLang=es&userName=John%20Doe"
}
```

**Error Responses:**
```json
{
  "success": false,
  "error": "Session code is required"
}
```
```json
{
  "success": false,
  "error": "Session not found. Please check the code and try again."
}
```
```json
{
  "success": false,
  "error": "Session is not active yet. The host needs to start broadcasting."
}
```

**Status Codes:**
- `200` - Success
- `400` - Bad request (missing code or session not active)
- `404` - Session not found
- `500` - Server error

---

### 3. Get Session Info

Retrieves information about a specific session.

**Endpoint:**
```
GET /session/:sessionCode/info
```

**Request:**
```http
GET /session/ABC123/info HTTP/1.1
```

**Response:**
```json
{
  "success": true,
  "session": {
    "sessionId": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
    "sessionCode": "ABC123",
    "isActive": true,
    "listenerCount": 25,
    "languages": ["es", "fr", "de", "pt"],
    "languageCounts": {
      "es": 10,
      "fr": 8,
      "de": 5,
      "pt": 2
    },
    "createdAt": 1234567890000,
    "lastActivity": 1234567895000,
    "duration": 5000
  }
}
```

**Status Codes:**
- `200` - Success
- `404` - Session not found
- `500` - Server error

---

### 4. List All Sessions

Lists all active sessions (for admin/debugging).

**Endpoint:**
```
GET /sessions
```

**Request:**
```http
GET /sessions HTTP/1.1
```

**Response:**
```json
{
  "success": true,
  "sessions": [
    {
      "sessionId": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
      "sessionCode": "ABC123",
      "isActive": true,
      "listenerCount": 25,
      "languages": ["es", "fr", "de"],
      "createdAt": 1234567890000
    },
    {
      "sessionId": "yyyyyyyy-yyyy-4yyy-yyyy-yyyyyyyyyyyy",
      "sessionCode": "XYZ789",
      "isActive": true,
      "listenerCount": 10,
      "languages": ["ja", "ko"],
      "createdAt": 1234567880000
    }
  ]
}
```

**Status Codes:**
- `200` - Success
- `500` - Server error

---

### 5. Health Check

Checks server health and status.

**Endpoint:**
```
GET /health
```

**Request:**
```http
GET /health HTTP/1.1
```

**Response:**
```json
{
  "status": "ok",
  "activeSessions": 5,
  "liveTranslationSessions": 3,
  "transcriptionProvider": "Google Cloud Speech-to-Text",
  "translationProvider": "OpenAI GPT-4o-mini",
  "endpoint": "/translate"
}
```

**Status Codes:**
- `200` - Success

---

## 🔌 WebSocket API

### Connection URLs

#### Host Connection
```
ws://localhost:3001/translate?role=host&sessionId={sessionId}
```

**Query Parameters:**
- `role` (required): Must be "host"
- `sessionId` (required): Session ID from POST /session/start

#### Listener Connection
```
ws://localhost:3001/translate?role=listener&sessionId={sessionId}&targetLang={lang}&userName={name}
```

**Query Parameters:**
- `role` (required): Must be "listener"
- `sessionId` (required): Session ID from POST /session/join
- `targetLang` (required): Target language code (e.g., "es", "fr")
- `userName` (optional): User's name (default: "Anonymous")

#### Legacy Solo Mode
```
ws://localhost:3001/translate
```

---

## 📨 WebSocket Message Types

### Host Messages

#### Client → Server

**Initialize Session**
```json
{
  "type": "init",
  "sourceLang": "en"
}
```

**Send Audio Chunk**
```json
{
  "type": "audio",
  "audioData": "base64_encoded_pcm_audio",
  "chunkIndex": 123,
  "startMs": 1000,
  "endMs": 1300,
  "clientTimestamp": 1234567890000,
  "streaming": true
}
```

**Ping (Keep-Alive)**
```json
{
  "type": "ping",
  "timestamp": 1234567890000
}
```

**End Audio Stream**
```json
{
  "type": "audio_end"
}
```

#### Server → Client

**Session Ready**
```json
{
  "type": "session_ready",
  "sessionId": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
  "sessionCode": "ABC123",
  "role": "host"
}
```

**Translation Result (Partial)**
```json
{
  "type": "translation",
  "seqId": 123,
  "serverTimestamp": 1234567890000,
  "isPartial": true,
  "originalText": "Hello everyone, welcome",
  "translatedText": "Hola a todos, bienvenidos",
  "correctedText": "Hello everyone, welcome.",
  "hasTranslation": true,
  "hasCorrection": true,
  "updateType": "grammar",
  "timestamp": 1234567890000
}
```

**Translation Result (Final)**
```json
{
  "type": "translation",
  "seqId": 124,
  "serverTimestamp": 1234567890000,
  "isPartial": false,
  "originalText": "Hello everyone, welcome to today's sermon",
  "translatedText": "Hola a todos, bienvenidos al sermón de hoy",
  "correctedText": "Hello everyone, welcome to today's sermon.",
  "hasTranslation": true,
  "hasCorrection": true,
  "timestamp": 1234567890000
}
```

**Error**
```json
{
  "type": "error",
  "message": "Error description",
  "code": 1011,
  "persistent": false
}
```

---

### Listener Messages

#### Client → Server

**Change Language**
```json
{
  "type": "change_language",
  "targetLang": "fr"
}
```

#### Server → Client

**Session Joined**
```json
{
  "type": "session_joined",
  "sessionId": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
  "sessionCode": "ABC123",
  "role": "listener",
  "targetLang": "es",
  "sourceLang": "en",
  "message": "Connected to session ABC123"
}
```

**Translation Received (Partial)**
```json
{
  "type": "translation",
  "seqId": 123,
  "serverTimestamp": 1234567890000,
  "isPartial": true,
  "originalText": "Hello everyone, welcome",
  "translatedText": "Hola a todos, bienvenidos",
  "correctedText": "Hello everyone, welcome.",
  "sourceLang": "en",
  "targetLang": "es",
  "hasTranslation": true,
  "hasCorrection": true,
  "updateType": "grammar",
  "timestamp": 1234567890000
}
```

**Translation Received (Final)**
```json
{
  "type": "translation",
  "seqId": 124,
  "serverTimestamp": 1234567890000,
  "isPartial": false,
  "originalText": "Hello everyone, welcome to today's sermon",
  "translatedText": "Hola a todos, bienvenidos al sermón de hoy",
  "correctedText": "Hello everyone, welcome to today's sermon.",
  "sourceLang": "en",
  "targetLang": "es",
  "hasTranslation": true,
  "hasCorrection": true,
  "timestamp": 1234567890000
}
```

**Pong (Keep-Alive Response)**
```json
{
  "type": "pong",
  "timestamp": 1234567890000
}
```

**Session Statistics**
```json
{
  "type": "session_stats",
  "stats": {
    "sessionId": "xxx",
    "sessionCode": "ABC123",
    "isActive": true,
    "listenerCount": 25,
    "languages": ["es", "fr", "de"],
    "languageCounts": {
      "es": 10,
      "fr": 8,
      "de": 7
    },
    "createdAt": 1234567890000,
    "lastActivity": 1234567895000,
    "duration": 5000
  }
}
```

**Language Changed**
```json
{
  "type": "language_changed",
  "targetLang": "fr"
}
```

**Session Ended**
```json
{
  "type": "session_ended",
  "message": "The host has ended the session"
}
```

**Error**
```json
{
  "type": "error",
  "message": "Error description"
}
```

---

## 🗣️ Supported Languages

The following language codes are supported:

| Code | Language | Code | Language |
|------|----------|------|----------|
| en | English | ja | Japanese |
| es | Spanish | ko | Korean |
| fr | French | zh | Chinese (Simplified) |
| de | German | zh-TW | Chinese (Traditional) |
| it | Italian | ar | Arabic |
| pt | Portuguese | hi | Hindi |
| pt-BR | Portuguese (Brazil) | nl | Dutch |
| ru | Russian | pl | Polish |
| tr | Turkish | uk | Ukrainian |
| bn | Bengali | fa | Persian |
| vi | Vietnamese | ur | Urdu |
| th | Thai | ta | Tamil |
| id | Indonesian | te | Telugu |
| sv | Swedish | mr | Marathi |
| no | Norwegian | gu | Gujarati |
| da | Danish | kn | Kannada |
| fi | Finnish | ml | Malayalam |
| el | Greek | sw | Swahili |
| cs | Czech | fil | Filipino |
| ro | Romanian | ms | Malay |
| hu | Hungarian | ca | Catalan |
| he | Hebrew | sk | Slovak |
| bg | Bulgarian | sl | Slovenian |
| hr | Croatian | et | Estonian |
| sr | Serbian | lv | Latvian |
| lt | Lithuanian | af | Afrikaans |

---

## 🔐 Error Codes

### HTTP Status Codes
- `200` - Success
- `400` - Bad Request
- `404` - Not Found
- `500` - Internal Server Error

### WebSocket Close Codes
- `1000` - Normal closure
- `1007` - Precondition failed (protocol issue)
- `1011` - Server error (typically API quota exceeded)

---

## 📊 Rate Limits

### OpenAI API Rate Limits
- **Requests Per Minute (RPM):** 4,500 requests/minute (with 10% safety margin)
- **Tokens Per Minute (TPM):** 1,800,000 tokens/minute (with 10% safety margin)
- **Retry Strategy:** Exponential backoff with up to 5 retries
- **Request Skipping:** Requests skipped if wait time exceeds 2 seconds

### Google Speech-to-Text Limits
- **Streaming Duration:** 5 minutes maximum (auto-restarts at 4 minutes)
- **VAD Cutoff:** Auto-restarts at 25 seconds to prevent aggressive VAD
- **Concurrent Streams:** Limited by Google Cloud quota

### WebSocket Connections
- **Concurrent Sessions:** Limited by server resources
- **Session Cleanup:** Inactive sessions cleaned up after 1 hour

---

## 🔄 Connection Flow

### Host Flow
```
1. POST /session/start → Get sessionId & sessionCode
2. Connect WebSocket with role=host
3. Send init message with sourceLang
4. Wait for session_ready
5. Google Speech stream initializes automatically
6. Send audio chunks continuously (with chunkIndex, timestamps)
7. Receive translation results (partial and final)
8. Send ping messages periodically for keep-alive
9. Disconnect to end session
```

### Listener Flow
```
1. POST /session/join with sessionCode → Get sessionId
2. Connect WebSocket with role=listener
3. Wait for session_joined
4. Receive translations in real-time
5. Optionally send change_language to switch
6. Disconnect when done
```

---

## 🧪 Testing with cURL

### Create Session
```bash
curl -X POST http://localhost:3001/session/start \
  -H "Content-Type: application/json"
```

### Join Session
```bash
curl -X POST http://localhost:3001/session/join \
  -H "Content-Type: application/json" \
  -d '{
    "sessionCode": "ABC123",
    "targetLang": "es",
    "userName": "Test User"
  }'
```

### Get Session Info
```bash
curl http://localhost:3001/session/ABC123/info
```

### List All Sessions
```bash
curl http://localhost:3001/sessions
```

### Health Check
```bash
curl http://localhost:3001/health
```

---

## 📝 Notes

### Architecture
- **Transcription:** Google Cloud Speech-to-Text (71 languages supported)
- **Translation:** OpenAI GPT-4o-mini (131+ languages supported)
- **Grammar Correction:** OpenAI GPT-4o-mini (English only)
- **Processing:** Parallel transcription, translation, and grammar correction

### Message Format
- All timestamps are Unix timestamps in milliseconds
- Session codes are 6 characters, case-insensitive
- WebSocket messages must be valid JSON
- Sequence IDs (`seqId`) ensure message ordering
- Partial results (`isPartial: true`) are live updates
- Final results (`isPartial: false`) are complete sentences

### Audio Format
- **Encoding:** LINEAR16 PCM
- **Sample Rate:** 24kHz (24,000 Hz)
- **Channels:** Mono (1 channel)
- **Chunk Size:** 300ms chunks with 500ms overlap
- **Format:** Base64-encoded Int16 PCM data

### Processing Flow
1. **Partial Results (DECOUPLED):**
   - Translation sent immediately when ready
   - Grammar correction sent separately when ready
   - Frontend merges updates incrementally

2. **Final Results (COUPLED):**
   - Translation and grammar run in parallel
   - Wait for both to complete
   - Single message with complete data

### Language Support
- **Transcription:** 71 languages (Google Speech-to-Text maximum)
- **Translation:** 131+ languages (GPT-4o-mini comprehensive support)
- See `LANGUAGE_EXPANSION_COMPLETE.md` for full language list

### Performance
- **Latency:** 600-2000ms end-to-end for partial results
- **Update Frequency:** Character-by-character updates (1-2 chars)
- **Concurrency:** Up to 5 parallel translation requests
- **Rate Limits:** 4,500 RPM / 1.8M TPM (with automatic retry)

---

**End of API Reference**

