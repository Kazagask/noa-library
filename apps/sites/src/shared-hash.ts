import { setSharedHasher } from '../../../packages/core/shared.ts';

// 生产 Worker 使用 @noble；隔离 Node 测试可在未安装依赖时回退到 node:crypto。
let digest: (value: string) => string;
try {
  const nobleHash = await import('@noble/hashes/sha2.js');
  const nobleUtils = await import('@noble/hashes/utils.js');
  digest = value => nobleUtils.bytesToHex(nobleHash.sha256(new TextEncoder().encode(value)));
} catch {
  const nodeCrypto = await import('node:crypto');
  digest = value => nodeCrypto.createHash('sha256').update(value).digest('hex');
}
setSharedHasher(digest);
