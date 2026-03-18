// Shim for Node createHash('sha256') used by arbundles in the browser.
// esm.sh's node/crypto polyfill does not implement createHash; this provides it.

import { sha256 } from 'https://esm.sh/@noble/hashes@1.3.3/sha256.js';

function createHash(algorithm) {
  if (algorithm !== 'sha256') {
    throw new Error(`createHash: ${algorithm} is not supported`);
  }
  let chunks = [];

  return {
    update(data) {
      chunks.push(data instanceof Uint8Array ? data : new Uint8Array(data));
      return this;
    },
    digest() {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      return new Uint8Array(sha256(out));
    },
  };
}

export { createHash };
export default { createHash };
