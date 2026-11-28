/**
 * 有界内存归档流：按 D1 物理记录逐段序列化，分片写入 noa_v3_archive_chunk，
 * 同时增量计算完整归档 SHA-256。不构造完整 document。
 */
const CHUNK = 48000;
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
class Sha256Stream {
  constructor() { this.h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]; this.buf = new Uint8Array(0); this.total = 0; }
  update(bytes) { this.total += bytes.length; const j = new Uint8Array(this.buf.length + bytes.length); j.set(this.buf); j.set(bytes, this.buf.length); let o = 0; while (j.length - o >= 64) { this.block(j.subarray(o, o + 64)); o += 64; } this.buf = j.subarray(o); }
  block(blk) { const w = new Uint32Array(64); for (let i = 0; i < 16; i++) w[i] = (blk[i*4]<<24)|(blk[i*4+1]<<16)|(blk[i*4+2]<<8)|blk[i*4+3]; for (let i=16;i<64;i++){const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);const s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)|0;} let [a,b,c,d,e,f,g,h]=this.h; for(let i=0;i<64;i++){const S1=rotr(e,6)^rotr(e,11)^rotr(e,25);const ch=(e&f)^(~e&g);const t1=(h+S1+ch+K[i]+w[i])|0;const S0=rotr(a,2)^rotr(a,13)^rotr(a,22);const maj=(a&b)^(a&c)^(b&c);const t2=(S0+maj)|0;h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;} this.h=[(this.h[0]+a)|0,(this.h[1]+b)|0,(this.h[2]+c)|0,(this.h[3]+d)|0,(this.h[4]+e)|0,(this.h[5]+f)|0,(this.h[6]+g)|0,(this.h[7]+h)|0]; }
  digest(){const bit=BigInt(this.total)*8n;const pad=new Uint8Array((this.buf.length<56?56:120)-this.buf.length);pad[0]=0x80;const m=new Uint8Array(this.buf.length+pad.length+8);m.set(this.buf);m.set(pad,this.buf.length);for(let i=0;i<8;i++)m[m.length-1-i]=Number((bit>>BigInt(i*8))&0xffn);let o=0;while(o<m.length){this.block(m.subarray(o,o+64));o+=64;}return this.h.map(x=>(x>>>0).toString(16).padStart(8,'0')).join('');}
}
export const sha256StreamHex = text => { const s = new Sha256Stream(); s.update(new TextEncoder().encode(text)); return s.digest(); };

export function makeArchiveWriter(db, q, hashText, owner, archiveId) {
  const writer = { ordinal: 0, bytes: 0, buf: new Uint8Array(0), hash: new Sha256Stream(), pending: [], stats: { counts: {}, ids: {} }, mark(category, id) { this.stats.counts[category] = (this.stats.counts[category] ?? 0) + 1; (this.stats.ids[category] ??= []).push(String(id)); }, async emit(part) { const b64 = btoa(String.fromCharCode(...part)); writer.pending.push(q(db, 'INSERT OR REPLACE INTO noa_v3_archive_chunk VALUES (?,?,?,?,?)', owner, archiveId, writer.ordinal++, b64, hashText(b64))); if (writer.pending.length >= 16) await db.batch(writer.pending.splice(0)); }, async push(text) { const bytes = new TextEncoder().encode(text); writer.hash.update(bytes); writer.bytes += bytes.length; const joined = new Uint8Array(writer.buf.length + bytes.length); joined.set(writer.buf); joined.set(bytes, writer.buf.length); writer.buf = joined; while (writer.buf.length >= CHUNK) { const part = writer.buf.subarray(0, CHUNK); writer.buf = writer.buf.subarray(CHUNK); await writer.emit(part); } }, async close() { if (writer.buf.length) await writer.emit(writer.buf); if (writer.pending.length) await db.batch(writer.pending.splice(0)); writer.buf = new Uint8Array(0); return { sha256: writer.hash.digest(), bytes: writer.bytes, chunks: writer.ordinal, stats: writer.stats }; } };
  return writer;
}

export async function writeJson(writer, value) {
  if (Array.isArray(value)) { await writer.push('['); for (let i = 0; i < value.length; i++) { if (i) await writer.push(','); await writeJson(writer, value[i]); } await writer.push(']'); return; }
  if (value && typeof value === 'object') { await writer.push('{'); const keys = Object.keys(value).sort(); for (let i = 0; i < keys.length; i++) { if (i) await writer.push(','); await writer.push(JSON.stringify(keys[i]) + ':'); await writeJson(writer, value[keys[i]]); } await writer.push('}'); return; }
  await writer.push(JSON.stringify(value));
}

export async function writeArchiveDocument(writer, deps) {
  const { db, q, owner, readDoc, decode, readCheckpointDelta, stateFromComponents, wfamily } = deps;
  const active = await readDoc(db, owner, 'active');
  const revisions = await q(db, 'SELECT campaign_id,worldline_id FROM noa_v3_revision WHERE owner_id=? ORDER BY campaign_id,worldline_id', owner).all();
  const campaigns = new Map();
  for (const row of revisions.results) { if (!campaigns.has(row.campaign_id)) campaigns.set(row.campaign_id, []); campaigns.get(row.campaign_id).push(row.worldline_id); writer.mark('campaigns', row.campaign_id); writer.mark('worldlines', `${row.campaign_id}/${row.worldline_id}`); }
  const persona = await readDoc(db, owner, 'persona');
  const pRows = await q(db, "SELECT family,body FROM noa_v3_doc WHERE owner_id=? AND family LIKE 'persona:%'", owner).all();
  const campaignPersonas = {}; for (const row of pRows.results) campaignPersonas[row.family.slice(8)] = decode(row.body);
  const cpRows = await q(db, `SELECT c.id,c.delta,c.digest,m.campaign_id,m.worldline_id,m.label,m.created_at,m.source,m.source_version,m.format,m.revision,m.parent_id FROM noa_v3_checkpoint c LEFT JOIN noa_v3_checkpoint_meta m ON m.owner_id=c.owner_id AND m.id=c.id WHERE c.owner_id=?`, owner).all();
  const checkpoints = {};
  for (const row of cpRows.results) { const delta = await readCheckpointDelta(db, owner, row); const cid = row.campaign_id ?? active?.campaignId; checkpoints[`${cid}:${row.id}`] = { id: row.id, campaignId: cid, worldlineId: row.worldline_id ?? null, label: row.label ?? null, createdAt: row.created_at ?? null, source: row.source ?? null, version: row.source_version ?? null, format: row.format ?? null, revision: row.revision ?? null, parentId: row.parent_id ?? null, snapshot: delta }; writer.mark('checkpoints', `${cid}:${row.id}`); }
  const keys = ['active','campaignPersonas','campaigns','checkpoints','events','format','operations','persona','receipts'];
  await writer.push('{');
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]; if (i) await writer.push(','); await writer.push(JSON.stringify(key) + ':');
    if (key === 'active') await writeJson(writer, active);
    else if (key === 'persona') await writeJson(writer, persona);
    else if (key === 'campaignPersonas') await writeJson(writer, campaignPersonas);
    else if (key === 'checkpoints') await writeJson(writer, checkpoints);
    else if (key === 'format') await writer.push('"noa-sites-v1"');
    else if (key === 'operations') await writer.push('{}');
    else if (key === 'events') { const rows = await q(db, 'SELECT body FROM noa_v3_event WHERE owner_id=? ORDER BY campaign_id,worldline_id,seq', owner).all(); await writer.push('['); for (let j = 0; j < rows.results.length; j++) { if (j) await writer.push(','); const event = decode(rows.results[j].body); writer.mark('events', event.id ?? event.eventId); await writeJson(writer, event); } await writer.push(']'); }
    else if (key === 'receipts') { const rows = await q(db, 'SELECT body FROM noa_v3_tx WHERE owner_id=? ORDER BY rowid', owner).all(); const map = {}; for (const row of rows.results) { const stored = decode(row.body); if (stored.receipt) { const r = stored.receipt; const key = `${r.campaignId}:${r.worldlineId}:${r.idempotencyKey}`; map[key] = stored; writer.mark('receipts', key); } } await writeJson(writer, map); }
    else if (key === 'campaigns') {
      await writer.push('{'); const ckeys = [...campaigns.keys()].sort();
      for (let ci = 0; ci < ckeys.length; ci++) {
        if (ci) await writer.push(','); const cid = ckeys[ci]; const worldlines = campaigns.get(cid).sort();
        await writer.push(JSON.stringify(cid) + ':{"lines":{');
        for (let wi = 0; wi < worldlines.length; wi++) {
          if (wi) await writer.push(','); const wid = worldlines[wi]; await writer.push(JSON.stringify(wid) + ':{');
          const state = await stateFromComponents(db, owner, { campaignId: cid, worldlineId: wid });
          const working = await readDoc(db, owner, wfamily('working', cid, wid));
          const manifest = await readDoc(db, owner, wfamily('manifest', cid, wid));
          const rowsOf = async kind => { const rows = await q(db, `SELECT d.body FROM noa_v3_doc d LEFT JOIN noa_v3_memory_order o ON o.owner_id=d.owner_id AND o.campaign_id=? AND o.worldline_id=? AND o.kind=? AND o.memory_id=d.slot WHERE d.owner_id=? AND d.family=? ORDER BY o.seq`, cid, wid, kind, owner, wfamily(kind, cid, wid)).all(); const values = rows.results.map(r => decode(r.body)); for (const value of values) writer.mark(kind === 'entity' ? 'entities' : kind === 'relation' ? 'relations' : 'episodes', value.id); return values; };
          await writer.push('"entities":'); await writeJson(writer, await rowsOf('entity'));
          await writer.push(',"episodes":'); await writeJson(writer, await rowsOf('episode'));
          await writer.push(',"manifest":'); await writeJson(writer, manifest);
          await writer.push(',"relations":'); await writeJson(writer, await rowsOf('relation'));
          await writer.push(',"state":'); await writeJson(writer, state);
          await writer.push(',"working":'); await writeJson(writer, working);
          await writer.push('}');
        }
        await writer.push('},"manifest":'); await writeJson(writer, await readDoc(db, owner, wfamily('manifest', cid, worldlines[0] ?? 'wl-main')));
        await writer.push('}');
      }
      await writer.push('}');
    }
  }
  await writer.push('}');
}
