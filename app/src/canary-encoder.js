// Canary-180M encoder runner (experiment branch `canary-web`).
//
// NVIDIA Canary is an ATTENTION-ENCODER-DECODER model (NeMo `nemo-conformer-aed`),
// unlike Parakeet's TDT encoder+joiner. This module covers ONLY the encoder half
// (M0 of the plan): 128-mel NeMo features -> FastConformer encoder ->
// `encoder_embeddings` + `encoder_mask`, which the AED decoder consumes later.
//
// The feature pipeline is the SAME NeMo log-mel the Parakeet engine already uses
// (16 kHz, n_fft 512, win 400, hop 160, preemph 0.97, slaney mel, log(+2^-24),
// per-feature mean/var normalization), so `JsPreprocessor` is reused verbatim.
//
// ONNX interface (istupakov/canary-180m-flash-onnx, verified against onnx-asr
// `models/nemo.py` NemoConformerAED):
//   in  audio_signal : float32 [1, 128, T]   (normalized log-mel)
//       length       : int64   [1]           (mel frames)
//   out encoder_embeddings : float32 [1, Tenc, D]
//       encoder_mask       : int64   [1, Tenc]
//
// Written with the help of Claude Code.
import { initOrt } from './backend.js';
import { JsPreprocessor } from './mel.js';

export class CanaryEncoder {
  /**
   * @param {Object} args
   * @param {object} args.ort            ORT module (from initOrt).
   * @param {object} args.session        ORT InferenceSession for the encoder.
   * @param {JsPreprocessor} args.preprocessor
   * @param {number} [args.cpuThreads]
   * @param {number} [args.nMels=128]
   * @param {number} [args.subsampling=8]
   */
  constructor({ ort, session, preprocessor, cpuThreads = 4, nMels = 128, subsampling = 8, backend = 'wasm' }) {
    this.ort = ort;
    this.session = session;
    this.preprocessor = preprocessor;
    this.cpuThreads = cpuThreads;
    this.nMels = nMels;
    this.subsampling = subsampling;
    this.backend = backend;
  }

  /**
   * Load the Canary encoder from a URL (LAN mirror `/models-canary/...` or HF).
   * @param {Object} cfg
   * @param {string} cfg.encoderUrl
   * @param {('wasm')} [cfg.backend='wasm']  (Canary has no int4/WebGPU path yet)
   * @param {number} [cfg.cpuThreads=4]
   * @param {number} [cfg.nMels=128]
   * @param {string} [cfg.wasmPaths]
   * @param {boolean} [cfg.verbose=false]
   * @returns {Promise<CanaryEncoder>}
   */
  static async fromUrls({ encoderUrl, backend = 'wasm', cpuThreads = 4, nMels = 128, wasmPaths, verbose = false }) {
    if (!encoderUrl) throw new Error('CanaryEncoder.fromUrls requires encoderUrl');
    const ort = await initOrt({ backend: 'wasm', wasmPaths, numThreads: cpuThreads });
    const sessionOptions = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      executionMode: 'parallel',
      enableCpuMemArena: true,
      enableMemPattern: true,
      logSeverityLevel: verbose ? 0 : 2,
    };
    const session = await ort.InferenceSession.create(encoderUrl, sessionOptions);
    const preprocessor = new JsPreprocessor({ nMels });
    return new CanaryEncoder({ ort, session, preprocessor, cpuThreads, nMels, backend });
  }

  /**
   * PCM (16 kHz mono) -> normalized log-mel features. Timing in ms.
   * @param {Float32Array} audio
   * @returns {{features: Float32Array, T: number, melBins: number, preprocess_ms: number}}
   */
  preprocess(audio) {
    const s = performance.now();
    const { features, length: T } = this.preprocessor.process(audio);
    const melBins = T > 0 ? features.length / T : this.nMels;
    return { features, T, melBins, preprocess_ms: performance.now() - s };
  }

  /**
   * Run the encoder over precomputed features. Returns the ORT output tensors;
   * the CALLER owns them and must dispose (`disposeRaw(outs)`).
   * @param {Float32Array} features
   * @param {number} melBins
   * @param {number} T
   * @returns {Promise<{embeddings: object, mask: object|null, encode_ms: number}>}
   */
  async runEncoder(features, melBins, T) {
    const input = new this.ort.Tensor('float32', features, [1, melBins, T]);
    const lenTensor = new this.ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]);
    const s = performance.now();
    const out = await this.session.run({ audio_signal: input, length: lenTensor });
    const encode_ms = performance.now() - s;
    input.dispose?.();
    lenTensor.dispose?.();
    return {
      embeddings: out['encoder_embeddings'] ?? Object.values(out)[0],
      mask: out['encoder_mask'] ?? null,
      encode_ms,
    };
  }

  /** Dispose the tensors returned by runEncoder(). */
  disposeRaw({ embeddings, mask }) {
    embeddings?.dispose?.();
    mask?.dispose?.();
  }

  /**
   * Encoder-only measurement/inspection (M0): preprocess + encode, then report
   * shape and a non-finite sanity count. Tensors are disposed before returning.
   * @param {Float32Array} audio
   * @returns {Promise<{preprocess_ms:number, encode_ms:number, total_ms:number, melFrames:number, shape:number[], nanCount:number, maskShape:number[]|null}>}
   */
  async encode(audio) {
    const { features, T, melBins, preprocess_ms } = this.preprocess(audio);
    let raw = null;
    try {
      raw = await this.runEncoder(features, melBins, T);
      const dims = raw.embeddings?.dims ?? [];
      const data = raw.embeddings?.data;
      let nanCount = 0;
      if (data) {
        for (let i = 0; i < data.length; i++) {
          if (!Number.isFinite(data[i])) { nanCount++; if (nanCount > 1000) break; }
        }
      }
      return {
        preprocess_ms: +preprocess_ms.toFixed(1),
        encode_ms: +raw.encode_ms.toFixed(1),
        total_ms: +(preprocess_ms + raw.encode_ms).toFixed(1),
        melFrames: T,
        shape: [...dims],
        maskShape: raw.mask ? [...raw.mask.dims] : null,
        nanCount,
      };
    } finally {
      if (raw) this.disposeRaw(raw);
    }
  }

  /** Release the ORT session. */
  release() {
    try { this.session?.release?.(); } catch { /* ignore */ }
    this.session = null;
  }
}
