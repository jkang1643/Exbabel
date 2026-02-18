/**
 * Session Store - Manages live translation sessions
 * Handles master (host) and listeners for each session
 * 
 * ARCHITECTURE:
 * - In-memory Map for real-time performance (sockets, listeners)
 * - Supabase DB for persistence (survives restarts, enables auditing)
 * - DB is source of truth for session_id → church_id mapping
 * 
 * SESSION LIFECYCLE:
 * - Session ends when: (1) host clicks End Session, (2) host disconnects and doesn't reconnect within grace period
 * - Session does NOT end when: listener leaves
 */

import { supabaseAdmin } from './supabaseAdmin.js';

// DEBUG: Gate high-frequency broadcast logging to prevent I/O overhead
// Set DEBUG_BROADCAST=1 to enable verbose broadcast logs
const DEBUG_BROADCAST = process.env.DEBUG_BROADCAST === '1';

// Grace period before ending session after host disconnects (allows reconnection)
const HOST_DISCONNECT_GRACE_MS = 30000; // 30 seconds

class SessionStore {
  constructor() {
    // Map<sessionId, SessionData> - in-memory cache for real-time ops
    this.sessions = new Map();
    // Map<sessionId, timeoutId> - pending end timers for grace period
    this.pendingEndTimers = new Map();
  }

  /**
   * Creates a new session
   * @param {string|null} churchId - Optional tenant ID for billing/entitlements
   * @param {string|null} hostUserId - Optional host user ID
   * @returns {Promise<Object>} { sessionId, sessionCode }
   */
  async createSession(churchId = null, hostUserId = null, overrideCode = null) {
    const sessionId = this.generateUUID();
    const sessionCode = overrideCode || this.generateSessionCode();

    const sessionData = {
      sessionId,
      sessionCode,
      churchId,           // Tenant context for billing/entitlements (immutable once set)
      hostUserId,
      hostSocket: null,
      hostGeminiSocket: null,
      listeners: new Map(), // Map<socketId, ListenerData>
      languageGroups: new Map(), // Map<targetLang, Set<socketId>>
      sourceLang: 'en',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      isActive: false,
      voicePreferences: new Map() // Map<targetLang, voiceId> - Last Write Wins for shared channel
    };

    // Persist to DB (if churchId is known)
    if (churchId) {
      try {
        const { error } = await supabaseAdmin
          .from('sessions')
          .insert({
            id: sessionId,
            church_id: churchId,
            host_user_id: hostUserId,
            session_code: sessionCode,
            status: 'active',
            source_lang: 'en'
          });

        if (error) {
          console.error(`[SessionStore] DB insert failed:`, error.message);
          // Continue with in-memory only (graceful degradation)
        } else {
          console.log(`[SessionStore] ✓ Session persisted to DB: ${sessionCode}`);
        }
      } catch (dbErr) {
        console.error(`[SessionStore] DB error:`, dbErr.message);
      }
    }

    this.sessions.set(sessionId, sessionData);
    console.log(`[SessionStore] Created session ${sessionCode} (${sessionId}) churchId=${churchId || 'pending'}`);

    return { sessionId, sessionCode };
  }

  /**
   * Set the churchId for a session (immutable once set)
   * Also persists/updates in DB if not already there
   * @param {string} sessionId
   * @param {string} churchId
   * @param {string|null} hostUserId - Optional host user ID
   * @returns {Promise<boolean>} true if set, false if already set to different value
   */
  async setChurchId(sessionId, churchId, hostUserId = null) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[SessionStore] setChurchId failed: session ${sessionId} not found`);
      return false;
    }

    // Immutability check: once set, can't change
    if (session.churchId && session.churchId !== churchId) {
      console.error(`[SessionStore] ❌ INVARIANT VIOLATION: Attempted to change churchId from ${session.churchId} to ${churchId} for session ${sessionId}`);
      return false;
    }

    session.churchId = churchId;
    session.lastActivity = Date.now();

    // Persist to DB (upsert pattern - insert or update)
    try {
      const { error } = await supabaseAdmin
        .from('sessions')
        .upsert({
          id: sessionId,
          church_id: churchId,
          host_user_id: hostUserId || session.hostUserId,
          session_code: session.sessionCode,
          status: 'active',
          source_lang: session.sourceLang || 'en'
        }, { onConflict: 'id' });

      if (error) {
        console.error(`[SessionStore] DB upsert failed:`, error.message);
      } else {
        console.log(`[SessionStore] ✓ Session churchId persisted to DB: ${session.sessionCode}`);
      }
    } catch (dbErr) {
      console.error(`[SessionStore] DB error:`, dbErr.message);
    }

    console.log(`[SessionStore] ✓ churchId set for session ${session.sessionCode}: ${churchId}`);
    return true;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Get session by code
   * Checks in-memory cache first, then DB fallback for recovery after restart
   * @param {string} sessionCode
   * @returns {Promise<Object|null>} session or null
   */
  async getSessionByCode(sessionCode) {
    const upperCode = sessionCode.toUpperCase();

    // Check in-memory cache first
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.sessionCode === upperCode) {
        return session;
      }
    }

    // DB fallback: session might exist from before restart
    try {
      const { data, error } = await supabaseAdmin
        .from('sessions')
        .select('id, church_id, host_user_id, session_code, status, source_lang, created_at')
        .eq('session_code', upperCode)
        .eq('status', 'active')
        .single();

      if (error || !data) {
        return null;
      }

      // Reconstitute session in memory (without sockets - host will need to reconnect)
      const sessionData = {
        sessionId: data.id,
        sessionCode: data.session_code,
        churchId: data.church_id,
        hostUserId: data.host_user_id,
        hostSocket: null,
        hostGeminiSocket: null,
        listeners: new Map(),
        languageGroups: new Map(),
        sourceLang: data.source_lang || 'en',
        createdAt: new Date(data.created_at).getTime(),
        lastActivity: Date.now(),
        isActive: false, // Host needs to reconnect to activate
        voicePreferences: new Map()
      };

      this.sessions.set(data.id, sessionData);
      console.log(`[SessionStore] ✓ Session recovered from DB: ${data.session_code} (churchId=${data.church_id})`);
      return sessionData;
    } catch (dbErr) {
      console.error(`[SessionStore] DB lookup error:`, dbErr.message);
      return null;
    }
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
          if (DEBUG_BROADCAST && targetLang === 'es' && message?.hasTranslation && (message?.translatedText || '').includes('Y grito')) {
            console.log('[ES_PAYLOAD_TO_LISTENER]', JSON.stringify(message));
          }
        } catch (error) {
          console.error(`[SessionStore] Error sending to listener:`, error.message);
        }
      }
    });

    if (DEBUG_BROADCAST) console.log(`[SessionStore] Broadcast to ${sentCount}/${listeners.length} listeners${targetLang ? ` (${targetLang})` : ''}`);
  }

  updateSourceLanguage(sessionId, sourceLang) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.sourceLang = sourceLang;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Update voice preference for a session language
   */
  updateSessionVoice(sessionId, targetLang, voiceId) {
    const session = this.sessions.get(sessionId);
    if (session && targetLang && voiceId) {
      // Store using EXACT language code (supports dialects like es-MX distinct from es-ES)
      session.voicePreferences.set(targetLang, voiceId);
      session.lastActivity = Date.now();
      console.log(`[SessionStore] Voice updated for session ${session.sessionCode} (${targetLang}): ${voiceId}`);
    }
  }

  /**
   * Get voice preference for a session language
   * Supports fallback from specific locale (es-MX) to base language (es)
   */
  getSessionVoice(sessionId, targetLang) {
    const session = this.sessions.get(sessionId);
    if (!session || !targetLang) return null;

    // 1. Try exact match (e.g., "es-MX")
    const exactMatch = session.voicePreferences.get(targetLang);
    if (exactMatch) return exactMatch;

    // 2. Try base language fallback (e.g., "es-MX" -> "es")
    if (targetLang.includes('-')) {
      const baseLang = targetLang.split('-')[0];
      const baseMatch = session.voicePreferences.get(baseLang);
      if (baseMatch) {
        // Only log fallback in debug mode to avoid noise
        // console.log(`[SessionStore] Voice fallback ${targetLang} -> ${baseLang}`);
        return baseMatch;
      }
    }

    return null;
  }

  /**
   * END SESSION - The authoritative way to end a session
   * Call this for: explicit end button, grace period timeout, startup cleanup
   * @param {string} sessionId
   * @param {string} reason - Why session ended: 'host_clicked_end', 'host_disconnected', 'backend_restart_cleanup', etc.
   * @returns {Promise<boolean>} true if ended, false if already ended or not found
   */
  async endSession(sessionId, reason = 'unknown') {
    // Cancel any pending end timer
    this.cancelScheduledEnd(sessionId);

    const session = this.sessions.get(sessionId);
    const sessionCode = session?.sessionCode || sessionId.substring(0, 8);

    console.log(`[SessionStore] 🔴 Ending session ${sessionCode} (${sessionId}) (reason: ${reason})`);

    // Update DB first (idempotent - won't fail if already ended)
    try {
      console.log(`[SessionStore] 🔍 DEBUG: Attempting DB update for ${sessionId}...`);
      const { data, error } = await supabaseAdmin
        .from('sessions')
        .update({
          status: 'ended',
          ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: supabaseAdmin.rpc ? undefined : { ended_reason: reason }
        })
        .eq('id', sessionId)
        .select();

      if (error) {
        console.error(`[SessionStore] ❌ DB update failed on end:`, error.message, error.details);
      } else if (data && data.length > 0) {
        const row = data[0];
        console.log(`[SessionStore] ✓ Session marked ended in DB: ${sessionCode} (status=${row.status}, ended_at=${row.ended_at})`);
      } else {
        console.log(`[SessionStore] ⚠️ DB update returned no rows! Session ${sessionId} might not exist in DB or is already ended.`);
        // Try to fetch it to see what's wrong
        const { data: check } = await supabaseAdmin.from('sessions').select('*').eq('id', sessionId).single();
        console.log(`[SessionStore] 🔍 DB State for ${sessionId}:`, check);
      }
    } catch (dbErr) {
      console.error(`[SessionStore] DB error on end:`, dbErr.message);
    }

    // Clean up in-memory state
    if (session) {
      // Close host Gemini connection
      if (session.hostGeminiSocket && session.hostGeminiSocket.readyState === 1) {
        session.hostGeminiSocket.close();
      }

      // Notify all listeners
      this.broadcastToListeners(sessionId, {
        type: 'session_ended',
        reason: reason,
        message: reason === 'host_clicked_end'
          ? 'The host has ended the session'
          : 'The session has ended'
      });

      // Close all listener connections
      session.listeners.forEach(listener => {
        if (listener.socket.readyState === 1) {
          listener.socket.close();
        }
      });

      this.sessions.delete(sessionId);
      return true;
    }

    return false;
  }

  /**
   * Schedule session end after grace period (for host disconnect)
   * Host can reconnect within grace period to cancel
   * @param {string} sessionId
   */
  scheduleSessionEnd(sessionId) {
    // Cancel any existing timer
    this.cancelScheduledEnd(sessionId);

    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`[SessionStore] ⏳ Scheduling session end in ${HOST_DISCONNECT_GRACE_MS / 1000}s: ${session.sessionCode}`);

    const timerId = setTimeout(async () => {
      this.pendingEndTimers.delete(sessionId);
      console.log(`[SessionStore] ⏰ Grace period expired for ${session.sessionCode}, ending session`);
      await this.endSession(sessionId, 'host_disconnected');
    }, HOST_DISCONNECT_GRACE_MS);

    this.pendingEndTimers.set(sessionId, timerId);
  }

  /**
   * Cancel scheduled session end (host reconnected)
   * @param {string} sessionId
   */
  cancelScheduledEnd(sessionId) {
    const timerId = this.pendingEndTimers.get(sessionId);
    if (timerId) {
      clearTimeout(timerId);
      this.pendingEndTimers.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) {
        console.log(`[SessionStore] ✓ Cancelled scheduled end for ${session.sessionCode} (host reconnected?)`);
      }
    }
  }

  /**
   * Cleanup abandoned sessions on backend startup
   * Marks all 'active' sessions as ended with reason 'backend_restart_cleanup'
   * Call this once when the backend starts
   */
  async cleanupAbandonedSessions() {
    console.log(`[SessionStore] 🧹 Cleaning up abandoned sessions from previous run...`);

    try {
      const { data, error } = await supabaseAdmin
        .from('sessions')
        .update({
          status: 'ended',
          ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('status', 'active')
        .select('id, session_code');

      if (error) {
        console.error(`[SessionStore] Cleanup failed:`, error.message);
      } else if (data && data.length > 0) {
        console.log(`[SessionStore] ✓ Cleaned up ${data.length} abandoned session(s):`);
        data.forEach(s => console.log(`  - ${s.session_code} (${s.id})`));
      } else {
        console.log(`[SessionStore] ✓ No abandoned sessions to clean up`);
      }
    } catch (dbErr) {
      console.error(`[SessionStore] Cleanup error:`, dbErr.message);
    }
  }

  /**
   * @deprecated Use endSession(sessionId, reason) instead
   * Kept for backwards compatibility during transition
   */
  async closeSession(sessionId) {
    console.warn(`[SessionStore] closeSession() is deprecated, use endSession() instead`);
    return this.endSession(sessionId, 'close_session_deprecated');
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
      churchId: session.churchId,  // Include for debugging/verification
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
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
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

