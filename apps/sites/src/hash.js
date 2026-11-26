let impl;
try {
  const sha2 = await import('@noble/hashes/sha2.js');
  const legacy = await import('@noble/hashes/legacy.js');
  const utils = await import('@noble/hashes/utils.js');
  impl = {
    sha256Hex: bytes => utils.bytesToHex(sha2.sha256(bytes)),
    sha1Hex: bytes => utils.bytesToHex(legacy.sha1(bytes)),
    gitBlobSha: bytes => {
      const h = legacy.sha1.create();
      h.update(new TextEncoder().encode(`blob ${bytes.length}\0`));
      h.update(bytes);
      return utils.bytesToHex(h.digest());
    }
  };
} catch {
  const { createHash } = await import('node:crypto');
  impl = {
    sha256Hex: bytes => createHash('sha256').update(bytes).digest('hex'),
    sha1Hex: bytes => createHash('sha1').update(bytes).digest('hex'),
    gitBlobSha: bytes => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)])).digest('hex')
  };
}
export const { sha256Hex, sha1Hex, gitBlobSha } = impl;
