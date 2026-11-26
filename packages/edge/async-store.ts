/**
 * Worker/D1 存储接口：异步、局部查询、原子事务。
 * 不要求兼容同步全量 SnapshotRepo；生产实现保留在 apps/sites/storage-v2。
 */
export interface AsyncView<T = any> {
  document: T; version: number; epoch: string; migration: any;
  readMode?: 'state' | 'pendingHistory' | null;
}
export interface AsyncStorageAdapter<T = any> {
  open(owner: string, readMode?: 'state' | 'pendingHistory' | null): Promise<AsyncView<T> | null>;
  transact<R>(owner: string, action: (document: T, version: number, view: AsyncView<T>) => Promise<{ write: boolean; document?: T; value: R }> | { write: boolean; document?: T; value: R }, readMode?: 'state' | 'pendingHistory' | null): Promise<R>;
  stats(owner: string): Promise<any>;
  promote?(owner: string, input: any, prepare?: (document: T) => any, seed?: T): Promise<any>;
  compact?(owner: string, dryRun?: boolean): Promise<any>;
}
