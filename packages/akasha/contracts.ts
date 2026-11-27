/**
 * PROJECT AKASHA 可编程运行时契约（只定义，不实现规则 VM）。
 * 规则函数不得直接访问数据库，只能通过 ExecutionContext 提供的受控接口声明读取范围与 Effect。
 */
export interface EntityRef {
  ownerId: string; campaignId: string; worldlineId: string; entityId: string;
}
export interface ComponentRef extends EntityRef {
  componentType: string; key?: string;
}
export interface CollectionRef extends EntityRef {
  collectionId: string; itemKey?: string;
}

export interface StateReader {
  readComponent(ref: ComponentRef): Promise<unknown | null>;
  readComponents(scope: Omit<EntityRef, 'entityId'>, selector: Partial<Pick<ComponentRef, 'entityId' | 'componentType' | 'key'>>, limit?: number): Promise<ComponentRef[]>;
  readCollection(scope: Omit<EntityRef, 'entityId'>, ref: Pick<CollectionRef, 'collectionId'>, cursor?: string, limit?: number): Promise<Array<{ key: string; value: unknown }>>;
}

export type Effect =
  | { op: 'upsertComponent'; ref: ComponentRef; value: unknown; meta?: Record<string, unknown> }
  | { op: 'deleteComponent'; ref: ComponentRef }
  | { op: 'upsertCollectionItem'; ref: CollectionRef; value: unknown }
  | { op: 'deleteCollectionItem'; ref: CollectionRef }
  | { op: 'index'; scope: Omit<EntityRef, 'entityId'>; indexName: string; indexKey: string; ref: ComponentRef };

export interface TransactionPlan {
  scope: Omit<EntityRef, 'entityId'>;
  expectedVersion: number;
  idempotencyKey: string;
  effects: Effect[];
  at?: string;
}

export interface ComponentSchema {
  componentType: string;
  version: number;
  schema: Record<string, unknown>;
  description?: string;
}

export interface SchemaRegistry {
  register(ownerId: string, schema: ComponentSchema): Promise<{ digest: string }>;
  resolve(ownerId: string, componentType: string, version?: number): Promise<ComponentSchema | null>;
  list(ownerId: string): Promise<ComponentSchema[]>;
}

export interface ExecutionContext {
  readonly scope: Omit<EntityRef, 'entityId'>;
  readonly reader: StateReader;
  readonly schema: SchemaRegistry;
  emit(effect: Effect): void;
  log(level: 'debug' | 'info' | 'warn', message: string, meta?: Record<string, unknown>): void;
  now(): string;
}

/** 规则函数签名：返回 void，只允许通过 ctx.emit 声明 Effect。 */
export type RuleFunction = (ctx: ExecutionContext) => void | Promise<void>;

export const AKASHA_CONTRACT_VERSION = 1 as const;
