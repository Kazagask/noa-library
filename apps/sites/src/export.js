import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ok, fail } from './upstream/util.ts';

export function exportPage(document,page) {
  const data=new TextEncoder().encode(JSON.stringify(document));
  const digest=bytes=>bytesToHex(sha256(bytes));
  const pageBytes=12000;
  const pages=Math.ceil(data.length/pageBytes);
  const header={format:document.format, ...(document.manifest?{schemaVersion:2,manifest:document.manifest}:{}),sha256:digest(data),bytes:data.length,pages,pageBytes};
  if (page===undefined) return {value:ok(header)};
  if (!Number.isInteger(page)||page<0||page>=pages) return {value:fail('invalid_cursor','导出页码越界')};
  const bytes=data.subarray(page*pageBytes,(page+1)*pageBytes);
  return {value:ok({...header,page,pageHash:digest(bytes),base64:btoa(String.fromCharCode(...bytes))})};
}
