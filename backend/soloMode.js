/**
 * Solo Mode Handler - Single-session Gemini connection for solo users
 * Based on host mode but without session/listener management
 */

import WebSocket from 'ws';

const LANGUAGE_NAMES = {
  'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German', 'it': 'Italian',
  'pt': 'Portuguese', 'ru': 'Russian', 'ja': 'Japanese', 'ko': 'Korean',
  'zh': 'Chinese (Simplified)', 'ar': 'Arabic', 'hi': 'Hindi', 'nl': 'Dutch',
  'pl': 'Polish', 'tr': 'Turkish', 'vi': 'Vietnamese', 'th': 'Thai'
};

export async function handleSoloMode(clientWs) {
  console.log("[Solo] Starting solo mode session");

  let geminiWs = null;
  let currentSourceLang = 'en';
  let currentTargetLang = 'es';
  let reconnecting = false;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;
  let messageQueue = [];
  
  // State management for multi-turn streaming
  let isStreamingAudio = false;
  let setupComplete = false;
  let lastAudioTime = null;
  const AUDIO_END_TIMEOUT = 1500; // Reduced from 3000ms
  let audioEndTimer = null;
  let maxStreamTimer = null;
  let streamStartTime = null;
  let transcriptBuffer = '';
  let audioGracePeriodTimer = null;
  const GRACE_PERIOD = 200; // Reduced from 500ms
  
  // Intelligent transcript merging
  let previousTranscript = '';

  // Send audio stream end
  const sendAudioStreamEnd = () => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN && isStreamingAudio) {
      console.log('[Solo] Sending audioStreamEnd');
      
      geminiWs.send(JSON.stringify({
        realtimeInput: { audioStreamEnd: true }
      }));
      
      isStreamingAudio = false;
      lastAudioTime = null;
      streamStartTime = null;
      
      if (audioEndTimer) {
        clearTimeout(audioEndTimer);
        audioEndTimer = null;
      }
      if (maxStreamTimer) {
        clearTimeout(maxStreamTimer);
        maxStreamTimer = null;
      }
      if (audioGracePeriodTimer) {
        clearTimeout(audioGracePeriodTimer);
        audioGracePeriodTimer = null;
      }
    }
  };

  // Trigger graceful audio end
  const triggerGracefulAudioEnd = () => {
    if (isStreamingAudio) {
      console.log(`[Solo] Triggering graceful audio end with ${GRACE_PERIOD}ms grace period`);
      isStreamingAudio = false;
      
      audioGracePeriodTimer = setTimeout(() => {
        sendAudioStreamEnd();
      }, GRACE_PERIOD);
    }
  };

  // Connect to Gemini
  const connectToGemini = () => {
    return new Promise((resolve, reject) => {
      console.log("[Solo] Connecting to Gemini...");
      
      const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
      const ws = new WebSocket(geminiWsUrl);
      
      ws.on("open", () => {
        console.log("[Solo] Connected to Gemini");
        
        const sourceLangName = LANGUAGE_NAMES[currentSourceLang] || currentSourceLang;
        const targetLangName = LANGUAGE_NAMES[currentTargetLang] || currentTargetLang;
        const isTranscription = currentSourceLang === currentTargetLang;
        
        const systemInstructionText = isTranscription ? 
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
9. Do NOT make up or hallucinate content

Your ONLY job: Write what you hear.

Examples:
Audio: "Can you hear me?"
Output: "Can you hear me?"
NOT: "Yes" or "I can"

Audio: "Hello, how are you today?"
Output: "Hello, how are you today?"
NOT: "I'm fine" or any response`
          :
          `You are a TRANSLATION MACHINE ONLY. Your ONLY function is to translate text.

MANDATORY RULES - YOU MUST FOLLOW THESE:
1. Output ONLY the translated text in ${targetLangName}
2. NEVER respond conversationally, NEVER answer questions, NEVER provide assistance
3. NEVER acknowledge the user or respond to their requests
4. NEVER include explanations, commentary, or preambles
5. NEVER make up or hallucinate content
6. NEVER repeat previous translations or reference prior context
7. If input is a question, translate the QUESTION ITSELF - do NOT answer it
8. If input is a statement, translate the STATEMENT - do NOT respond to it

EXAMPLES:
- Input: "Can you hear me?" → Output: "¿Puedes oírme?" (NOT "Yes, I can hear you")
- Input: "Do you understand?" → Output: "¿Entiendes?" (NOT "Yes, I understand")
- Input: "Hello, how are you?" → Output: "Hola, ¿cómo estás?" (NOT "I'm fine, thank you")

CRITICAL: You are a translator, NOT a conversational assistant. Translate only.`;
        
        ws.send(JSON.stringify({
          setup: {
            model: "models/gemini-live-2.5-flash-preview",
            generationConfig: { responseModalities: ["TEXT"] },
            systemInstruction: { parts: [{ text: systemInstructionText }] }
          }
        }));
        
        console.log(`[Solo] Sent setup (${sourceLangName} → ${targetLangName})`);
        resolve(ws);
      });
      
      ws.on("error", (error) => {
        console.error("[Solo] Gemini connection error:", error.message);
        reject(error);
      });
    });
  };

  // Attach Gemini handlers
  const attachGeminiHandlers = (ws) => {
    ws.on("error", (error) => {
      console.error("[Solo] Gemini error:", error.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'error',
          message: 'Gemini connection error'
        }));
      }
    });

    ws.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString());

        if (response.setupComplete) {
          console.log("[Solo] Gemini setup complete");
          setupComplete = true;
          
          if (messageQueue.length > 0) {
            console.log(`[Solo] Processing ${messageQueue.length} queued messages`);
            const queued = [...messageQueue];
            messageQueue = [];
            queued.forEach(q => {
              clientWs.emit('message', JSON.stringify(q.message));
            });
          }
          return;
        }

        if (response.serverContent) {
          const serverContent = response.serverContent;
          
          if (serverContent.modelTurn && serverContent.modelTurn.parts) {
            serverContent.modelTurn.parts.forEach(part => {
              if (part.text) {
                console.log('[Solo] 📝 Gemini text chunk:', `"${part.text}"`);
                transcriptBuffer += part.text;
              }
            });
          }
          
          if (serverContent.turnComplete) {
            const currentTranscript = transcriptBuffer.trim();
            console.log('[Solo] Turn complete - transcript length:', currentTranscript.length);
            console.log('[Solo] Transcript:', currentTranscript ? `"${currentTranscript}"` : '(EMPTY)');
            
            if (currentTranscript && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'translation',
                originalText: '',
                translatedText: currentTranscript,
                timestamp: Date.now()
              }));
              
              transcriptBuffer = '';
            } else if (!currentTranscript) {
              console.warn('[Solo] ⚠️ Turn complete but NO TRANSCRIPT - Gemini returned nothing!');
            }
            
            if (audioEndTimer) {
              clearTimeout(audioEndTimer);
              audioEndTimer = null;
            }
            if (maxStreamTimer) {
              clearTimeout(maxStreamTimer);
              maxStreamTimer = null;
            }
            
            isStreamingAudio = false;
            lastAudioTime = null;
            streamStartTime = null;
            
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'turn_complete',
                timestamp: Date.now()
              }));
            }
          }
        }
      } catch (error) {
        console.error("[Solo] Error processing Gemini response:", error);
      }
    });

    ws.on("close", async (code, reason) => {
      console.log(`[Solo] Gemini closed. Code: ${code}`);
      
      isStreamingAudio = false;
      setupComplete = false;
      transcriptBuffer = '';
      
      if (audioEndTimer) clearTimeout(audioEndTimer);
      if (maxStreamTimer) clearTimeout(maxStreamTimer);
      if (audioGracePeriodTimer) clearTimeout(audioGracePeriodTimer);
      
      if (clientWs.readyState === WebSocket.OPEN && !reconnecting) {
        reconnecting = true;
        const backoffDelay = Math.min(500 * Math.pow(2, reconnectAttempts), 4000);
        
        try {
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          geminiWs = await connectToGemini();
          attachGeminiHandlers(geminiWs);
          reconnecting = false;
          if (code !== 1011) reconnectAttempts = 0;
        } catch (error) {
          reconnecting = false;
          console.error('[Solo] Failed to reconnect:', error);
        }
      }
    });
  };

  // Handle client messages
  clientWs.on("message", (msg) => {
    try {
      const message = JSON.parse(msg.toString());

      switch (message.type) {
        case 'init':
          const prevSourceLang = currentSourceLang;
          const prevTargetLang = currentTargetLang;
          
          if (message.sourceLang) currentSourceLang = message.sourceLang;
          if (message.targetLang) currentTargetLang = message.targetLang;
          
          previousTranscript = '';
          
          const languagesChanged = (prevSourceLang !== currentSourceLang) || (prevTargetLang !== currentTargetLang);
          if (languagesChanged && geminiWs && geminiWs.readyState === WebSocket.OPEN && setupComplete) {
            console.log('[Solo] Languages changed, reconnecting...');
            geminiWs.close();
          }
          
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'session_ready',
              message: 'Translation session ready'
            }));
          }
          break;

        case 'audio':
          if (geminiWs && geminiWs.readyState === WebSocket.OPEN && setupComplete) {
            let segmentReason = 'unknown';
            if (message.metadata) {
              const { duration, reason, overlapMs } = message.metadata;
              segmentReason = reason || 'unknown';
              console.log(`[Solo] Audio: ${duration?.toFixed(0) || '?'}ms, reason: ${reason}, overlap: ${overlapMs || 0}ms`);
            }
            
            // Send audio chunk
            geminiWs.send(JSON.stringify({
              realtimeInput: {
                audio: {
                  mimeType: 'audio/pcm;rate=16000',
                  data: message.audioData
                }
              }
            }));
            
            console.log('[Solo] Audio sent, immediately signaling stream end');
            
            // CRITICAL FIX: Send audioStreamEnd immediately after each chunk
            // Gemini doesn't process audio until stream end is signaled
            setTimeout(() => {
              if (geminiWs && geminiWs.readyState === 1) {
                geminiWs.send(JSON.stringify({
                  realtimeInput: { audioStreamEnd: true }
                }));
                console.log('[Solo] Sent audioStreamEnd');
              }
            }, 100); // Small delay to ensure audio is transmitted first
          } else if (!setupComplete && messageQueue.length < 10) {
            messageQueue.push({ type: 'audio', message });
          }
          break;
        
        case 'audio_end':
          console.log('[Solo] Client signaled audio end');
          if (audioEndTimer) clearTimeout(audioEndTimer);
          if (maxStreamTimer) clearTimeout(maxStreamTimer);
          triggerGracefulAudioEnd();
          previousTranscript = '';
          break;
      }
    } catch (error) {
      console.error("[Solo] Error processing message:", error);
    }
  });

  // Handle client disconnect
  clientWs.on("close", () => {
    console.log("[Solo] Client disconnected");
    
    if (audioEndTimer) clearTimeout(audioEndTimer);
    if (maxStreamTimer) clearTimeout(maxStreamTimer);
    if (audioGracePeriodTimer) clearTimeout(audioGracePeriodTimer);
    
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });

  // Initialize Gemini connection
  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY not configured');
    }
    
    geminiWs = await connectToGemini();
    attachGeminiHandlers(geminiWs);
    
    console.log('[Solo] Session ready');
  } catch (error) {
    console.error('[Solo] Initialization error:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'error',
        message: `Failed to initialize: ${error.message}`
      }));
    }
  }
}

