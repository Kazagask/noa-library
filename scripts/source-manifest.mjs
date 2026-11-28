#!/usr/bin/env node
/**
 * 确定性源码清单生成器（Sites / W 共用）。
 * 范围：apps/sites/src、apps/sites/test、packages/{core,edge,akasha,library,server}、tests、scripts。
 * 路径排序：UTF-8 字节序，使用 '/' 分隔，不含 './'。
 * 编码：UTF-8；换行：读取后统一 CRLF/CR -> LF；文件哈希：SHA-256(规范化内容字节)。
 * 根哈希：对排序后的 "path\0fileSha256\0bytes\n" 连接串取 SHA-256。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(process.argv.find(a => a.startsWith('--root='))?.slice(7) ?? process.cwd());
const outArg = process.argv.find(a => a.startsWith('--out='))?.slice(6);
const scope = ['apps/sites/src', 'apps/sites/test', 'packages/core', 'packages/edge', 'packages/akasha', 'packages/library', 'packages/server', 'packages/local', 'tests', 'scripts'];
const files = [];
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) files.push(relative(root, full).replaceAll('\\', '/'));
  }
};
for (const dir of scope) walk(join(root, dir));
files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
const manifest = files.map(path => {
  const raw = readFileSync(join(root, path));
  const normalized = Buffer.from(raw.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
  return { path, sha256: createHash('sha256').update(normalized).digest('hex'), bytes: normalized.length };
});
const rootInput = manifest.map(f => `${f.path}\0${f.sha256}\0${f.bytes}\n`).join('');
const rootSha256 = createHash('sha256').update(rootInput, 'utf8').digest('hex');
const report = {
  algorithm: 'sha256',
  scope,
  pathOrder: 'utf8-bytewise',
  pathSeparator: '/',
  encoding: 'utf-8',
  newline: 'LF',
  fileHash: 'sha256(normalized-content-bytes)',
  rootHash: 'sha256(concat(path + "\\0" + fileSha256 + "\\0" + bytes + "\\n" in sorted order))',
  rootSha256,
  files: manifest
};
const text = JSON.stringify(report, null, 2) + '\n';
if (outArg) writeFileSync(resolve(root, outArg), text, 'utf8');
console.log(JSON.stringify({ rootSha256, files: manifest.length }));
