/**
 * Filesystem-based snapshot storage for TTS provider inventories
 * 
 * Stores snapshots as JSON files in: snapshots/{providerKey}/{YYYY-MM-DD}.json
 * Uses atomic writes (temp + rename) to prevent corruption
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');

/**
 * Get snapshot directory for a provider
 * @private
 */
function _getProviderDir(providerKey) {
    return path.join(SNAPSHOTS_DIR, providerKey);
}

/**
 * Get snapshot filename for a date
 * @private
 */
function _getSnapshotFilename(date = new Date()) {
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    return `${dateStr}.json`;
}

/**
 * Ensure directory exists
 * @private
 */
async function _ensureDir(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
}

/**
 * Save a snapshot for a provider (atomic write)
 * @param {string} providerKey - Provider identifier (e.g., 'google_cloud_tts')
 * @param {object} snapshotObj - Snapshot data
 * @returns {Promise<string>} Path to saved snapshot
 */
export async function saveSnapshot(providerKey, snapshotObj) {
    const providerDir = _getProviderDir(providerKey);
    await _ensureDir(providerDir);

    const filename = _getSnapshotFilename();
    const finalPath = path.join(providerDir, filename);
    const tempPath = `${finalPath}.tmp`;

    // Write to temp file
    await fs.writeFile(tempPath, JSON.stringify(snapshotObj, null, 2), 'utf8');

    // Atomic rename
    await fs.rename(tempPath, finalPath);

    console.log(`[SnapshotStore] Saved snapshot: ${finalPath}`);
    return finalPath;
}

/**
 * Load the latest snapshot for a provider
 * @param {string} providerKey - Provider identifier
 * @returns {Promise<object|null>} Snapshot object or null if none exists
 */
export async function loadLatestSnapshot(providerKey) {
    const snapshots = await listSnapshots(providerKey);
    if (snapshots.length === 0) return null;

    const latest = snapshots[snapshots.length - 1];
    const providerDir = _getProviderDir(providerKey);
    const filePath = path.join(providerDir, latest);

    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
}

/**
 * Load the previous snapshot (second-most recent) for a provider
 * @param {string} providerKey - Provider identifier
 * @returns {Promise<object|null>} Snapshot object or null if less than 2 exist
 */
export async function loadPreviousSnapshot(providerKey) {
    const snapshots = await listSnapshots(providerKey);
    if (snapshots.length < 2) return null;

    const previous = snapshots[snapshots.length - 2];
    const providerDir = _getProviderDir(providerKey);
    const filePath = path.join(providerDir, previous);

    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
}

/**
 * Load a specific snapshot by date
 * @param {string} providerKey - Provider identifier
 * @param {string} dateStr - Date string (YYYY-MM-DD)
 * @returns {Promise<object|null>} Snapshot object or null if not found
 */
export async function loadSnapshotByDate(providerKey, dateStr) {
    const providerDir = _getProviderDir(providerKey);
    const filename = `${dateStr}.json`;
    const filePath = path.join(providerDir, filename);

    try {
        const content = await fs.readFile(filePath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

/**
 * List all snapshot filenames for a provider (sorted chronologically)
 * @param {string} providerKey - Provider identifier
 * @returns {Promise<string[]>} Array of snapshot filenames
 */
export async function listSnapshots(providerKey) {
    const providerDir = _getProviderDir(providerKey);

    try {
        const files = await fs.readdir(providerDir);
        return files
            .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
            .sort(); // Lexicographic sort works for YYYY-MM-DD
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}
