/**
 * Session Store - Manages live translation sessions
 * Handles master (host) and listeners for each session
 */

class SessionStore {
  constructor() {
    // Map<sessionId, SessionData>
    this.sessions = new Map();
  }

  /**
   * Creates a new session
   * @returns {Object} { sessionId, sessionCode }
   */
  createSession() {
    const sessionId = this.generateUUID();
    const sessionCode = this.generateSessionCode();
    
    const sessionData = {
      sessionId,
      sessionCode,
      hostSocket: null,
      hostGeminiSocket: null,
      listeners: new Map(), // Map<socketId, ListenerData>
      languageGroups: new Map(), // Map<targetLang, Set<socketId>>
      sourceLang: 'en',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      isActive: false
    };
    
    this.sessions.set(sessionId, sessionData);
    console.log(`[SessionStore] Created session ${sessionCode} (${sessionId})`);
    
    return { sessionId, sessionCode };
  }

  /**
   * Get session by ID
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Get session by code
   */
  getSessionByCode(sessionCode) {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.sessionCode === sessionCode.toUpperCase()) {
        return session;
      }
    }
    return null;
  }

  /**
   * Set the host for a session
   */
  setHost(sessionId, hostSocket, geminiSocket) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    
    session.hostSocket = hostSocket;
    session.hostGeminiSocket = geminiSocket;
    session.isActive = true;
    session.lastActivity = Date.now();
    
    console.log(`[SessionStore] Host connected to session ${session.sessionCode}`);
  }

  /**
   * Add a listener to a session
   */
  addListener(sessionId, socketId, socket, targetLang, userName = 'Anonymous') {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const listenerData = {
      socketId,
      socket,
      targetLang,
      userName,
      joinedAt: Date.now()
    };

    session.listeners.set(socketId, listenerData);

    // Add to language group
    if (!session.languageGroups.has(targetLang)) {
      session.languageGroups.set(targetLang, new Set());
    }
    session.languageGroups.get(targetLang).add(socketId);

    session.lastActivity = Date.now();

    console.log(`[SessionStore] Listener ${userName} joined session ${session.sessionCode} (${targetLang}) - Total: ${session.listeners.size}`);

    return listenerData;
  }

  /**
   * Update a listener's target language (removes from old language group, adds to new one)
   */
  updateListenerLanguage(sessionId, socketId, newTargetLang) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const listener = session.listeners.get(socketId);
    if (!listener) {
      throw new Error('Listener not found');
    }

    const oldTargetLang = listener.targetLang;

    // If language hasn't changed, do nothing
    if (oldTargetLang === newTargetLang) {
      return listener;
    }

    console.log(`[SessionStore] Updating listener ${listener.userName} language: ${oldTargetLang} → ${newTargetLang}`);

    // Remove from old language group
    const oldLangGroup = session.languageGroups.get(oldTargetLang);
    if (oldLangGroup) {
      oldLangGroup.delete(socketId);
      // Clean up empty language groups
      if (oldLangGroup.size === 0) {
        session.languageGroups.delete(oldTargetLang);
      }
    }

    // Update listener data
    listener.targetLang = newTargetLang;

    // Add to new language group
    if (!session.languageGroups.has(newTargetLang)) {
      session.languageGroups.set(newTargetLang, new Set());
    }
    session.languageGroups.get(newTargetLang).add(socketId);

    session.lastActivity = Date.now();

    console.log(`[SessionStore] Listener ${listener.userName} moved to language group ${newTargetLang}`);

    return listener;
  }

  /**
   * Remove a listener from a session
   */
  removeListener(sessionId, socketId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const listener = session.listeners.get(socketId);
    if (listener) {
      // Remove from language group
      const langGroup = session.languageGroups.get(listener.targetLang);
      if (langGroup) {
        langGroup.delete(socketId);
        if (langGroup.size === 0) {
          session.languageGroups.delete(listener.targetLang);
        }
      }
      
      session.listeners.delete(socketId);
      console.log(`[SessionStore] Listener removed from session ${session.sessionCode} - Remaining: ${session.listeners.size}`);
    }
  }

  /**
   * Get all listeners for a specific language in a session
   */
  getListenersByLanguage(sessionId, targetLang) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const socketIds = session.languageGroups.get(targetLang);
    if (!socketIds) return [];

    return Array.from(socketIds)
      .map(id => session.listeners.get(id))
      .filter(Boolean);
  }

  /**
   * Get all unique target languages in a session
   */
  getSessionLanguages(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    
    return Array.from(session.languageGroups.keys());
  }

  /**
   * Broadcast message to all listeners in a session
   */
  broadcastToListeners(sessionId, message, targetLang = null) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    let listeners;
    if (targetLang) {
      // Broadcast to specific language group
      listeners = this.getListenersByLanguage(sessionId, targetLang);
    } else {
      // Broadcast to all listeners
      listeners = Array.from(session.listeners.values());
    }

    const messageStr = JSON.stringify(message);
    let sentCount = 0;

    listeners.forEach(listener => {
      if (listener.socket.readyState === 1) { // WebSocket.OPEN
        try {
          listener.socket.send(messageStr);
          sentCount++;

          // TEMP DEBUG: Log exact payload sent to ES listeners for "Y grito"
          if (targetLang === 'es' && message?.hasTranslation && (message?.translatedText || '').includes('Y grito')) {
            console.log('[ES_PAYLOAD_TO_LISTENER]', JSON.stringify(message));
          }
        } catch (error) {
          console.error(`[SessionStore] Error sending to listener:`, error.message);
        }
      }
    });

    console.log(`[SessionStore] Broadcast to ${sentCount}/${listeners.length} listeners${targetLang ? ` (${targetLang})` : ''}`);
  }

  /**
   * Update session source language
   */
  updateSourceLanguage(sessionId, sourceLang) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.sourceLang = sourceLang;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Close a session and clean up
   */
  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`[SessionStore] Closing session ${session.sessionCode}`);

    // Close host Gemini connection
    if (session.hostGeminiSocket && session.hostGeminiSocket.readyState === 1) {
      session.hostGeminiSocket.close();
    }

    // Notify all listeners
    this.broadcastToListeners(sessionId, {
      type: 'session_ended',
      message: 'The host has ended the session'
    });

    // Close all listener connections
    session.listeners.forEach(listener => {
      if (listener.socket.readyState === 1) {
        listener.socket.close();
      }
    });

    this.sessions.delete(sessionId);
  }

  /**
   * Get session statistics
   */
  getSessionStats(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      sessionId: session.sessionId,
      sessionCode: session.sessionCode,
      isActive: session.isActive,
      listenerCount: session.listeners.size,
      languages: Array.from(session.languageGroups.keys()),
      languageCounts: Object.fromEntries(
        Array.from(session.languageGroups.entries()).map(([lang, set]) => [lang, set.size])
      ),
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      duration: Date.now() - session.createdAt
    };
  }

  /**
   * Clean up inactive sessions (older than 1 hour with no activity)
   */
  cleanupInactiveSessions() {
    const MAX_INACTIVE_TIME = 60 * 60 * 1000; // 1 hour
    const now = Date.now();
    
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > MAX_INACTIVE_TIME) {
        console.log(`[SessionStore] Cleaning up inactive session ${session.sessionCode}`);
        this.closeSession(sessionId);
      }
    }
  }

  /**
   * Generate a UUID
   */
  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Generate a short session code (6 characters)
   */
  generateSessionCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude similar looking chars
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  /**
   * Get all active sessions
   */
  getAllSessions() {
    return Array.from(this.sessions.values()).map(session => ({
      sessionId: session.sessionId,
      sessionCode: session.sessionCode,
      isActive: session.isActive,
      listenerCount: session.listeners.size,
      languages: Array.from(session.languageGroups.keys()),
      createdAt: session.createdAt
    }));
  }
}

// Singleton instance
const sessionStore = new SessionStore();

// Clean up inactive sessions every 10 minutes
setInterval(() => {
  sessionStore.cleanupInactiveSessions();
}, 10 * 60 * 1000);

export default sessionStore;

