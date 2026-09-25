// Forked from ysdede/parakeet.js (MIT). See SOURCE.md and LICENSE.upstream.

import { ParakeetModel } from './parakeet.js';
import { getParakeetModel } from './hub.js';

export { ParakeetModel } from './parakeet.js';
export { CanaryEncoder } from './canary-encoder.js'; // canary-web experiment
export { CanaryModel } from './canary.js'; // canary-web experiment
export { CanaryTokenizer } from './tokenizer-canary.js'; // canary-web experiment
export { defaultWasmThreads } from './backend.js';
export { getModelFile, getModelText, getParakeetModel, getLocalModelFile, checkLocalModelFiles, resolveLocalModelBase, listLocalRepoFiles, resolveModelQuant, quantSatisfiable, HubDownloadError, QuantUnavailableError, shouldRetryLocally, evictModelFiles, isModelDeserializeError, modelFileCacheKeys } from './hub.js';

/**
 * Convenience factory to load from a local path.
 *
 * Example:
 * import { fromUrls } from 'parakeet.js';
 * const model = await fromUrls({ ... });
 */
export async function fromUrls(cfg) {
  return ParakeetModel.fromUrls(cfg);
}

/**
 * Convenience factory to load from HuggingFace Hub.
 *
 * Example:
 * import { fromHub } from 'parakeet.js';
 * const model = await fromHub('nvidia/parakeet-tdt-1.1b', { quantization: 'int8' });
 */
export async function fromHub(repoId, options = {}) {
  const result = await getParakeetModel(repoId, options);
  return ParakeetModel.fromUrls({ ...result.urls, filenames: result.filenames, ...options });
}
