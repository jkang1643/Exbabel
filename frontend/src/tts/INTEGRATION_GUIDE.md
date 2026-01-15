# TTS UI Integration Guide

## Quick Integration for ListenerPage

To add the TTS panel to `ListenerPage.jsx`, follow these steps:

### 1. Import the TTS Panel Component

Add to the imports section at the top of `ListenerPage.jsx`:

```javascript
import { TtsPanel } from './TtsPanel';
```

### 2. Check Feature Flag

Add feature flag check after other constants:

```javascript
const TTS_UI_ENABLED = import.meta.env.VITE_TTS_UI_ENABLED === 'true';
```

### 3. Create sendMessage Function

Add a helper function to send WebSocket messages (if not already present):

```javascript
const sendMessage = (message) => {
  if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
    wsRef.current.send(JSON.stringify(message));
  }
};
```

### 4. Handle TTS Messages in WebSocket Handler

Add TTS message handling in the `ws.onmessage` handler:

```javascript
ws.onmessage = (event) => {
  try {
    const message = JSON.parse(event.data);
    
    // ... existing message handling ...
    
    // Handle TTS messages
    if (message.type?.startsWith('tts/')) {
      // Forward to TTS controller (will be handled by TtsPanel component)
      console.log('[Listener] TTS message:', message.type);
    }
    
    // ... rest of message handling ...
  } catch (error) {
    console.error('[Listener] Error processing message:', error);
  }
};
```

### 5. Add TTS Panel to JSX

Add the TTS panel component in the JSX, typically after the language selector:

```jsx
{/* Existing language selector */}
<LanguageSelector
  selectedLanguage={targetLang}
  onLanguageChange={handleLanguageChange}
  languages={LANGUAGES}
  disabled={!isJoined}
/>

{/* TTS Panel - only visible when feature flag is enabled */}
{TTS_UI_ENABLED && isJoined && (
  <TtsPanel
    sendMessage={sendMessage}
    targetLang={targetLang}
    isConnected={connectionState === 'open'}
  />
)}
```

## Testing the Integration

### 1. Enable TTS UI

Create or update `frontend/.env.local`:

```bash
VITE_TTS_UI_ENABLED=true
```

### 2. Start Frontend

```bash
cd frontend
npm run dev
```

### 3. Join a Session

1. Create a host session
2. Join as a listener
3. You should see the TTS panel appear below the language selector

### 4. Test Controls

1. Toggle "Enable Speech" checkbox
2. Select a voice from the dropdown
3. Toggle between Unary and Streaming modes
4. Click "Play" to start (should send `tts/start` message)
5. Click "Stop" to stop (should send `tts/stop` message)
6. Check browser console for WebSocket messages

## Expected Console Output

When clicking "Play", you should see:

```
[Listener] TTS message: tts/ack
[TtsPlayerController] Starting playback { languageCode: 'es', voiceName: 'Kore', tier: 'gemini', mode: 'unary' }
[TtsPlayerController] Received ack: start
```

When clicking "Stop", you should see:

```
[Listener] TTS message: tts/ack
[TtsPlayerController] Stopping playback
[TtsPlayerController] Received ack: stop
```

## Troubleshooting

### TTS Panel Not Visible

- Check that `VITE_TTS_UI_ENABLED=true` in `.env.local`
- Restart the dev server after changing environment variables
- Verify you're joined to a session (panel only shows when `isJoined=true`)

### WebSocket Messages Not Sending

- Check browser console for WebSocket connection status
- Verify `sendMessage` function is correctly defined
- Check that `wsRef.current` is not null

### Backend Not Responding

- Ensure backend is running with `TTS_ENABLED_DEFAULT=true`
- Check backend console for TTS-related logs
- Verify WebSocket connection is established

## Next Steps (PR3)

In PR3, we'll add:
- Actual audio playback when receiving `tts/audio` messages
- Auto-synthesis on finalized segments
- Queue management for sequential playback
- Pause/resume functionality

For now, the UI is fully functional for testing the WebSocket command flow!
