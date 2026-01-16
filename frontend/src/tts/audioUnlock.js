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
        if (window.audioDebug) {
            window.audioDebug('iOS unlock skipped (already unlocked)', {});
        }
        return;
    }

    try {
        // 1) WebAudio unlock (best practice for iOS Safari)
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
            const ctx = new AudioCtx();

            // resume MUST be called from a user gesture
            await ctx.resume();

            // Play a silent buffer to fully prime iOS audio pipeline
            const buffer = ctx.createBuffer(1, 1, 22050);
            const source = ctx.createBufferSource();
            source.buffer = buffer;

            const gain = ctx.createGain();
            gain.gain.value = 0;

            source.connect(gain);
            gain.connect(ctx.destination);

            source.start(0);
            source.stop(0.01);

            __audioUnlocked = true;
            console.log('[iOS Audio Unlock] ✅ Audio successfully unlocked via WebAudio');
            if (window.audioDebug) {
                window.audioDebug('iOS AUDIO UNLOCKED ✅', { method: 'WebAudio' });
            }
        }

        // 2) Optional HTMLAudioElement fallback (not always reliable, but doesn't hurt)
        const a = new Audio();
        a.playsInline = true;
        a.muted = true;
        a.src = ""; // keep empty; just touching play() in gesture sometimes helps
        const p = a.play();
        if (p && p.catch) p.catch(() => { });
        a.pause();

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
