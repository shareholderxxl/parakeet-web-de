// Tier-1 unit test for the Canary tokenizer/prompt (branch `canary-web`).
// Pure logic, no model, no DOM. Pins the onnx-asr-compatible behaviour:
// `▁` -> space, duplicate tokens resolve LAST-wins, the 10-token prompt order,
// and the `\A\s|\s\B|(\s)\b` space cleanup with `<|...|>` specials dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanaryTokenizer } from '../../src/tokenizer-canary.js';

const VOCAB = [
  '<unk> 0',
  '<|nospeech|> 1',
  '<pad> 2',
  '<|endoftext|> 3',
  '<|startoftranscript|> 4',
  '<|pnc|> 5',
  '<|nopnc|> 6',
  '<|startofcontext|> 7',
  '<|itn|> 8',
  '<|noitn|> 9',
  '<|timestamp|> 10',
  '<|notimestamp|> 11',
  '<|diarize|> 12',
  '<|nodiarize|> 13',
  '<|emo:undefined|> 16',
  '<|en|> 62',
  '<|de|> 76',
  '▁ 1151',     // first ▁ entry
  '▁Hal 100',
  'lo 101',
  '▁Welt 102',
  '! 103',
  '▁ 5072',     // duplicate ▁: LAST-wins -> token " " resolves here
].join('\n');

test('CanaryTokenizer: <|endoftext|> is the EOS id', () => {
  const t = new CanaryTokenizer(VOCAB);
  assert.equal(t.eosId, 3);
});

test('CanaryTokenizer: buildPrompt uses the onnx-asr token order (space via last ▁)', () => {
  const t = new CanaryTokenizer(VOCAB);
  assert.deepEqual(
    t.buildPrompt({ language: 'de', pnc: true }),
    [5072, 7, 4, 16, 76, 76, 5, 9, 11, 13],
  );
});

test('CanaryTokenizer: nopnc + target language override the slots', () => {
  const t = new CanaryTokenizer(VOCAB);
  const p = t.buildPrompt({ language: 'de', targetLanguage: 'en', pnc: false });
  assert.equal(p[4], 76); // source <|de|>
  assert.equal(p[5], 62); // target <|en|>
  assert.equal(p[6], 6);  // <|nopnc|>
});

test('CanaryTokenizer: decode drops specials, maps ▁ and cleans spacing', () => {
  const t = new CanaryTokenizer(VOCAB);
  assert.equal(t.decode([100, 101, 102, 103]), 'Hallo Welt!');
});

test('CanaryTokenizer: unknown tokens in the vocab throw (typos surface)', () => {
  const t = new CanaryTokenizer(VOCAB);
  assert.throws(() => t.id('<|xx|>'), /unknown token/);
});
