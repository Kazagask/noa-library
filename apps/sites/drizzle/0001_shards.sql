CREATE TABLE noa_head (
  owner_id TEXT PRIMARY KEY,
  epoch TEXT NOT NULL,
  version INTEGER NOT NULL,
  migration TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE noa_shard (
  owner_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  family TEXT NOT NULL,
  slot TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  part INTEGER NOT NULL,
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= 240000),
  digest TEXT NOT NULL,
  PRIMARY KEY(owner_id,epoch,family,slot,part)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE noa_cas_guard (success INTEGER CHECK(success=1));
--> statement-breakpoint
CREATE TRIGGER noa_v1_fence BEFORE UPDATE ON noa_vault
WHEN EXISTS (SELECT 1 FROM noa_head WHERE owner_id=OLD.owner_id)
BEGIN SELECT RAISE(ABORT,'noa_v2_active'); END;
