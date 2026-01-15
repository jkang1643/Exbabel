/**
 * iOS Audio Unlock Utility
 * 
 * Safari iOS requires audio playback to be initiated by a direct user gesture.
 * This utility unlocks audio playback for the entire session by playing a silent
 * audio frame within a user tap event.
 * 
 * CRITICAL: Must be called directly inside a user gesture handler (e.g., button click).
 */

let __audioUnlocked = false;

/**
 * Unlock iOS audio playback by playing a silent audio frame.
 * This must be called from within a user gesture (e.g., button click).
 * 
 * @returns {Promise<void>}
 */
export async function unlockIOSAudio() {
    if (__audioUnlocked) {
        console.log('[iOS Audio Unlock] Already unlocked, skipping');
        return;
    }

    const audio = new Audio();
    audio.playsInline = true;
    audio.muted = true;

    // Tiny silent MP3 data URL (minimal audio frame)
    audio.src = "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADhAC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAA4T0Qj3JAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+xDEHgPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+xDEKAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

    try {
        await audio.play();
        __audioUnlocked = true;
        console.log('[iOS Audio Unlock] ✅ Audio successfully unlocked for this session');
        if (window.audioDebug) {
            window.audioDebug('iOS audio unlocked', { success: true });
        }
    } catch (err) {
        console.warn('[iOS Audio Unlock] ⚠️ Failed to unlock audio:', err.message);
        if (window.audioDebug) {
            window.audioDebug('iOS unlock failed', { error: err.name, message: err.message });
        }
    }
}

/**
 * Check if audio has been unlocked
 * @returns {boolean}
 */
export function isAudioUnlocked() {
    return __audioUnlocked;
}
