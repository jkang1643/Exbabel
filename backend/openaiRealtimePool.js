/**
 * OpenAI Realtime API Session Pool
 * Replaces Gemini Live API with OpenAI Realtime for continuous speech processing
 * 
 * MIGRATION NOTES:
 * - Replaced Gemini Live WebSocket with OpenAI Realtime API
 * - Uses event-based architecture instead of Gemini's message format
 * - Supports continuous audio streaming without forced pauses
 * - Provides interim transcripts for real-time display
 * - Handles session management and parallel processing
 */

import WebSocket from 'ws';

const LANGUAGE_NAMES = {
  'en': 'English',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'it': 'Italian',
  'pt': 'Portuguese',
  'pt-BR': 'Portuguese (Brazil)',
  'ru': 'Russian',
  'ja': 'Japanese',
  'ko': 'Korean',
  'zh': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  'ar': 'Arabic',
  'hi': 'Hindi',
  'nl': 'Dutch',
  'pl': 'Polish',
  'tr': 'Turkish',
  'bn': 'Bengali',
  'vi': 'Vietnamese',
  'th': 'Thai',
  'id': 'Indonesian',
  'sv': 'Swedish',
  'no': 'Norwegian',
  'da': 'Danish',
  'fi': 'Finnish',
  'el': 'Greek',
  'cs': 'Czech',
  'ro': 'Romanian',
  'hu': 'Hungarian',
  'he': 'Hebrew',
  'uk': 'Ukrainian',
  'fa': 'Persian',
  'ur': 'Urdu',
  'ta': 'Tamil',
  'te': 'Telugu',
  'mr': 'Marathi',
  'gu': 'Gujarati',
  'kn': 'Kannada',
  'ml': 'Malayalam',
  'sw': 'Swahili',
  'fil': 'Filipino',
  'ms': 'Malay',
  'ca': 'Catalan',
  'sk': 'Slovak',
  'bg': 'Bulgarian',
  'hr': 'Croatian',
  'sr': 'Serbian',
  'lt': 'Lithuanian',
  'lv': 'Latvian',
  'et': 'Estonian',
  'sl': 'Slovenian',
  'af': 'Afrikaans'
};

export class OpenAIRealtimePool {
  constructor(apiKey, poolSize = 2) {
    this.apiKey = apiKey;
    this.poolSize = poolSize;
    this.sessions = [];
    this.sequenceCounter = 0;
    this.resultCallback = null;
    this.nextExpectedSequence = 0;
    
    // Track audio buffer for continuous streaming
    this.audioBuffer = [];
    this.isProcessing = false;
  }

  /**
   * Get ISO-639-1 language code for OpenAI transcription
   */
  getLanguageCode(lang) {
    // Extract base language code (e.g., 'en' from 'en-US')
    return lang.split('-')[0].toLowerCase();
  }

  /**
   * Initialize the session pool with OpenAI Realtime connections
   */
  async initialize(sourceLang, targetLang) {
    console.log(`[OpenAIPool] Initializing ${this.poolSize} parallel OpenAI Realtime sessions...`);
    console.log(`[OpenAIPool] Language: ${sourceLang} (target: ${targetLang})`);
    
    for (let i = 0; i < this.poolSize; i++) {
      const session = await this.createSession(i, sourceLang, targetLang);
      this.sessions.push(session);
    }
    
    console.log(`[OpenAIPool] ✅ All ${this.poolSize} OpenAI Realtime sessions ready`);
  }

  /**
   * Create a single OpenAI Realtime WebSocket session
   * REPLACES: Gemini Live WebSocket connection
   */
  async createSession(sessionId, sourceLang, targetLang) {
    return new Promise((resolve, reject) => {
      // UPDATED: Use latest gpt-realtime model (replaces gpt-4o-realtime-preview)
      // Documentation: https://platform.openai.com/docs/guides/realtime-models
      const realtimeUrl = 'wss://api.openai.com/v1/realtime?model=gpt-realtime';
      
      const ws = new WebSocket(realtimeUrl, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });
      
      const session = {
        id: sessionId,
        ws: ws,
        isBusy: false,
        queue: [],
        setupComplete: false,
        currentSequence: null,
        transcriptBuffer: '',
        currentItemId: null,
        responseId: null,
        sourceLang: sourceLang,
        targetLang: targetLang,
        requestCount: 0  // Track requests to re-send instructions periodically
      };

      ws.on('open', () => {
        console.log(`[OpenAIPool] Session ${sessionId} connected to OpenAI Realtime`);
        
        const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
        const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;
        const isTranscription = sourceLang === targetLang;
        
        console.log(`[OpenAIPool] Session ${sessionId} configuring:`);
        console.log(`  - Source: ${sourceLang} (${sourceLangName})`);
        console.log(`  - Target: ${targetLang} (${targetLangName})`);
        console.log(`  - Mode: ${isTranscription ? 'TRANSCRIPTION' : 'TRANSLATION'}`);
        
        // UPDATED: Use latest gpt-realtime configuration with best practices
        // Documentation: https://platform.openai.com/docs/guides/realtime-models
        let sessionConfig;
        
        if (isTranscription) {
          // Transcription-only mode - optimized prompt structure
          // Using bullet points for better following (per best practices)
          const transcriptionInstructions = `You are a real-time transcription engine. Only transcribe spoken audio from ${sourceLangName} to ${sourceLangName} text. Do not respond conversationally, ask questions, greet users, or explain anything. Output only the transcribed text exactly as spoken.

If user input is not clear speech, output "[unclear audio]". Never ask questions. Never greet. Never respond. Only transcribe.

Examples:
Input: "Can you hear me?"
Output: "Can you hear me?"
NOT: "Yes, I can hear you."

Input: "Hey"  
Output: "Hey"
NOT: "Hey there! How's it going?"`;

          // TRANSCRIPTION MODE: Use gpt-4o-transcribe for incremental word-by-word deltas
          sessionConfig = {
            type: 'session.update',
            session: {
              modalities: ['text'],  // Text-only, no audio output
              instructions: transcriptionInstructions,
              input_audio_transcription: {
                model: 'gpt-4o-transcribe'  // Use gpt-4o-transcribe for incremental deltas!
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500
              },
              temperature: 0.6
            }
          };
        } else {
          // Translation mode - optimized prompt structure with best practices
          const translationInstructions = `You are a translation machine. Translate from ${sourceLangName} to ${targetLangName}. DO NOT interpret, explain, paraphrase, or respond to content. DO NOT answer questions - translate them exactly as spoken. DO NOT add context or commentary. Output ONLY the direct translation in ${targetLangName}.`;

          // TRANSCRIPTION MODE: Use gpt-4o-transcribe for incremental word-by-word deltas
          sessionConfig = {
            type: 'session.update',
            session: {
              modalities: ['text'],  // Text-only, no audio output
              instructions: translationInstructions,
              input_audio_transcription: {
                model: 'gpt-4o-transcribe'  // Use gpt-4o-transcribe for incremental deltas!
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 1000  // 1 second of silence before finalizing
              },
              temperature: 0.6,
              max_response_output_tokens: 4096
            }
          };
        }
        
        ws.send(JSON.stringify(sessionConfig));
        console.log(`[OpenAIPool] Session ${sessionId} configured:`);
        console.log(`  - Mode: ${isTranscription ? 'TRANSCRIPTION' : 'TRANSLATION'}`);
        console.log(`  - Model: gpt-4o-transcribe (incremental word-by-word deltas)`);
        console.log(`  - Language: ${sourceLang}`);
      });

      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          
          // MIGRATION NOTE: OpenAI uses event.type instead of response types
          switch (event.type) {
            case 'session.created':
            case 'session.updated':
              console.log(`[OpenAIPool] Session ${sessionId} ready (${event.type})`);
              session.setupComplete = true;
              if (event.type === 'session.created') {
                resolve(session);
              }
              break;

            case 'error':
              console.error(`[OpenAIPool] Session ${sessionId} error:`, event.error);
              if (!session.setupComplete) {
                reject(new Error(event.error.message || 'Unknown error'));
              }
              break;

            case 'input_audio_buffer.speech_started':
              console.log(`[OpenAIPool] Session ${sessionId} speech detected`);
              break;

            case 'input_audio_buffer.speech_stopped':
              console.log(`[OpenAIPool] Session ${sessionId} speech stopped - auto-transcription will trigger`);
              // DON'T create a response - that triggers conversational GPT!
              // input_audio_transcription events will automatically fire when input_audio_transcription is enabled
              break;

            case 'input_audio_buffer.committed':
              console.log(`[OpenAIPool] Session ${sessionId} audio buffer committed`);
              break;

            case 'conversation.item.created':
              // Track the item ID for this audio segment
              if (event.item && event.item.type === 'message') {
                session.currentItemId = event.item.id;
                console.log(`[OpenAIPool] Session ${sessionId} item created: ${event.item.id}`);
              }
              break;

            case 'response.created':
              session.responseId = event.response.id;
              console.log(`[OpenAIPool] Session ${sessionId} response started: ${event.response.id}`);
              break;

            case 'response.output_item.added':
              console.log(`[OpenAIPool] Session ${sessionId} output item added`);
              break;

            case 'response.content_part.added':
              console.log(`[OpenAIPool] Session ${sessionId} content part added`);
              break;

            case 'conversation.item.input_audio_transcription.delta':
              // PURE TRANSCRIPTION - This is Whisper transcribing, NOT GPT responding!
              // Send EVERY delta IMMEDIATELY for word-by-word live display
              if (event.delta) {
                session.transcriptBuffer += event.delta;
                // console.log for debugging - comment out in production to reduce noise
                // console.log(`[OpenAIPool] 🔵 DELTA: "${event.delta}" → Buffer: "${session.transcriptBuffer}"`);
                
                // Deliver IMMEDIATELY through handleResult for consistent word-by-word delivery
                // No buffering, no throttling - instant relay to frontend
                this.handleResult(-1, session.transcriptBuffer, true);
              }
              break;

            case 'conversation.item.input_audio_transcription.completed':
              // PURE TRANSCRIPTION COMPLETE - Whisper finished transcribing
              const transcript = event.transcript || session.transcriptBuffer.trim();
              session.transcriptBuffer = '';
              
              if (transcript) {
                const sequenceId = this.sequenceCounter++;
                console.log(`[OpenAIPool] Session ${sessionId} ✅ WHISPER FINAL #${sequenceId}: "${transcript.substring(0, 50)}..."`);
                this.handleResult(sequenceId, transcript, false);
              }
              break;

            case 'input_audio_buffer.committed':
              // Audio buffer has been committed for processing
              console.log(`[OpenAIPool] Session ${sessionId} audio buffer committed`);
              break;

            case 'response.audio_transcript.delta':
            case 'response.text.delta':
              // These are GPT responses, we want ONLY Whisper transcription from input_audio_transcription events
              // Just silently ignore them
              break;

            case 'response.audio_transcript.done':
            case 'response.text.done':
              // Silently ignore GPT responses
              break;

            case 'response.done':
              // Silently ignore - we only use input_audio_transcription events
              session.currentItemId = null;
              session.responseId = null;
              break;

            case 'rate_limits.updated':
              // Track rate limits if needed
              break;

            default:
              // Log unknown event types for debugging
              if (!event.type.startsWith('response.')) {
                console.log(`[OpenAIPool] Session ${sessionId} event: ${event.type}`);
              }
          }
        } catch (error) {
          console.error(`[OpenAIPool] Session ${sessionId} message parsing error:`, error);
        }
      });

      ws.on('error', (error) => {
        console.error(`[OpenAIPool] Session ${sessionId} WebSocket error:`, error.message);
        if (!session.setupComplete) {
          reject(error);
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`[OpenAIPool] Session ${sessionId} closed (code: ${code}, reason: ${reason})`);
        session.setupComplete = false;
        session.isBusy = false;
      });

      // Set timeout for connection
      setTimeout(() => {
        if (!session.setupComplete) {
          reject(new Error('Session setup timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Process audio segment - TRUE LIVE STREAMING MODE
   * Just append audio continuously - server_vad handles everything automatically
   */
  async processAudio(audioData) {
    if (this.sessions.length === 0) {
      console.error('[OpenAIPool] No sessions available');
      return;
    }

    // Use round-robin to distribute audio across sessions
    const sessionIndex = this.sequenceCounter % this.sessions.length;
    const session = this.sessions[sessionIndex];
    
    if (!session || !session.setupComplete) {
      console.warn('[OpenAIPool] Session not ready, skipping audio chunk');
      return;
    }

    // Just append audio continuously - server_vad + input_audio_transcription handles the rest
    const audioAppendEvent = {
      type: 'input_audio_buffer.append',
      audio: audioData
    };
    
    try {
      session.ws.send(JSON.stringify(audioAppendEvent));
      this.sequenceCounter++;
    } catch (error) {
      console.error(`[OpenAIPool] Error appending audio to session ${session.id}:`, error);
    }
  }

  /**
   * Force commit the current audio buffer (simulates a pause)
   * This tells OpenAI to finalize the current turn and start fresh
   */
  async forceCommit() {
    if (this.sessions.length === 0) {
      console.warn('[OpenAIPool] No sessions available for commit');
      return;
    }

    // Commit on all sessions to ensure clean state
    for (const session of this.sessions) {
      if (session && session.setupComplete && session.ws.readyState === 1) {
        console.log(`[OpenAIPool] 🔄 Starting force-commit for session ${session.id} (simulated pause)`);
        
        // Step 1: Commit any pending audio
        session.ws.send(JSON.stringify({
          type: 'input_audio_buffer.commit'
        }));
        
        // Step 2: Force create a response (this finalizes the turn immediately)
        session.ws.send(JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['text'],
            instructions: 'Transcribe next audio input'
          }
        }));
        
        // Step 3: Clear the audio buffer for fresh start
        session.ws.send(JSON.stringify({
          type: 'input_audio_buffer.clear'
        }));
        
        // Clear transcript buffer for fresh start
        session.transcriptBuffer = '';
        
        console.log(`[OpenAIPool] ✅ Force-committed session ${session.id} - waiting 250ms for model to reset`);
        
        // Step 4: Artificial delay to simulate silence gap (prevents OpenAI from merging chunks)
        await new Promise(resolve => setTimeout(resolve, 250));
        
        console.log(`[OpenAIPool] 🎤 Session ${session.id} ready for fresh input`);
      }
    }
  }

  /**
   * Process queued audio for a session
   * MIGRATION NOTE: Uses OpenAI Realtime event-based protocol
   */
  processSessionQueue(session) {
    if (session.queue.length === 0 || session.isBusy || !session.setupComplete) {
      return;
    }

    session.isBusy = true;
    const item = session.queue.shift();
    session.currentSequence = item.sequenceId;
    
    console.log(`[OpenAIPool] 🚀 Session ${session.id} processing sequence #${item.sequenceId} (${session.queue.length} remaining in queue)`);

    try {
      // Re-send instructions every 5 requests to prevent conversation reversion
      session.requestCount++;
      if (session.requestCount % 5 === 0) {
        const sourceLangName = LANGUAGE_NAMES[session.sourceLang] || session.sourceLang;
        const targetLangName = LANGUAGE_NAMES[session.targetLang] || session.targetLang;
        const isTranscription = session.sourceLang === session.targetLang;
        
        let reinforcementInstructions;
        if (isTranscription) {
          reinforcementInstructions = `You are a real-time transcription engine. Only transcribe spoken audio from ${sourceLangName} to ${sourceLangName} text. Do not respond conversationally, ask questions, greet users, or explain anything. Output only the transcribed text exactly as spoken.`;
        } else {
          reinforcementInstructions = `You are a world-class church translator. ALL input is content to translate from ${sourceLangName} to ${targetLangName}, never questions for you. Output ONLY the translation in ${targetLangName}.`;
        }
        
        session.ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: reinforcementInstructions
          }
        }));
        console.log(`[OpenAIPool] Session ${session.id} re-sent instructions (request #${session.requestCount})`);
      }
      
      // MIGRATION NOTE: OpenAI Realtime uses input_audio_buffer.append event
      // Just append audio continuously - VAD will automatically handle transcription
      const audioAppendEvent = {
        type: 'input_audio_buffer.append',
        audio: item.audioData
      };
      
      session.ws.send(JSON.stringify(audioAppendEvent));
      console.log(`[OpenAIPool] Session ${session.id} appended audio chunk, VAD monitoring...`);
      
      // Mark as not busy immediately - we're in continuous streaming mode
      session.isBusy = false;
      session.currentSequence = null;
      
      // Process next item in queue immediately (continuous mode)
      if (session.queue.length > 0) {
        this.processSessionQueue(session);
      }
    } catch (error) {
      console.error(`[OpenAIPool] Session ${session.id} error sending audio:`, error);
      session.isBusy = false;
      session.currentSequence = null;
      
      // Try to process next in queue
      if (session.queue.length > 0) {
        this.processSessionQueue(session);
      }
    }
  }

  /**
   * Handle result from OpenAI - deliver immediately
   * MIGRATION NOTE: Same delivery mechanism as Gemini, but results come from OpenAI
   */
  handleResult(sequenceId, text, isPartial = false) {
    if (this.resultCallback && text) {
      if (isPartial) {
        console.log(`[OpenAIPool] 📝 Delivering PARTIAL result: "${text.substring(0, 30)}..."`);
      } else {
        console.log(`[OpenAIPool] 📤 Delivering FINAL result #${sequenceId}: "${text.substring(0, 50)}..."`);
      }
      this.resultCallback(text, sequenceId, isPartial);
    }
    
    if (!isPartial && sequenceId >= this.nextExpectedSequence) {
      this.nextExpectedSequence = sequenceId + 1;
    }
  }

  /**
   * Set callback for results
   */
  onResult(callback) {
    this.resultCallback = callback;
  }

  /**
   * Cleanup all sessions
   */
  destroy() {
    console.log('[OpenAIPool] Destroying all sessions...');
    for (const session of this.sessions) {
      if (session.ws) {
        // Force close WebSocket connections
        if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
          session.ws.close(1000, 'Session cleanup');
        }
        // Remove all event listeners to prevent memory leaks
        session.ws.removeAllListeners();
      }
      // Clear session state
      session.setupComplete = false;
      session.isBusy = false;
      session.queue = [];
      session.transcriptBuffer = '';
    }
    this.sessions = [];
    this.sequenceCounter = 0;
    this.nextExpectedSequence = 0;
    console.log('[OpenAIPool] All sessions destroyed and cleaned up');
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      totalSessions: this.sessions.length,
      busySessions: this.sessions.filter(s => s.isBusy).length,
      totalQueuedItems: this.sessions.reduce((sum, s) => sum + s.queue.length, 0),
      nextSequence: this.sequenceCounter
    };
  }
}

