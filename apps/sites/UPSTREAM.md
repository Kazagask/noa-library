# Sites production upstream snapshot

## Provenance

- Worker release: `2.0.0-storage.4` (confirmed from the live MCP's read-only storage status).
- Sites saved version: 11; corresponding publication status: succeeded, 2026-11-26.
- Sites source commit: `3277ba20949aa4e30d695334b9f4f5d9ef3fbb29` (source repository returned by Sites, matched against the saved version).
- GitHub merge base at export: `d259a6b8b19ef3d3ce3694abf5ed51f611e478bb` (main).
- `UPSTREAM` is the original file recording the historical GitHub base of the Sites adaptation. It is preserved verbatim.
- Rebuilt Worker SHA-256: `3547b7fa33a21dcbe1a19c5c611630b41712c8a66ffd6613fe6426b69769e372`. The rebuilt bundle is byte-identical to the Worker from the locally retained deployment archive used when publishing version 11.

This directory is an export of the 38 Git-tracked source files of the Sites commit, with one configuration substitution. The live project identifier in `.openai/hosting.json` is replaced with `<SITES_PROJECT_ID>`. The rest of that file describes the D1 binding and MCP capability. This document is the only additional file. Source and tests were not refactored. The original README includes historical V1 descriptions; consult the V2 implementation for actual storage behavior.

## Directory structure

- `src/worker.js`: Worker HTTP routing, JSON-RPC MCP, Sites identity integration and ownership checks.
- `src/tools.js`, `src/events.js`, `src/authority.js`: tool schemas, dispatch, transactions, business projection and patch normalization, receipts.
- `src/storage-v2.js`, `src/vault.js`, `src/export.js`: D1 sharding and transaction storage, legacy vault, archive pagination and hashes.
- `src/formal.js`, `src/projections-v2.js`, `src/repair.js`: historic import and migration code with acceptance assertions. Formal import inputs are supplied at runtime.
- `src/qa-v2.js`, `src/diagnostics.js`, `src/verify-formal.js`: QA and historical diagnostics.
- `src/admin.js`, `src/page.js`: administrator operations and UI.
- `src/upstream/`, `src/schemas/`: copied runtime helpers and JSON schemas.
- `src/seed.json`: original public synthetic DEMO and minimum persona skeleton. DEMO state, working, events, graph and episodes, plus persona memory rows, were compared to the public upstream at the commit in UPSTREAM and match semantically.
- `drizzle/`: original D1 schema migrations and journal.
- `scripts/`: original esbuild and SQLite-backed smoke/QA scripts.
- `package.json`, `package-lock.json`: original dependency manifest and lockfile.

The repository contains source-level campaign identifiers and historical acceptance-test constants from the deployed implementation. It contains no imported save documents, raw private episodes, D1 database exports, or production credentials. Dependency directories and compiled output are generated, and are omitted from this source snapshot.

## Build and local verification

Run from `apps/sites` with Node.js 24 (tested with 24.22.3), npm, and SQLite support via `node:sqlite`:

```sh
npm ci
node scripts/build.mjs
node scripts/smoke.mjs
NOA_QA_COMMITS=5 node scripts/v2-qa.mjs
```

These commands were run on the exported copy, with smoke and the five-commit isolated QA passing. The QA script intentionally logs a simulated failure during its interruption test. The build outputs `dist/server/index.js`. The optional formal test requires external private fixture input (`NOA_FORMAL_TEST_SOURCE` for smoke, or a private V1 backup path as the argument to v2-qa); those files are intentionally excluded. No production data was accessed by these local tests.

## Hosted runtime requirements and unavailable managed components

The production Worker depends on the Sites hosting environment:

| Component | Exported application contract | Separately provisioned alternative |
| --- | --- | --- |
| Sites identity gateway, owner-only audience policy, MCP registration and OAuth | Worker consumes the Sites-authenticated user ID header; MCP capability and JSON-RPC handler are included | Configure an authenticated reverse proxy that strips untrusted identity headers, verifies identity and injects the trusted ID; register MCP with an authorization server |
| D1 database instance | `DB` logical binding, both SQL migrations and journal, and D1 adapter calls are included | Provision an empty D1 database or compatible SQL adapter; apply migrations in order. Restore data through a separate private process |
| Platform environment values | Worker names: `NOA_MIGRATION_OWNER`, `NOA_MIGRATION_SECRET`, `NOA_REPAIR_OWNER`, `NOA_REPAIR_SECRET` | Configure outside Git through a secret manager; owner identifiers must correspond to the authenticated identity |
| Sites packaging, deploy infrastructure, private source-repo credentials, service bindings | Hosting manifest template and reproducible build command | Use Sites publishing or implement an equivalent Worker deployment pipeline separately |
| Production DB contents and official import fixtures | Import/export logic and schemas | Use the user's separately held private backup and vault; never add it to this public repository |

Platform-managed implementations, secrets and actual instance configuration are not available as application source. The suggested alternatives are integration requirements and are not implementations provided by this snapshot.

## Known limitations at the export point

- The V2 write path still loads historical data, and targeted read paths still load part of the worldline. The 10,000-commit and managed-platform restart tests have not been completed.
- `vault_compact` reports candidate staging objects but does not garbage-collect them or rebuild indexes automatically.
- The optional historical production-migration assertions are tied to the historical baseline; they are not general-purpose regression fixtures. Legacy diagnostics and restore paths still require review against the V2 model.
- The client's cached MCP tool schema may lag behind the served tool list. Compatibility tool paths exist in the source.
- The user reported SSE disconnects under long sessions. This source transfer makes no performance or transport changes and does not diagnose the latest incident.

## Source inventory

The following list records the Git blob IDs of the 38 tracked files as present in the production source commit. The project ID template is the only altered file. The deployment and production database are untouched.

| Path | Original Git blob SHA |
| --- | --- |
| `.gitignore` | `d391312c564890388c9993cd93df03d40494a1aa` |
| `.openai/hosting.json` | `c05bf584074087f852552c86e318d825ac8e1206` |
| `README.md` | `08a37d0a9bd6e28447478998d4d17c1731e2ff14` |
| `UPSTREAM` | `40c377b8af951de0ff099646f1a6a2ddad143a5f` |
| `drizzle/0000_vault.sql` | `3c283b235d89bd2e71e4b85c04979af76089fe38` |
| `drizzle/0001_shards.sql` | `85449b70d05b0c7cc936e9d0922f31232c271de2` |
| `drizzle/meta/_journal.json` | `fd442605d5ab3590e9c3e2669d25f56f64308061` |
| `package-lock.json` | `6e9994f255e034ec4a21aa971d0bf36d0f4bfb8e` |
| `package.json` | `ce42f1ac89a13babce0567356e461fd866792990` |
| `scripts/build.mjs` | `9077d090330412254f544e72427e954e70216f48` |
| `scripts/smoke.mjs` | `deb685b3067f1492d39eee4fa7051fb146c81a0f` |
| `scripts/v2-qa.mjs` | `5d2382eea514f3beaa39d05a841eec39fd063154` |
| `src/admin.js` | `5f27ffc890b9b9cd4a73e22988437a9d7ee6dd80` |
| `src/authority.js` | `eca09c535af3801e7af1caf47d208f241f3941fd` |
| `src/diagnostics.js` | `30a4f58ff1f0215175dde3663c5a0cced7dc0fc1` |
| `src/events.js` | `1a887414b677324e481628a383aa6e8b1524aa4d` |
| `src/export.js` | `04f7470bce0e8a1a2dae5c3721f3b67014420b43` |
| `src/formal.js` | `5d6372b2d2d9a5e56c16672c8c0ceec1f2ee2a67` |
| `src/page.js` | `c2c7ad4d0dd35d3a4dd3e8e0332b2443546d8c6f` |
| `src/projections-v2.js` | `46172e3e45614bb4e4982f33025537031d31a040` |
| `src/qa-v2.js` | `378ec7128bc0ac592a240da9a0248e4585fe8b36` |
| `src/repair.js` | `972a8b490f96b5013525974c029e02a498ff31b2` |
| `src/schemas/entity.schema.json` | `5fe0c8abe13dac2e5e1b0f3b03c5a17775e7dc47` |
| `src/schemas/episode.schema.json` | `b5060ce02e92e0e96bf6ac01e3335dc7cbe51516` |
| `src/schemas/manifest.schema.json` | `c5f528c5fa0c4bb2295da463e4cbbf08f553a79a` |
| `src/schemas/relation.schema.json` | `5941608f8203b54207f476ea487dfa6389a82b09` |
| `src/schemas/runtime-request.schema.json` | `4fb46c06e7f1de3eb06b827e41c012ee18223753` |
| `src/schemas/state.schema.json` | `4c3207e29e78fec74bb47f3c6f99cdfc05458fc9` |
| `src/seed.json` | `3b4ba15d9d26b533725381ca1443a642e7e6b80e` |
| `src/storage-v2.js` | `28991e99426746e8dfee7ae84455387c6b6cbd6d` |
| `src/tools.js` | `5574fbb47213f59a1ba23980a29f512dd3af099e` |
| `src/upstream/domain.ts` | `25e8d48d2e68a86cb648a9510c41753ef0efcfc4` |
| `src/upstream/operations.ts` | `2501a1f39721c3f76dcceded90505a0695bfda20` |
| `src/upstream/store.ts` | `dbdd1568b87a66c280560ae9dcba52e82d2e9e00` |
| `src/upstream/util.ts` | `72308d0b5fb188812ee94503de7ac6389470933d` |
| `src/vault.js` | `dd897a1d3c5b06baf2927b6fa43096d98c2deb85` |
| `src/verify-formal.js` | `966336cb91d26acadf80da5cb070545d7bcc9c17` |
| `src/worker.js` | `bf881f0f4cd56368636bec692d6e362992440a92` |
