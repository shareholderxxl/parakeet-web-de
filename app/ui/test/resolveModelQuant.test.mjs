import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelQuant } from '../../src/hub.js';

const INT4 = 'encoder-model.int4.onnx';
const SHARDS = ['encoder-model.onnx.data.000', 'encoder-model.onnx.data.001'];

test('WASM + int4 verfügbar -> int4/int8 (Default)', () => {
  const r = resolveModelQuant({ backend: 'wasm', encoderQuant: 'int4', decoderQuant: 'int8', repoFiles: [INT4] });
  assert.equal(r.encoderQ, 'int4');
  assert.equal(r.decoderQ, 'int8');
  assert.equal(r.pinnedToInt8, false);
});

test('WASM + int4 fehlt -> int8/int8', () => {
  const r = resolveModelQuant({ backend: 'wasm', encoderQuant: 'int4', decoderQuant: 'int8', repoFiles: [] });
  assert.equal(r.encoderQ, 'int8');
  assert.equal(r.pinnedToInt8, false);
});

test('WebGPU + int4 verfügbar -> int4/int8, keine Shard-Pflicht', () => {
  const r = resolveModelQuant({ backend: 'webgpu-hybrid', encoderQuant: 'int4', decoderQuant: 'int8', repoFiles: [INT4] });
  assert.equal(r.encoderQ, 'int4');
  assert.equal(r.decoderQ, 'int8');
  assert.equal(r.pinnedToInt8, false);
  assert.equal(r.webgpuFp32NeedsShards, false);
});

test('WebGPU + int4 fehlt -> fp32-Fallback (Shards nötig)', () => {
  const r = resolveModelQuant({ backend: 'webgpu-hybrid', encoderQuant: 'int4', decoderQuant: 'int8', repoFiles: [] });
  assert.equal(r.encoderQ, 'fp32');
  assert.equal(r.webgpuFp32NeedsShards, true);
});

test('WebGPU + int8-Request -> fp32 (unverändert)', () => {
  const r = resolveModelQuant({ backend: 'webgpu', encoderQuant: 'int8', decoderQuant: 'int8', repoFiles: [INT4] });
  assert.equal(r.encoderQ, 'fp32');
  assert.equal(r.webgpuFp32NeedsShards, true);
});

test('WebGPU + fp32 mit Shards -> fp32 nutzbar', () => {
  const r = resolveModelQuant({ backend: 'webgpu', encoderQuant: 'fp32', decoderQuant: 'int8', repoFiles: SHARDS });
  assert.equal(r.encoderQ, 'fp32');
  assert.equal(r.webgpuFp32NeedsShards, false);
});
