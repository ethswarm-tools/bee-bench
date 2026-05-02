// Worker thread for cpu.keccak.parallel.
//
// Each worker is told `{ chunkBytes, count }` and:
//   1. Generates a random `8 + chunkBytes`-byte payload locally.
//   2. Hashes it via calculateChunkAddress count times.
//   3. Posts 'done' back.
//
// Self-generated payloads avoid postMessage serialization cost so the
// measurement isolates the keccak compute path.

import { parentPort } from 'node:worker_threads';
import { calculateChunkAddress } from '../../bee-js/dist/mjs/chunk/bmt.js';

parentPort.on('message', (msg) => {
  const { chunkBytes, count } = msg;
  const buf = new Uint8Array(8 + chunkBytes);
  new DataView(buf.buffer).setBigUint64(0, BigInt(chunkBytes), true);
  for (let j = 8; j < buf.length; j++) buf[j] = (Math.random() * 256) | 0;
  for (let i = 0; i < count; i++) calculateChunkAddress(buf);
  parentPort.postMessage('done');
});
