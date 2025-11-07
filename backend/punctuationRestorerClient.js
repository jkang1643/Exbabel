import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PunctuationRestorer from 'punctuation-restore';
import { downloadModel } from 'punctuation-restore/modules/downloadModel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODEL_DIR = path.resolve(process.cwd(), 'node_modules/punctuation-restore/models');
const DEFAULT_MODEL_SUBDIR = path.join('1-800-BAD-CODE', 'punctuation_fullstop_truecase_english');

const MODEL_FILES = ['model.onnx', 'tokenizer.model'];

function resolveModelFilePath(fileName) {
  return path.join(MODEL_DIR, DEFAULT_MODEL_SUBDIR, fileName);
}

let restorerInstance = null;
let restorerInitPromise = null;

async function ensureModelDirectory() {
  await fs.promises.mkdir(path.join(MODEL_DIR, DEFAULT_MODEL_SUBDIR), { recursive: true }).catch(() => {});
}

async function fileExists(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

async function hasValidModelFiles() {
  for (const fileName of MODEL_FILES) {
    if (!(await fileExists(resolveModelFilePath(fileName)))) {
      return false;
    }
  }
  return true;
}

async function ensureModelFiles(force = false) {
  const valid = await hasValidModelFiles();
  if (force || !valid) {
    console.log('[PunctuationRestorer] ♻️ Fetching fresh punctuation model files (force=%s valid=%s)', force, valid);
    await fs.promises.rm(path.join(MODEL_DIR, DEFAULT_MODEL_SUBDIR), { recursive: true, force: true }).catch(() => {});
    await ensureModelDirectory();
    try {
      await downloadModel();
    } catch (error) {
      console.warn('[PunctuationRestorer] ⚠️ downloadModel helper threw error:', error?.message || error);
      throw error;
    }
    const nowValid = await hasValidModelFiles();
    if (nowValid) {
      console.log('[PunctuationRestorer] ✅ Model files ready');
    } else {
      console.warn('[PunctuationRestorer] ⚠️ Model files still missing after download');
    }
  } else {
    console.log('[PunctuationRestorer] ✅ Existing punctuation model files detected');
  }
}

function invalidateRestorer(reason) {
  if (reason) {
    console.warn(`[PunctuationRestorer] ♻️ Invalidating restorer: ${reason}`);
  }
  restorerInstance = null;
  restorerInitPromise = null;
}

async function clearModelCache(reason) {
  const label = reason || 'manual reset';
  console.warn(`[PunctuationRestorer] 🧹 Clearing cached model (${label}) at ${MODEL_DIR}`);
  invalidateRestorer();
  try {
    await fs.promises.rm(MODEL_DIR, { recursive: true, force: true });
    console.log('[PunctuationRestorer] 🗑️ Model cache removed');
  } catch (error) {
    console.warn('[PunctuationRestorer] ⚠️ Failed to remove cached model directory:', error?.message || error);
  }
  await ensureModelFiles(true);
}

function shouldResetForError(error) {
  const message = error?.message || '';
  return message.includes('Protobuf parsing failed') || message.includes('Failed to initialize ONNX model');
}

async function createRestorer(attempt = 1) {
  console.log('[PunctuationRestorer] 🔄 Creating new restorer instance... (attempt %d)', attempt);
  await ensureModelFiles(attempt > 1);
  try {
    const restorer = new PunctuationRestorer();
    console.log('[PunctuationRestorer] ✅ Restorer instance created');
    return restorer;
  } catch (error) {
    console.warn('[PunctuationRestorer] ⚠️ Restorer creation failed:', error?.message || error);
    if ((error?.code === 'ENOENT' || error?.message?.includes('Protobuf parsing failed')) && attempt < 3) {
      console.log('[PunctuationRestorer] 🔁 Retrying restorer creation after downloading files again...');
      await ensureModelFiles(true);
      return createRestorer(attempt + 1);
    }
    throw error;
  }
}

export function preloadPunctuationRestorer() {
  if (restorerInstance) {
    return Promise.resolve(restorerInstance);
  }

  if (!restorerInitPromise) {
    console.log('[PunctuationRestorer] ⏳ Preload requested...');
    restorerInitPromise = createRestorer()
      .then(instance => {
        restorerInstance = instance;
        console.log('[PunctuationRestorer] ✅ Preload complete');
        return restorerInstance;
      })
      .catch(async error => {
        console.warn('[PunctuationRestorer] ⚠️ Preload failed:', error?.message || error);
        if (shouldResetForError(error)) {
          await clearModelCache('preload failure');
        } else {
          invalidateRestorer('preload failure');
        }
        throw error;
      });
  }

  return restorerInitPromise;
}

export function getPunctuationRestorerStatus() {
  return {
    ready: !!restorerInstance,
    initializing: !!restorerInitPromise && !restorerInstance
  };
}

export async function restorePunctuationText(text, options = {}) {
  const {
    timeoutMs,
    fallback = text,
    logPrefix = '[PunctuationRestorer]'
  } = options;

  if (!text || text.trim().length === 0) {
    return text || '';
  }

  const restoreTask = preloadPunctuationRestorer()
    .then(async instance => {
      console.log(`${logPrefix} restore invoked (timeout=${timeoutMs || 'none'})`);
      const results = await instance.restore([text]);
      if (Array.isArray(results) && results.length > 0 && typeof results[0] === 'string') {
        console.log(`${logPrefix} restore succeeded → "${results[0]}"`);
        return results[0];
      }
      console.warn(`${logPrefix} restore returned unexpected result shape; falling back`);
      return fallback;
    })
    .catch(async error => {
      console.warn(`${logPrefix} restore failed:`, error?.message || error);
      if (shouldResetForError(error)) {
        await clearModelCache('protobuf failure');
      }
      return fallback;
    });

  if (!timeoutMs || typeof timeoutMs !== 'number' || timeoutMs <= 0) {
    return restoreTask;
  }

  let timedOut = false;

  const timeoutPromise = new Promise(resolve => {
    setTimeout(() => {
      timedOut = true;
      resolve(fallback);
    }, timeoutMs);
  });

  const result = await Promise.race([restoreTask, timeoutPromise]);

  if (timedOut) {
    restoreTask.catch(() => {});
  }

  return result;
}

export async function restoreMultipleTexts(texts, options = {}) {
  const {
    timeoutMs,
    fallback = [],
    logPrefix = '[PunctuationRestorer]'
  } = options;

  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const restoreTask = preloadPunctuationRestorer()
    .then(async instance => {
      console.log(`${logPrefix} batch restore invoked (timeout=${timeoutMs || 'none'}) count=${texts.length}`);
      const results = await instance.restore(texts);
      if (Array.isArray(results) && results.length === texts.length) {
        console.log(`${logPrefix} batch restore succeeded`);
        return results;
      }
      console.warn(`${logPrefix} batch restore returned unexpected result shape; falling back`);
      return fallback.length === texts.length ? fallback : texts;
    })
    .catch(async error => {
      console.warn(`${logPrefix} batch restore failed:`, error?.message || error);
      if (shouldResetForError(error)) {
        await clearModelCache('protobuf failure (batch)');
      }
      return fallback.length === texts.length ? fallback : texts;
    });

  if (!timeoutMs || typeof timeoutMs !== 'number' || timeoutMs <= 0) {
    return restoreTask;
  }

  let timedOut = false;

  const timeoutPromise = new Promise(resolve => {
    setTimeout(() => {
      timedOut = true;
      resolve(fallback.length === texts.length ? fallback : texts);
    }, timeoutMs);
  });

  const result = await Promise.race([restoreTask, timeoutPromise]);

  if (timedOut) {
    restoreTask.catch(() => {});
  }

  return result;
}

export async function disposePunctuationRestorer() {
  if (restorerInstance && typeof restorerInstance.cleanup === 'function') {
    try {
      await restorerInstance.cleanup();
    } catch (error) {
      console.warn('[PunctuationRestorer] cleanup failed:', error?.message || error);
    }
  }
  invalidateRestorer('dispose');
}
