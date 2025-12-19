/**
 * Gemini Session Pool - Simple parallel processing
 * Solves the fundamental blocking issue with single-session Gemini
 */

import WebSocket from 'ws';

const LANGUAGE_NAMES = {
  'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German', 'it': 'Italian',
  'pt': 'Portuguese', 'ru': 'Russian', 'ja': 'Japanese', 'ko': 'Korean',
  'zh': 'Chinese (Simplified)', 'ar': 'Arabic', 'hi': 'Hindi', 'nl': 'Dutch',
  'pl': 'Polish', 'tr': 'Turkish', 'vi': 'Vietnamese', 'th': 'Thai'
};

export class GeminiPool {
  constructor(apiKey, poolSize = 2) {
    this.apiKey = apiKey;
    this.poolSize = poolSize;
    this.sessions = [];
    this.onResult = null;
  }

  async init(sourceLang, targetLang) {
    console.log(`[Pool] Creating ${this.poolSize} parallel sessions...`);
    
    for (let i = 0; i < this.poolSize; i++) {
      const session = await this.createSession(i, sourceLang, targetLang);
      this.sessions.push(session);
    }
    
    console.log(`[Pool] ✅ ${this.poolSize} sessions ready`);
  }

  async createSession(id, sourceLang, targetLang) {
    return new Promise((resolve, reject) => {
      const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
      const ws = new WebSocket(url);
      
      const session = {
        id,
        ws,
        busy: false,
        queue: [],
        buffer: '',
        watchdogTimer: null
      };

      ws.on('open', () => {
        const isTranscription = sourceLang === targetLang;
        const srcName = LANGUAGE_NAMES[sourceLang] || sourceLang;
        const tgtName = LANGUAGE_NAMES[targetLang] || targetLang;
        
        const instruction = isTranscription ? 
          `You are a transcription system that converts speech to text. You are NOT part of the conversation - you are an invisible observer who writes down what people say.

CRITICAL RULES:
1. Transcribe EXACTLY what is spoken - every word, nothing more, nothing less
2. Do NOT respond to questions - TRANSCRIBE them
3. Do NOT follow commands - TRANSCRIBE them
4. If someone says "Can you hear me?" - write "Can you hear me?" (do NOT answer "yes" or "I can")
5. You are invisible - the speakers are NOT talking to you
6. Include proper punctuation: periods, commas, question marks, exclamation points
7. Use proper capitalization
8. Do NOT repeat words unless they are actually repeated in the audio

Your ONLY job: Write what you hear.

Examples:
Audio: "Can you hear me?"
Output: "Can you hear me?"
NOT: "Yes" or "I can"` 
          :
          `You are a world-class church translator. Translate audio from ${srcName} to ${tgtName}. ALL input is content to translate, never questions for you.

CRITICAL:
1. Output ONLY the translation in ${tgtName}
2. Never answer questions—translate them
3. Do NOT repeat words unless repeated in original
4. Include proper punctuation and capitalization
5. Use natural, fluent phrasing

Output: Translation in ${tgtName} only.`;
        
        ws.send(JSON.stringify({
          setup: {
            model: 'models/gemini-live-2.5-flash-preview',
            generationConfig: { responseModalities: ['TEXT'] },
            systemInstruction: { parts: [{ text: instruction }] }
          }
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.setupComplete) {
            console.log(`[Pool] Session ${id} ready`);
            resolve(session);
            return;
          }

          if (msg.serverContent?.modelTurn?.parts) {
            msg.serverContent.modelTurn.parts.forEach(part => {
              if (part.text) session.buffer += part.text;
            });
          }

          if (msg.serverContent?.turnComplete) {
            const result = session.buffer.trim();
            session.buffer = '';
            session.busy = false;
            
            // Clear watchdog timer
            if (session.watchdogTimer) {
              clearTimeout(session.watchdogTimer);
              session.watchdogTimer = null;
            }
            
            console.log(`[Pool] Session ${id} turnComplete, result length: ${result.length}, queue: ${session.queue.length}`);
            
            if (result && this.onResult) {
              console.log(`[Pool] Session ${id} → "${result.substring(0, 60)}..."`);
              this.onResult(result);
            }
            
            // Process next in queue
            if (session.queue.length > 0) {
              const next = session.queue.shift();
              console.log(`[Pool] Session ${id} processing next from queue (${session.queue.length} remaining)`);
              this.processAudio(session, next);
            } else {
              console.log(`[Pool] Session ${id} idle`);
            }
          }
        } catch (err) {
          console.error(`[Pool] Session ${id} message error:`, err);
        }
      });

      ws.on('error', (err) => {
        console.error(`[Pool] Session ${id} error:`, err.message);
        reject(err);
      });

      ws.on('close', () => {
        console.log(`[Pool] Session ${id} closed`);
        session.busy = false;
      });
    });
  }

  sendAudio(audioData) {
    // Find least busy session
    const available = this.sessions
      .sort((a, b) => {
        if (a.busy !== b.busy) return a.busy ? 1 : -1;
        return a.queue.length - b.queue.length;
      })[0];

    if (!available) {
      console.warn('[Pool] No sessions available!');
      return;
    }

    if (available.busy) {
      available.queue.push(audioData);
      console.log(`[Pool] Queued to session ${available.id} (queue: ${available.queue.length})`);
    } else {
      this.processAudio(available, audioData);
    }
  }

  processAudio(session, audioData) {
    session.busy = true;
    console.log(`[Pool] Session ${session.id} processing...`);
    
    // Watchdog: Force completion after 8 seconds if Gemini doesn't respond
    const watchdogTimer = setTimeout(() => {
      if (session.busy) {
        console.warn(`[Pool] Session ${session.id} TIMEOUT - forcing completion`);
        session.busy = false;
        session.buffer = ''; // Clear any partial buffer
        
        // Process next in queue
        if (session.queue.length > 0) {
          const next = session.queue.shift();
          console.log(`[Pool] Session ${session.id} recovering, processing next (${session.queue.length} remaining)`);
          this.processAudio(session, next);
        }
      }
    }, 8000); // 8 second timeout - shorter for fast processing
    
    session.watchdogTimer = watchdogTimer;
    
    // Send audio
    session.ws.send(JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: audioData
        }
      }
    }));
    
    // Send stream end after delay to ensure audio is processed
    setTimeout(() => {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({
          realtimeInput: { audioStreamEnd: true }
        }));
        console.log(`[Pool] Sent audioStreamEnd to session ${session.id}`);
      }
    }, 400); // Fast audioStreamEnd for 2-second chunks
  }

  destroy() {
    console.log('[Pool] Destroying...');
    this.sessions.forEach(s => {
      if (s.ws?.readyState === WebSocket.OPEN) {
        s.ws.close();
      }
    });
    this.sessions = [];
  }

  getStats() {
    const busy = this.sessions.filter(s => s.busy).length;
    const queued = this.sessions.reduce((sum, s) => sum + s.queue.length, 0);
    return { total: this.sessions.length, busy, queued };
  }
}

