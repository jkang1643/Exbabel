/**
 * Grammar Correction Status Endpoint
 * Provides status information about the grammar correction service
 */

import { getGrammarCorrectorModel } from './grammarCorrectorModel.js';

/**
 * Get grammar correction status
 * Can be called via HTTP endpoint or directly
 */
export function getGrammarStatus() {
  const corrector = getGrammarCorrectorModel();
  const status = corrector.getStatus();
  
  const statusMessages = {
    'not_initialized': 'Not started',
    'downloading': 'Downloading model files...',
    'loading': 'Loading model into memory...',
    'ready': 'Ready and working',
    'failed': 'Failed to load'
  };
  
  return {
    enabled: corrector.enabled,
    status: status.status,
    statusMessage: statusMessages[status.status] || status.status,
    modelName: status.modelName,
    useAPI: status.useAPI,
    pipelineLoaded: status.pipeline,
    initializing: status.initializing,
    elapsedSeconds: status.elapsed ? Math.floor(status.elapsed / 1000) : null,
    estimatedTimeRemaining: status.status === 'downloading' && status.elapsed ? '~60-120s' : 
                           status.status === 'loading' && status.elapsed ? '~10-30s' : null
  };
}

