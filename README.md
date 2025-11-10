# Exbabel

A production-quality web application that performs **real-time speech translation** using **Google Cloud Speech-to-Text** for transcription and **OpenAI GPT-4o-mini** for translation and grammar correction. The app captures live microphone input, streams it to Google Speech, and displays translated text with parallel grammar correction.

## 🚀 Features

- **🎙️ Live Streaming Translation** - Real-time translation as you speak (perfect for conferences!)
- **📡 Continuous Audio Streaming** - Audio sent in 300ms chunks with 500ms overlap for smooth updates
- **🌍 Multi-language support** - 71 transcription languages, 131+ translation languages
- **✏️ Parallel Grammar Correction** - Real-time grammar correction for English (non-blocking)
- **📝 Live captions** showing both original and translated text
- **💬 Text demo mode** for testing without microphone
- **⚡ Ultra-low latency** - Character-by-character updates (1-2 chars)
- **🔄 Parallel Processing** - Translation and grammar run in parallel for speed
- **🎨 Modern UI** with Tailwind CSS and smooth animations
- **📊 Connection status** and latency monitoring
- **💾 Transcript download** functionality
- **🔴 LIVE badge** indicator during active streaming
- **👥 Multi-user sessions** - Host/listener mode for conferences

## 🏗️ Architecture

```
Frontend (React) ←→ WebSocket ←→ Node.js Backend
                                      ├─→ Google Cloud Speech-to-Text (Transcription)
                                      └─→ OpenAI GPT-4o-mini (Translation + Grammar)
```

- **Frontend**: React + Vite + Tailwind CSS
- **Backend**: Node.js + Express + WebSocket
- **Transcription**: Google Cloud Speech-to-Text (71 languages)
- **Translation**: OpenAI GPT-4o-mini (131+ languages)
- **Grammar**: OpenAI GPT-4o-mini (English only, parallel processing)
- **Communication**: WebSocket for real-time data streaming
- **Processing**: Parallel transcription, translation, and grammar correction

## 📋 Prerequisites

- Node.js 18+ 
- npm or yarn
- Google Cloud Speech-to-Text API key or service account
- OpenAI API key
- Modern browser with microphone access

## 🛠️ Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd realtime-translation-app
   ```

2. **Install dependencies**
   ```bash
   npm run install:all
   ```

3. **Set up environment variables**
   
   **Backend environment:**
   ```bash
   cp env.example .env
   ```
   
   Edit `.env` and add your API keys:
   ```
   # Google Cloud Speech-to-Text (choose one):
   GOOGLE_SPEECH_API_KEY=your_google_api_key_here
   # OR
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
   
   # OpenAI API
   OPENAI_API_KEY=your_openai_api_key_here
   
   PORT=3001
   ```
   
   **Frontend environment:**
   Create a `.env.local` file in the `frontend/` folder:
   ```bash
   # frontend/.env.local
   VITE_WS_URL=ws://localhost:3001
   ```

4. **Get API keys**
   - **Google Cloud Speech-to-Text:**
     - Visit [Google Cloud Console](https://console.cloud.google.com/)
     - Enable Speech-to-Text API
     - Create API key or service account JSON
     - Add to `.env` file
   - **OpenAI:**
     - Visit [OpenAI Platform](https://platform.openai.com/)
     - Create API key
     - Add to `.env` file

## 🚀 Running the Application

### Development Mode
```bash
npm run dev
```

This starts both the backend (port 3001) and frontend (port 3000) concurrently.

### Production Mode
```bash
npm run build
npm start
```

## 🎯 Usage

### Live Streaming Voice Translation (Recommended for Conferences/Speeches)
1. Open the app in your browser
2. Select source and target languages
3. **Click the microphone button** to start live streaming
4. **Look for the "🔴 LIVE" badge** - this confirms streaming is active
5. **Start speaking** - translations appear every 2 seconds as you talk!
6. **Keep speaking** - no need to stop, translations update continuously
7. **Click the microphone again** to stop streaming
8. **Download transcript** using the download button

**Perfect for:**
- Conference presentations
- Live speeches
- Multi-lingual meetings
- Real-time interpretation

### Text Demo (Quick Translations)
1. Switch to the "Text Demo" tab
2. Enter text to translate
3. Click "Translate" to see results
4. Use audio playback for translated text

## 🔧 Configuration

### Language Support

**Transcription (71 languages):** Google Cloud Speech-to-Text maximum
- English, Spanish, French, German, Italian, Portuguese, Russian, Japanese, Korean, Chinese, Arabic, Hindi, and 60+ more

**Translation (131+ languages):** GPT-4o-mini comprehensive support
- All 71 transcription languages PLUS 60+ additional languages
- Includes Esperanto, Latin, Yiddish, and many more

See `LANGUAGE_EXPANSION_COMPLETE.md` for the complete language list.

### Audio Settings
- **Sample Rate**: 24kHz (optimized for speech)
- **Channels**: Mono
- **Format**: LINEAR16 PCM
- **Chunk Size**: 300ms chunks with 500ms overlap
- **Echo Cancellation**: Enabled
- **Noise Suppression**: Enabled
- **Auto Gain Control**: Enabled

### Streaming Configuration
- **Update Frequency**: Character-by-character (1-2 chars)
- **Mode**: Continuous streaming with parallel processing
- **Latency**: 600-2000ms end-to-end for partial results
- **Translation Throttle**: 0ms (instant)
- **Grammar Throttle**: 2000ms (non-blocking)
- See `STREAMING_LATENCY_PARAMETERS.md` for detailed configuration

## 📁 Project Structure

```
exbabel/
├── backend/
│   ├── server.js                    # Express + WebSocket server with streaming
│   └── package.json                 # Backend dependencies
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── TranslationInterface.jsx  # Main streaming interface
│   │   │   ├── TranslationDisplay.jsx    # Live translation display
│   │   │   └── ...                       # Other components
│   │   ├── hooks/
│   │   │   ├── useAudioCapture.js        # Streaming audio capture
│   │   │   └── useWebSocket.js           # WebSocket connection
│   │   └── App.jsx                       # Main app component
│   └── package.json                      # Frontend dependencies
├── package.json                          # Root package.json
├── env.example                           # Environment variables template
├── README.md                             # This file
├── STREAMING_TRANSLATION.md              # Detailed streaming docs
└── LANGUAGE_TESTING.md                   # Language testing guide
```

## 🔌 API Endpoints

### WebSocket Endpoints
- `ws://localhost:3001` - Main WebSocket connection

### HTTP Endpoints
- `GET /health` - Health check
- `GET /` - Serve frontend (production)

### WebSocket Message Types

#### Client → Server
```javascript
// Initialize session
{
  type: 'init',
  sourceLang: 'en',
  targetLang: 'es'
}

// Send audio data (streaming mode)
{
  type: 'audio',
  audioData: 'base64_encoded_audio',
  sourceLang: 'en',
  targetLang: 'es',
  streaming: true  // Indicates continuous streaming
}

// Send text for translation
{
  type: 'text',
  text: 'Hello world'
}
```

#### Server → Client
```javascript
// Session ready
{
  type: 'session_ready',
  sessionId: 'uuid',
  message: 'Translation session ready'
}

// Translation result
{
  type: 'translation',
  originalText: 'Hello',
  translatedText: 'Hola',
  timestamp: 1234567890
}

// Error
{
  type: 'error',
  message: 'Error description'
}
```

## 🧪 Testing

### Manual Testing
1. **Voice Translation**: Test with different languages
2. **Text Demo**: Verify text translation works
3. **Audio Playback**: Check if translated audio plays
4. **Connection**: Test WebSocket connection stability

### Browser Compatibility
- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

## 🚨 Troubleshooting

### Common Issues

1. **Microphone not working**
   - Check browser permissions
   - Ensure HTTPS in production
   - Try different browsers

2. **WebSocket connection failed**
   - Check if backend is running on port 3001
   - Verify firewall settings
   - Check browser console for errors

3. **Translation not working**
   - Verify OpenAI API key is correct
   - Check OpenAI API quota limits (4,500 RPM / 1.8M TPM)
   - Ensure internet connection
   - Check rate limiter logs for throttling

4. **Audio playback issues**
   - Check browser audio permissions
   - Try different audio formats
   - Verify Web Audio API support

### Debug Mode
Enable debug logging by setting:
```javascript
localStorage.setItem('debug', 'true')
```

## 🔒 Security

- API keys are never exposed to the frontend
- All Google Speech and OpenAI communication goes through the backend
- WebSocket connections are validated
- Audio data is processed securely
- Rate limiting prevents API abuse

## 📈 Performance

- **Streaming Latency**: 600-2000ms end-to-end for partial results
- **Update Frequency**: Character-by-character (1-2 chars)
- **Translation Latency**: 200-800ms (decoupled from grammar)
- **Grammar Latency**: 100-500ms (non-blocking, sent separately)
- **Audio Chunks**: 300ms segments with 500ms overlap
- **Bandwidth**: ~8-12 KB per 300ms audio chunk
- **Memory**: Optimized for long-running sessions (~50-100MB per session)
- **CPU**: Low impact (browser handles audio encoding)
- **Concurrent Sessions**: Supports multiple simultaneous users
- **Parallel Processing**: Translation and grammar run in parallel
- **Rate Limits**: 4,500 RPM / 1.8M TPM with automatic retry

## 🚀 Deployment

### Environment Variables
```bash
# Google Cloud Speech-to-Text (choose one):
GOOGLE_SPEECH_API_KEY=your_api_key
# OR
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

# OpenAI API
OPENAI_API_KEY=your_openai_api_key

PORT=3001
NODE_ENV=production
```

### Production Build
```bash
npm run build
npm start
```

### Docker (Optional)
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3001
CMD ["npm", "start"]
```

## 📄 License

**PROPRIETARY - All Rights Reserved**

This software is proprietary and confidential. Unauthorized copying, modification, distribution, or use of this software, via any medium, is strictly prohibited without explicit written permission from the copyright holder.

See the LICENSE file for complete terms and conditions.

## 🆘 Support

For authorized users:
1. Check the troubleshooting section
2. Review browser console for errors
3. Verify API key and permissions
4. Contact support through official channels

## ⚖️ Legal Notice

This software and all associated intellectual property, including but not limited to the real-time translation system, streaming architecture, and AI integration methods, are protected by copyright law and trade secret law. Any unauthorized use, disclosure, or distribution may result in legal action.

## 🔮 Future Enhancements

- [x] **Live streaming translation** (✅ Completed!)
- [x] **Continuous audio chunking** (✅ Completed!)
- [x] **Parallel grammar correction** (✅ Completed!)
- [x] **Multi-user sessions** (✅ Completed!)
- [x] **Language expansion** (✅ 71 transcription, 131+ translation!)
- [x] **Ultra-low latency** (✅ Character-by-character updates!)
- [ ] Voice Activity Detection (VAD) for smart chunking
- [ ] Language auto-detection
- [ ] Custom voice models
- [ ] Offline mode
- [ ] Mobile app
- [ ] Translation history and search
- [ ] Custom language models

---

## 📚 Documentation

- **API_REFERENCE.md** - Complete API documentation
- **ARCHITECTURE.md** - System architecture and processing flow
- **STREAMING_LATENCY_PARAMETERS.md** - All latency-related parameters
- **OPTIMIZATIONS_STATUS.md** - Optimization implementation status
- **LANGUAGE_EXPANSION_COMPLETE.md** - Language support details

---

**Built with ❤️ using React, Node.js, Google Cloud Speech-to-Text, and OpenAI GPT-4o-mini**
