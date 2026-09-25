// Canary tokenizer (experiment branch `canary-web`).
//
// Mirrors onnx-asr's handling of the NeMo Canary `vocab.txt` EXACTLY:
//   - file format is `<token> <id>` per line,
//   - `_vocab` maps id -> token with the SentencePiece marker `▁` (U+2581)
//     already replaced by a space,
//   - `_tokens` maps token -> id; duplicate tokens (the vocab carries several
//     `▁` entries) resolve LAST-wins, which is what onnx-asr's dict
//     comprehension does — the prompt's leading `" "` token therefore uses the
//     highest `▁` id.
//   - decoding drops every `<|...|>` special, then joins and applies the
//     Whisper-style space cleanup `\A\s|\s\B|(\s)\b`.
//
// Written with the help of Claude Code.
const SP_SPACE = '\u2581'; // ▁

/** Parse a Canary `vocab.txt` into id<->token maps. */
export function parseCanaryVocab(text) {
  const id2token = [];        // raw tokens (with ▁)
  const id2tokSanitized = []; // ▁ replaced by space (onnx-asr `_vocab`)
  const tok2id = new Map();   // sanitized token -> id (last wins)
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const tok = line.slice(0, sp);
    const id = Number(line.slice(sp + 1));
    if (!Number.isInteger(id)) continue;
    id2token[id] = tok;
    const san = tok.split(SP_SPACE).join(' ');
    id2tokSanitized[id] = san;
    tok2id.set(san, id);
  }
  return { id2token, id2tokSanitized, tok2id };
}

export class CanaryTokenizer {
  /**
   * @param {string} vocabText raw contents of `vocab.txt`.
   */
  constructor(vocabText) {
    const { id2token, id2tokSanitized, tok2id } = parseCanaryVocab(vocabText);
    this.id2token = id2token;
    this.id2tokSanitized = id2tokSanitized;
    this.tok2id = tok2id;
    this.eosId = tok2id.get('<|endoftext|>');
    if (this.eosId === undefined) throw new Error('CanaryTokenizer: vocab is missing <|endoftext|>');
  }

  /** Resolve a token string to its id (throws when absent, so typos surface). */
  id(token) {
    const v = this.tok2id.get(token);
    if (v === undefined) throw new Error(`CanaryTokenizer: unknown token "${token}"`);
    return v;
  }

  /**
   * Build the 10-token Canary prompt (same order as onnx-asr NemoConformerAED):
   * `" "`, startofcontext, startoftranscript, emo:undefined, <src>, <tgt>,
   * pnc|nopnc, noitn, notimestamp, nodiarize.
   * @param {Object} [opts]
   * @param {string} [opts.language='de']       Source language code (en/de/es/fr).
   * @param {string} [opts.targetLanguage]      Defaults to `language` (ASR).
   * @param {boolean} [opts.pnc=true]           Punctuation + capitalization.
   * @returns {number[]}
   */
  buildPrompt({ language = 'de', targetLanguage = null, pnc = true } = {}) {
    const tgt = targetLanguage || language;
    return [
      this.id(' '),
      this.id('<|startofcontext|>'),
      this.id('<|startoftranscript|>'),
      this.id('<|emo:undefined|>'),
      this.id(`<|${language}|>`),
      this.id(`<|${tgt}|>`),
      this.id(pnc ? '<|pnc|>' : '<|nopnc|>'),
      this.id('<|noitn|>'),
      this.id('<|notimestamp|>'),
      this.id('<|nodiarize|>'),
    ];
  }

  /**
   * Tokens -> text: drop `<|...|>` specials, map through the sanitized id→token
   * table, join, then apply onnx-asr's space cleanup.
   * @param {number[]} ids
   * @returns {string}
   */
  decode(ids) {
    const parts = [];
    for (const id of ids) {
      const raw = this.id2token[id];
      if (raw === undefined) continue;
      if (raw.startsWith('<|')) continue;
      const san = this.id2tokSanitized[id];
      if (san === undefined) continue;
      parts.push(san);
    }
    return parts.join('').replace(/^\s|\s\B|(\s)\b/g, (_m, g1) => (g1 ? ' ' : ''));
  }
}
