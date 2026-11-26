CREATE TABLE noa_vault (
  owner_id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  document TEXT NOT NULL CHECK (json_valid(document))
);
