/**
 * V2.2.3 权威读写矩阵。V3 激活后：adapted 写 V3，read 读 V3，reject 明确失败。
 * 所有 MCP 工具与管理 API 必须在此表登记；测试会检查 tools/list 全覆盖。
 */
export const AUTHORITY_MATRIX = {
  vault_stats: { access: 'read', backend: 'v3-stats', status: 'adapted', scope: 'read', revision: 'none', idempotency: 'none' },
  vault_compact: { access: 'write', backend: 'v2', status: 'reject', scope: 'admin', revision: 'v2-version', idempotency: 'none' },
  vault_migrate: { access: 'write', backend: 'v2', status: 'reject', scope: 'admin', revision: 'v2-version', idempotency: 'none' },
  qa_create: { access: 'write', backend: 'v2', status: 'reject', scope: 'admin', revision: 'v2-version', idempotency: 'none' },
  archive_export: { access: 'read', backend: 'v3-archive', status: 'adapted', scope: 'read', revision: 'bound', idempotency: 'none' },
  archive_import: { access: 'write', backend: 'v3-archive', status: 'adapted', scope: 'admin', revision: 'new', idempotency: 'required' },
  runtime_init: { access: 'write', backend: 'v3-adapter', status: 'adapted', scope: 'write', revision: 'v2-version', idempotency: 'required' },
  campaign_list: { access: 'read', backend: 'v3', status: 'adapted', scope: 'read', revision: 'none', idempotency: 'none' },
  campaign_import: { access: 'write', backend: 'v2', status: 'reject', scope: 'admin', revision: 'v2-version', idempotency: 'none' },
  event_commit: { access: 'write', backend: 'v3-event', status: 'adapted', scope: 'write', revision: 'expectedRevision', idempotency: 'required' },
  event_receipt: { access: 'read', backend: 'v3-index', status: 'adapted', scope: 'read', revision: 'none', idempotency: 'none' },
  session_bootstrap: { access: 'read', backend: 'v3', status: 'adapted', scope: 'read', revision: 'none', idempotency: 'none' },
  persona_load: { access: 'read', backend: 'v3-persona', status: 'adapted', scope: 'read', revision: 'none', idempotency: 'none' },
  state_read: { access: 'read', backend: 'v3-components', status: 'adapted', scope: 'read', revision: 'none', idempotency: 'none' },
  state_commit: { access: 'write', backend: 'v3-event', status: 'adapted', scope: 'write', revision: 'expectedRevision', idempotency: 'required' },
  memory_recall: { access: 'read', backend: 'v3-index', status: 'adapted', scope: 'read', revision: 'none', idempotency: 'none' },
  memory_traverse: { access: 'read', backend: 'v3-index', status: 'adapted', scope: 'read', revision: 'none', idempotency: 'none' },
  memory_record: { access: 'write', backend: 'v3-adapter', status: 'adapted', scope: 'write', revision: 'memoryRevision', idempotency: 'required' },
  memory_revise: { access: 'write', backend: 'v3-adapter', status: 'adapted', scope: 'write', revision: 'memoryRevision', idempotency: 'required' },
  runtime_execute: { access: 'write', backend: 'v3-rng', status: 'adapted', scope: 'write', revision: 'expectedRevision', idempotency: 'required' },
  save_checkpoint: { access: 'write', backend: 'v3-checkpoint', status: 'adapted', scope: 'write', revision: 'current', idempotency: 'required' },
  session_recover: { access: 'read', backend: 'v3-index', status: 'adapted', scope: 'read', revision: 'none', idempotency: 'none' },
  save_restore: { access: 'write', backend: 'v3-checkpoint', status: 'adapted', scope: 'admin', revision: 'monotonic', idempotency: 'required' },
  memory_summarize: { access: 'write', backend: 'v3-adapter', status: 'adapted', scope: 'write', revision: 'memoryRevision', idempotency: 'required' },
  memory_layers: { access: 'read', backend: 'v3-index', status: 'adapted', scope: 'read', revision: 'none', idempotency: 'none' },
  todo_status: { access: 'write', backend: 'v3-adapter', status: 'adapted', scope: 'write', revision: 'memoryRevision', idempotency: 'required' }
};

export const ADMIN_API_MATRIX = {
  '/api/migrate-save-481': { access: 'write', status: 'reject', reason: 'campaign import 未适配 V3' },
  '/api/repair-authority': { access: 'write', status: 'reject', reason: 'repair apply 未适配 V3' }
};
