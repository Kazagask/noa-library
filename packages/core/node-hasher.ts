import { createHash } from 'node:crypto';
import { setSharedHasher } from './shared.ts';

let initialized = false;
export function initializeNodeHasher(): void {
  if (initialized) return;
  setSharedHasher(value => createHash('sha256').update(value).digest('hex'));
  initialized = true;
}
initializeNodeHasher();
