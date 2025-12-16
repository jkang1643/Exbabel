# Exbabel WebSocket API Guide

## Overview

The Exbabel WebSocket API provides secure, real-time access to the transcription and translation engine for external clients. The API is designed for applications like Python overlays, mobile apps, or other services that need to integrate real-time translation capabilities.

**Endpoints:**
- **Local Development**: `ws://localhost:5000/api/translate`
- **Production**: `wss://api.exbabel.com/api/translate`

## Features

- **Real-time transcription** using Google Cloud Speech-to-Text
- **Real-time translation** using OpenAI GPT-4o-mini
- **Partial results** - receive updates as speech is processed
- **Secure authentication** via API keys
- **Attack-focused rate limiting** - permissive for legitimate use, blocks abuse
- **Input validation** - prevents malformed data and injection attacks

## Setup

### 1. Configure API Keys

Add your API keys to `backend/.env`:

```bash
# Required: Comma-separated list of API keys for client authentication
WS_API_KEYS=your-api-key-1,your-api-key-2,your-api-key-3

# Optional: Rate limiting configuration (defaults are permissive)
WS_API_RATE_LIMIT_CONNECTIONS=50      # Max connections per IP
WS_API_RATE_LIMIT_MESSAGES=1000      # Max messages/second per connection
WS_API_RATE_LIMIT_AUDIO=1048576       # Max audio bytes/second (1MB)
WS_API_RATE_LIMIT_ADAPTIVE_THRESHOLD=5  # Seconds before enforcing limits

# Optional: Separate port for API (defaults to same as PORT)
WS_API_PORT=5000
```

**Generate secure API keys:**
```bash
# Using OpenSSL
openssl rand -hex 32

# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Start the Server

```bash
cd backend
npm start
```

The API will be available at:
- **WebSocket**: `ws://localhost:5000/api/translate` (or `ws://localhost:${PORT}/api/translate`)

## Production Deployment

### Production Endpoint

When deployed, the API is available at:

```
wss://api.exbabel.com/api/translate?apiKey=your-api-key
```

**Important Notes:**
- Use `wss://` (secure WebSocket) instead of `ws://` in production
- No port number needed (uses standard 443 for WSS)
- Same path: `/api/translate`
- Requires valid SSL certificate for the domain

### Production Environment Configuration

Ensure your production server has these environment variables set:

```bash
# Production .env configuration
NODE_ENV=production
PORT=3001  # Or your production port

# API Configuration
WS_API_KEYS=production-key-1,production-key-2,production-key-3

# Rate limiting (same as development, or adjust for production load)
WS_API_RATE_LIMIT_CONNECTIONS=50
WS_API_RATE_LIMIT_MESSAGES=1000
WS_API_RATE_LIMIT_AUDIO=1048576
WS_API_RATE_LIMIT_ADAPTIVE_THRESHOLD=5

# Note: WS_API_PORT is ignored in production (uses same port as main server)
```

### SSL/TLS Requirements

Production deployments **must** use SSL/TLS:
- WebSocket connections use `wss://` protocol
- Requires valid SSL certificate for `api.exbabel.com`
- Certificate must be properly configured in your reverse proxy (nginx, etc.)

### Reverse Proxy Configuration

If using nginx as a reverse proxy, ensure WebSocket upgrade is configured:

```nginx
location /api/translate {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # WebSocket timeouts
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
}
```

### Deployment Checklist

- [ ] SSL certificate installed and valid for `api.exbabel.com`
- [ ] `WS_API_KEYS` environment variable set with production keys
- [ ] Reverse proxy configured for WebSocket upgrades
- [ ] Firewall allows WebSocket connections on port 443
- [ ] API keys are secure and not exposed in client code
- [ ] Rate limiting configured appropriately for production load
- [ ] Monitoring/logging set up for API connections
- [ ] Test connection: `wss://api.exbabel.com/api/translate?apiKey=test-key`

## Authentication

All API connections require a valid API key. Provide it in one of two ways:

### Option 1: Query Parameter (Recommended)
**Local Development:**
```
ws://localhost:5000/api/translate?apiKey=your-api-key-here
```

**Production:**
```
wss://api.exbabel.com/api/translate?apiKey=your-api-key-here
```

### Option 2: HTTP Header
```
X-API-Key: your-api-key-here
```

**Note**: WebSocket connections typically use query parameters since headers are set during the HTTP upgrade request.

## Usage

### Connection Flow

1. **Connect** to the WebSocket endpoint with API key
2. **Send `init` message** to configure source and target languages
3. **Send `audio` messages** with raw PCM audio chunks
4. **Receive `translation` messages** with transcript and translation
5. **Send `audio_end`** when done streaming

### Message Formats

#### Client → Server

##### Initialize Connection
```json
{
  "type": "init",
  "sourceLang": "en",
  "targetLang": "es"
}
```

**Parameters:**
- `sourceLang` (required): Source language code (e.g., "en", "es", "fr")
  - **71 languages supported** (Google Speech-to-Text transcription languages)
  - Must be a language that can be transcribed from audio
- `targetLang` (required): Target language code
  - **131+ languages supported** (OpenAI GPT-4o-mini translation languages)
  - Can be any language that GPT-4o-mini can translate to
- `tier` (optional): "basic" or "premium" (default: "basic")

**Supported Languages**: 
- **Source languages (transcription)**: 71 languages - See `TRANSCRIPTION_LANGUAGES` in `backend/languageConfig.js`
- **Target languages (translation)**: 131+ languages - See `TRANSLATION_LANGUAGES` in `backend/languageConfig.js`

##### Send Audio Chunk
```json
{
  "type": "audio",
  "data": <Buffer>  // Raw PCM bytes (max 64KB per chunk)
}
```

**Parameters:**
- `data` (required): Raw PCM audio bytes (16-bit, mono, 16kHz recommended)
- `chunkIndex` (optional): Sequential chunk number
- `clientTimestamp` (optional): Client timestamp for RTT measurement
- `startMs` / `endMs` (optional): Audio timing metadata

**Audio Format:**
- Format: Raw PCM (16-bit signed integers)
- Sample Rate: 16kHz recommended (Google Speech supports 8kHz-48kHz)
- Channels: Mono
- Endianness: Little-endian

##### End Audio Stream
```json
{
  "type": "audio_end"
}
```

#### Server → Client

##### Translation Result (Partial or Final)
```json
{
  "type": "translation",
  "transcript": "Hello world",
  "translation": "Hola mundo",
  "originalText": "Hello world",
  "translatedText": "Hola mundo",
  "isPartial": true,
  "timestamp": 1234567890,
  "seqId": 42
}
```

**Fields:**
- `transcript`: The transcribed text (preferred: corrected text if available)
- `translation`: The translated text (or transcript if transcription-only mode)
- `originalText`: Original transcription from speech-to-text
- `translatedText`: Translated text (may be empty for partials)
- `isPartial`: `true` for partial results, `false` for final results
- `timestamp`: Server timestamp in milliseconds
- `seqId`: Sequence ID for ordering messages
- `correctedText`: Grammar-corrected text (if available)
- `hasCorrection`: Whether grammar correction was applied
- `isTranscriptionOnly`: `true` if sourceLang === targetLang

##### Error Response
```json
{
  "type": "error",
  "code": "AUTH_FAILED",
  "message": "Invalid API key"
}
```

**Error Codes:**
- `AUTH_FAILED`: Invalid or missing API key
- `RATE_LIMIT_EXCEEDED`: Rate limit exceeded (with `retryAfter` seconds)
- `VALIDATION_ERROR`: Invalid message format or data
- `INTERNAL_ERROR`: Server error

##### Info Message
```json
{
  "type": "info",
  "message": "Connected to Exbabel API. Send init message to start.",
  "connectionId": "api_1234567890_abc123"
}
```

## Implementation Examples

### Python Client Example

```python
import asyncio
import websockets
import json
import pyaudio
import base64

# Configuration
API_KEY = "your-api-key-here"

# Environment-aware URL configuration
import os
ENVIRONMENT = os.getenv('ENVIRONMENT', 'development')  # 'development' or 'production'

if ENVIRONMENT == 'production':
    WS_URL = f"wss://api.exbabel.com/api/translate?apiKey={API_KEY}"
else:
    WS_URL = f"ws://localhost:5000/api/translate?apiKey={API_KEY}"

SOURCE_LANG = "en"
TARGET_LANG = "es"

# Audio configuration
CHUNK = 4096
FORMAT = pyaudio.paInt16
CHANNELS = 1
RATE = 16000

async def translate_audio():
    async with websockets.connect(WS_URL) as websocket:
        print("Connected to Exbabel API")
        
        # Initialize
        init_message = {
            "type": "init",
            "sourceLang": SOURCE_LANG,
            "targetLang": TARGET_LANG
        }
        await websocket.send(json.dumps(init_message))
        
        # Set up audio capture
        audio = pyaudio.PyAudio()
        stream = audio.open(
            format=FORMAT,
            channels=CHANNELS,
            rate=RATE,
            input=True,
            frames_per_buffer=CHUNK
        )
        
        # Start receiving messages
        async def receive_messages():
            async for message in websocket:
                data = json.loads(message)
                if data.get("type") == "translation":
                    print(f"Transcript: {data.get('transcript', '')}")
                    print(f"Translation: {data.get('translation', '')}")
                    print(f"Partial: {data.get('isPartial', False)}")
                    print("---")
                elif data.get("type") == "error":
                    print(f"Error: {data.get('message')}")
        
        # Start receiving task
        receive_task = asyncio.create_task(receive_messages())
        
        try:
            # Send audio chunks
            while True:
                audio_data = stream.read(CHUNK, exception_on_overflow=False)
                
                # Send as base64 (or send raw bytes if your WebSocket library supports binary)
                message = {
                    "type": "audio",
                    "data": base64.b64encode(audio_data).decode('utf-8')
                }
                await websocket.send(json.dumps(message))
                
                # Small delay to prevent overwhelming the server
                await asyncio.sleep(0.1)
                
        except KeyboardInterrupt:
            print("Stopping...")
        finally:
            # End audio stream
            await websocket.send(json.dumps({"type": "audio_end"}))
            stream.stop_stream()
            stream.close()
            audio.terminate()
            receive_task.cancel()

# Run
asyncio.run(translate_audio())
```

### JavaScript/Node.js Client Example

```javascript
const WebSocket = require('ws');
const fs = require('fs');

const API_KEY = 'your-api-key-here';

// Environment-aware URL configuration
const ENVIRONMENT = process.env.NODE_ENV || 'development';
const WS_URL = ENVIRONMENT === 'production'
  ? `wss://api.exbabel.com/api/translate?apiKey=${API_KEY}`
  : `ws://localhost:5000/api/translate?apiKey=${API_KEY}`;

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('Connected to Exbabel API');
  
  // Initialize
  ws.send(JSON.stringify({
    type: 'init',
    sourceLang: 'en',
    targetLang: 'es'
  }));
  
  // Send audio chunks (example: reading from file)
  const audioFile = fs.readFileSync('audio.pcm');
  const chunkSize = 4096;
  
  for (let i = 0; i < audioFile.length; i += chunkSize) {
    const chunk = audioFile.slice(i, i + chunkSize);
    
    ws.send(JSON.stringify({
      type: 'audio',
      data: chunk.toString('base64'),  // Base64 encode for JSON
      chunkIndex: Math.floor(i / chunkSize)
    }));
  }
  
  // End stream
  ws.send(JSON.stringify({ type: 'audio_end' }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  
  if (message.type === 'translation') {
    console.log(`Transcript: ${message.transcript}`);
    console.log(`Translation: ${message.translation}`);
    console.log(`Partial: ${message.isPartial}`);
    console.log('---');
  } else if (message.type === 'error') {
    console.error(`Error: ${message.message}`);
  }
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});
```

### Python Overlay Example (Simplified)

```python
import websockets
import json
import threading
import queue

class ExbabelOverlay:
    def __init__(self, api_key, source_lang="en", target_lang="es", environment="development"):
        self.api_key = api_key
        self.source_lang = source_lang
        self.target_lang = target_lang
        
        # Environment-aware URL
        if environment == "production":
            self.ws_url = f"wss://api.exbabel.com/api/translate?apiKey={api_key}"
        else:
            self.ws_url = f"ws://localhost:5000/api/translate?apiKey={api_key}"
        
        self.message_queue = queue.Queue()
        self.ws = None
        
    async def connect(self):
        self.ws = await websockets.connect(self.ws_url)
        
        # Initialize
        await self.ws.send(json.dumps({
            "type": "init",
            "sourceLang": self.source_lang,
            "targetLang": self.target_lang
        }))
        
        # Start receiving
        asyncio.create_task(self._receive_loop())
        
    async def _receive_loop(self):
        async for message in self.ws:
            data = json.loads(message)
            if data.get("type") == "translation":
                self.message_queue.put({
                    "transcript": data.get("transcript", ""),
                    "translation": data.get("translation", ""),
                    "isPartial": data.get("isPartial", False)
                })
    
    async def send_audio(self, audio_bytes):
        """Send raw PCM audio bytes"""
        message = {
            "type": "audio",
            "data": base64.b64encode(audio_bytes).decode('utf-8')
        }
        await self.ws.send(json.dumps(message))
    
    def get_latest_translation(self):
        """Get latest translation from queue (non-blocking)"""
        try:
            return self.message_queue.get_nowait()
        except queue.Empty:
            return None
```

## Rate Limiting

The API uses **attack-focused rate limiting** with permissive limits:

- **Connections**: 50 per IP address (allows multi-device usage)
- **Messages**: 1000 per second per connection (normal usage ~10-50/sec)
- **Audio**: 1MB per second per connection (allows high-quality streaming)
- **Adaptive**: Only enforces limits when sustained abuse detected (>5 seconds)

**Normal usage will never hit these limits.** They're designed to block DoS attacks while allowing legitimate high-load scenarios.

### Rate Limit Response

If rate limited, you'll receive:
```json
{
  "type": "error",
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Message rate limit exceeded. Please slow down.",
  "retryAfter": 5
}
```

Wait `retryAfter` seconds before retrying.

## Error Handling

### Authentication Errors

```json
{
  "type": "error",
  "code": "AUTH_FAILED",
  "message": "Invalid API key"
}
```

**Solution**: Check your API key is correct and included in `WS_API_KEYS` environment variable.

### Validation Errors

```json
{
  "type": "error",
  "code": "VALIDATION_ERROR",
  "message": "Invalid language code",
  "field": "sourceLang"
}
```

**Solution**: Use supported language codes from `backend/languageConfig.js`.

### Connection Errors

- **Connection refused**: Server not running or wrong port
- **Authentication failed**: Invalid API key
- **Rate limit exceeded**: Too many connections from your IP

## Best Practices

1. **Audio Format**: Use 16kHz, mono, 16-bit PCM for best compatibility
2. **Chunk Size**: Send 100-200ms chunks (1600-3200 bytes at 16kHz)
3. **Error Handling**: Always check for error messages and handle gracefully
4. **Reconnection**: Implement automatic reconnection with exponential backoff
5. **API Keys**: Rotate keys periodically, use different keys for different clients
6. **Rate Limiting**: Monitor your usage and stay well below limits

## Security Considerations

- **API Keys**: Never expose API keys in client-side code. Use server-side proxy if needed.
- **HTTPS/WSS**: Use `wss://` in production (requires SSL certificate)
- **Input Validation**: All inputs are validated server-side
- **Rate Limiting**: Protects against DoS attacks
- **CORS**: API endpoints have no CORS (WebSocket doesn't use CORS anyway)

## Troubleshooting

### Connection Fails

1. Check server is running: `curl http://localhost:5000/health`
2. Verify API key in `WS_API_KEYS` environment variable
3. Check firewall/network settings
4. Verify WebSocket URL format: `ws://host:port/api/translate?apiKey=xxx` (local) or `wss://api.exbabel.com/api/translate?apiKey=xxx` (production)

### Production Connection Issues

1. **SSL Certificate Errors**: Verify certificate is valid and properly configured
2. **Connection Refused**: Check reverse proxy configuration for WebSocket upgrades
3. **Timeout Issues**: Increase WebSocket timeout in reverse proxy (see nginx config above)
4. **CORS Errors**: WebSocket doesn't use CORS, but check if browser console shows SSL errors
5. **API Key Not Working**: Verify key is in production `WS_API_KEYS` environment variable

### No Translation Results

1. Check `init` message was sent and acknowledged
2. Verify audio format matches requirements (PCM, correct sample rate)
3. Check language codes are supported
4. Monitor server logs for errors

### Rate Limit Issues

1. Check if you're sending messages too frequently
2. Verify you're not creating too many connections
3. Review rate limit settings in environment variables
4. Check if you're sending oversized audio chunks

## API Reference Summary

### Endpoints

- **Local Development**: `ws://localhost:5000/api/translate?apiKey=xxx`
- **Production**: `wss://api.exbabel.com/api/translate?apiKey=xxx`

### Message Types

**Client → Server:**
- `init` - Initialize connection
- `audio` - Send audio chunk
- `audio_end` - End audio stream
- `ping` - Keep-alive (optional)

**Server → Client:**
- `translation` - Transcription/translation result
- `error` - Error response
- `info` - Informational message

### Environment Variables

```bash
WS_API_KEYS=key1,key2,key3                    # Required
WS_API_RATE_LIMIT_CONNECTIONS=50             # Optional
WS_API_RATE_LIMIT_MESSAGES=1000              # Optional
WS_API_RATE_LIMIT_AUDIO=1048576              # Optional
WS_API_RATE_LIMIT_ADAPTIVE_THRESHOLD=5       # Optional
WS_API_PORT=5000                             # Optional
```

## Support

For issues or questions:
1. Check server logs: `backend/server.js` console output
2. Review error messages in WebSocket responses
3. Verify configuration matches this guide
4. Check `backend/languageConfig.js` for supported languages

