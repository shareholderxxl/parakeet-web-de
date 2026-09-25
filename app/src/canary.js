// Canary-180M attention-encoder-decoder runner (experiment branch `canary-web`).
//
// Full pipeline: 128-mel NeMo features (shared `JsPreprocessor`) -> FastConformer
// encoder (`encoder-model.int8.onnx`) -> autoregressive Transformer decoder
// (`decoder-model.int8.onnx`) with a decoder memory / KV cache, greedy argmax,
// stop at `<|endoftext|>`. Mirrors onnx-asr's `NemoConformerAED` contract:
//
//   encoder in  audio_signal [1,128,T] f32, length [1] i64
//   encoder out encoder_embeddings [1,Tenc,D] f32, encoder_mask [1,Tenc] i64
//   decoder in  input_ids [1,S] i64, encoder_embeddings, encoder_mask,
//               decoder_mems [L,1,cache_len,H] f32 (cache_len 0 on the first call)
//   decoder out logits [1,S,V] f32, decoder_hidden_states [L,1,S,H] f32
//
// The first decoder call feeds the whole 10-token prompt; every later call feeds
// only the last emitted token (the cache carries the rest).
//
// Written with the help of Claude Code.
import { initOrt } from './backend.js';
import { JsPreprocessor } from './mel.js';
import { CanaryTokenizer } from './tokenizer-canary.js';

const DEFAULT_MAX_TOKENS = 512;

export class CanaryModel {
  constructor({ ort, encoderSession, decoderSession, tokenizer, preprocessor, cpuThreads = 4, nMels = 128, backend = 'wasm' }) {
    this.ort = ort;
    this.encoderSession = encoderSession;
    this.decoderSession = decoderSession;
    this.tokenizer = tokenizer;
    this.preprocessor = preprocessor;
    this.cpuThreads = cpuThreads;
    this.nMels = nMels;
    this.backend = backend;
    this._memDims = null; // resolved lazily from the decoder input metadata
  }

  /**
   * @param {Object} cfg
   * @param {string} cfg.encoderUrl
   * @param {string} cfg.decoderUrl
   * @param {string|Uint8Array} cfg.vocabUrl  URL or raw bytes of vocab.txt
   * @param {number} [cfg.cpuThreads=4]
   * @param {number} [cfg.nMels=128]
   * @param {boolean} [cfg.verbose=false]
   * @returns {Promise<CanaryModel>}
   */
  static async fromUrls({ encoderUrl, decoderUrl, vocabUrl, cpuThreads = 4, nMels = 128, verbose = false }) {
    if (!encoderUrl || !decoderUrl || !vocabUrl) {
      throw new Error('CanaryModel.fromUrls requires encoderUrl, decoderUrl and vocabUrl');
    }
    const ort = await initOrt({ backend: 'wasm', numThreads: cpuThreads });
    const sessionOptions = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      executionMode: 'parallel',
      enableCpuMemArena: true,
      enableMemPattern: true,
      logSeverityLevel: verbose ? 0 : 2,
    };
    const [encoderSession, decoderSession, vocabText] = await Promise.all([
      ort.InferenceSession.create(encoderUrl, sessionOptions),
      ort.InferenceSession.create(decoderUrl, sessionOptions),
      typeof vocabUrl === 'string'
        ? fetch(vocabUrl).then((r) => { if (!r.ok) throw new Error(`vocab fetch ${r.status}`); return r.text(); })
        : Promise.resolve(new TextDecoder().decode(vocabUrl)),
    ]);
    const tokenizer = new CanaryTokenizer(vocabText);
    const preprocessor = new JsPreprocessor({ nMels });
    return new CanaryModel({ ort, encoderSession, decoderSession, tokenizer, preprocessor, cpuThreads, nMels, backend: 'wasm' });
  }

  /** Resolve [layers, 1, 0, hidden] for `decoder_mems` from session metadata. */
  _decoderMemDims() {
    if (this._memDims) return this._memDims;
    const meta = this.decoderSession.inputMetadata?.find?.((m) => m.name === 'decoder_mems');
    const shape = meta?.shape || [];
    const layers = Number(shape[0]);
    const hidden = Number(shape[3]);
    if (!Number.isFinite(layers) || !Number.isFinite(hidden)) {
      throw new Error(`CanaryModel: cannot resolve decoder_mems dims (got ${JSON.stringify(shape)})`);
    }
    this._memDims = [layers, 1, 0, hidden];
    return this._memDims;
  }

  /**
   * Preprocess + encode. Returns owned ORT tensors; caller must call
   * `disposeEncoded()`.
   * @param {Float32Array} audio 16 kHz mono
   */
  async encode(audio) {
    const ps = performance.now();
    const { features, length: T } = this.preprocessor.process(audio);
    const melBins = T > 0 ? features.length / T : this.nMels;
    const preprocess_ms = performance.now() - ps;

    const input = new this.ort.Tensor('float32', features, [1, melBins, T]);
    const lenTensor = new this.ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]);
    const es = performance.now();
    let out;
    try {
      out = await this.encoderSession.run({ audio_signal: input, length: lenTensor });
    } finally {
      input.dispose?.();
      lenTensor.dispose?.();
    }
    const encode_ms = performance.now() - es;
    const embeddings = out['encoder_embeddings'] ?? Object.values(out)[0];
    const mask = out['encoder_mask'] ?? null;
    return { embeddings, mask, T, melBins, preprocess_ms, encode_ms };
  }

  /** Dispose the tensors returned by encode(). */
  disposeEncoded({ embeddings, mask }) {
    embeddings?.dispose?.();
    mask?.dispose?.();
  }

  /**
   * Transcribe 16 kHz mono PCM.
   * @param {Float32Array} audio
   * @param {Object} [opts]
   * @param {string} [opts.language='de']
   * @param {string} [opts.targetLanguage]   Defaults to `language` (ASR mode).
   * @param {boolean} [opts.pnc=true]
   * @param {number} [opts.maxTokens=512]
   * @returns {Promise<{text:string, ids:number[], metrics:object}>}
   */
  async transcribe(audio, opts = {}) {
    const { language = 'de', targetLanguage = null, pnc = true, maxTokens = DEFAULT_MAX_TOKENS } = opts;
    const t0 = performance.now();
    const enc = await this.encode(audio);
    const { embeddings, mask, T, preprocess_ms, encode_ms } = enc;

    const prompt = this.tokenizer.buildPrompt({ language, targetLanguage, pnc });
    const memDims = this._decoderMemDims();
    let mems = new this.ort.Tensor('float32', new Float32Array(0), memDims);
    const emitted = [];
    let decode_ms = 0;
    const dstart = performance.now();
    try {
      for (let step = 0; step < maxTokens; step++) {
        // First call: the whole prompt. Later: only the last token (cache holds
        // the rest) — keyed on the cache length, exactly like onnx-asr.
        const cacheLen = mems.dims[2];
        const feedIds = cacheLen === 0 ? prompt : [emitted[emitted.length - 1]];
        const idsTensor = new this.ort.Tensor('int64', BigInt64Array.from(feedIds, (v) => BigInt(v)), [1, feedIds.length]);

        let out;
        try {
          out = await this.decoderSession.run({
            input_ids: idsTensor,
            encoder_embeddings: embeddings,
            encoder_mask: mask,
            decoder_mems: mems,
          });
        } finally {
          idsTensor.dispose?.();
        }

        const logits = out['logits'];
        const newMems = out['decoder_hidden_states'];
        const dims = logits.dims;
        const V = dims[dims.length - 1];
        const data = logits.data;
        const off = data.length - V;
        let best = 0, bestV = -Infinity;
        for (let i = 0; i < V; i++) {
          const v = data[off + i];
          if (v > bestV) { bestV = v; best = i; }
        }
        logits.dispose?.();
        // The previous mems were the input for this run — free them now.
        mems.dispose?.();
        mems = newMems;

        if (best === this.tokenizer.eosId) break;
        emitted.push(best);
      }
    } finally {
      decode_ms = performance.now() - dstart;
      mems?.dispose?.();
      this.disposeEncoded(enc);
    }

    const text = this.tokenizer.decode(emitted);
    const total_ms = performance.now() - t0;
    const audioSec = audio.length / 16000;
    return {
      text,
      ids: emitted,
      metrics: {
        audioSec: +audioSec.toFixed(2),
        preprocess_ms: +preprocess_ms.toFixed(1),
        encode_ms: +encode_ms.toFixed(1),
        decode_ms: +decode_ms.toFixed(1),
        tokenize_ms: 0,
        total_ms: +total_ms.toFixed(1),
        tokens: emitted.length,
        tokensPerSec: decode_ms > 0 ? +((emitted.length * 1000) / decode_ms).toFixed(1) : 0,
        procPerDur: audioSec > 0 ? +(total_ms / 1000 / audioSec).toFixed(2) : null,
        backend: 'wasm',
        model: 'canary-180m-flash',
      },
    };
  }

  release() {
    try { this.encoderSession?.release?.(); } catch { /* ignore */ }
    try { this.decoderSession?.release?.(); } catch { /* ignore */ }
    this.encoderSession = null;
    this.decoderSession = null;
  }
}
