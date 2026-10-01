-- Wafi X catalog + release schema. D1 (SQLite).
--
-- Phase 0 artifact: nothing reads this yet. It exists so the storage design is
-- reviewable and settled before any route is written against it.
--
-- Two decisions are enforced here rather than left to application code, because
-- a CHECK constraint cannot be bypassed by a forgotten validation in a handler:
--
--   1. Only https:// links are storable. A row that says `external` but holds
--      an `http://`, `file://`, UNC or `javascript:` URL cannot be written at
--      all. The desktop app enforces the same rule again before it spawns an
--      installer, because the server is not the only thing that has to be
--      trusted.
--
--   2. There is no column anywhere for free-form installer arguments. A server
--      that could send an argument string would be a remote command channel
--      wearing an application's name. `installer_mode` is a closed enum and
--      apps.rs maps each value to an argv vector that is fixed in Rust.
--
-- Adding R2 later requires no migration and no rewrite of this schema: see the
-- installer_url_kind note on app_versions.
--
-- Note on layout: SQLite requires every column definition to come first and
-- every table constraint (CHECK, UNIQUE, FOREIGN KEY) after them. Interleaving
-- the two is a syntax error, so the CHECKs at the bottom of each table are
-- grouped deliberately rather than sitting next to the column they concern.

-- ---------------------------------------------------------------------------
-- Catalog taxonomy
-- ---------------------------------------------------------------------------

CREATE TABLE app_categories (
  id          TEXT    PRIMARY KEY,          -- slug, e.g. 'browsers'
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------

CREATE TABLE apps (
  id            TEXT    PRIMARY KEY,        -- slug, e.g. 'firefox'
  name          TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  category_id   TEXT    REFERENCES app_categories(id) ON DELETE SET NULL,
  publisher     TEXT    NOT NULL DEFAULT '',

  -- Same discriminated-union shape as app_versions.installer_url: one column
  -- carries either an absolute URL or an object key, and `icon_kind` says
  -- which. 'none' means the panel has no icon yet and the app falls back to
  -- the category glyph, which the desktop UI already does.
  icon_kind     TEXT    NOT NULL DEFAULT 'none',
  icon_url      TEXT,
  homepage_url  TEXT,

  -- A featured app is pinned to the top of the Applications panel. Not a
  -- substitute for `published`: featured-but-unpublished stays invisible.
  featured      INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 0,
  position      INTEGER NOT NULL DEFAULT 0,

  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  CHECK (icon_kind IN ('none', 'external', 'r2')),
  CHECK (icon_kind = 'none' OR (icon_url IS NOT NULL AND length(icon_url) > 0)),
  CHECK (icon_kind = 'r2' OR icon_url IS NULL OR icon_url LIKE 'https://%'),
  CHECK (homepage_url IS NULL OR homepage_url LIKE 'https://%'),
  CHECK (featured IN (0, 1)),
  CHECK (published IN (0, 1))
);

CREATE INDEX idx_apps_visible   ON apps (published, featured DESC, position, name);
CREATE INDEX idx_apps_category  ON apps (category_id);

-- ---------------------------------------------------------------------------
-- Application versions
-- ---------------------------------------------------------------------------

CREATE TABLE app_versions (
  id                      TEXT    PRIMARY KEY,
  app_id                  TEXT    NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version                 TEXT    NOT NULL,          -- '131.0' - no leading 'v'

  -- 'exe' runs the file directly; 'msi' is handed to msiexec.
  installer_type          TEXT    NOT NULL,

  -- Closed enum. The mapping to real arguments lives in
  -- src-tauri/src/installer.rs and is not configurable from here:
  --   silent      -> /S       (NSIS)   /quiet  (MSI)
  --   passive     -> (default)          /qb     (MSI)
  --   interactive -> (no args)          (no args)
  installer_mode          TEXT    NOT NULL DEFAULT 'interactive',

  -- R2 arrives later without touching this table. `installer_url` already
  -- holds "an absolute https URL" or "an object key"; `installer_url_kind`
  -- says which one it is. Turning on R2 is a wrangler binding plus a different
  -- value written into these two existing columns - not an ALTER TABLE, not a
  -- migration over existing rows, and not a new code path in the desktop app,
  -- which resolves a kind to a final URL the same way either way.
  installer_url_kind      TEXT    NOT NULL DEFAULT 'external',
  installer_url           TEXT    NOT NULL,

  -- Optional. When present the desktop app verifies the downloaded bytes
  -- against it before the installer is allowed to run. Absent means the
  -- download rests on TLS plus a recorded size only.
  installer_sha256        TEXT,
  installer_size_bytes    INTEGER,

  published               INTEGER NOT NULL DEFAULT 0,
  release_date            TEXT,
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  CHECK (installer_type IN ('exe', 'msi')),
  CHECK (installer_mode IN ('silent', 'passive', 'interactive')),
  CHECK (installer_url_kind IN ('external', 'r2')),
  CHECK (installer_url_kind = 'r2' OR installer_url LIKE 'https://%'),
  CHECK (installer_sha256 IS NULL OR (
           length(installer_sha256) = 64
           AND installer_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK (installer_size_bytes IS NULL OR installer_size_bytes > 0),
  CHECK (published IN (0, 1)),

  -- One version string per application, so re-uploading the same version is an
  -- update of that row rather than a duplicate the panel has to reconcile.
  UNIQUE (app_id, version)
);

CREATE INDEX idx_versions_visible ON app_versions (app_id, published, release_date DESC);

-- ---------------------------------------------------------------------------
-- Wafi X releases
-- ---------------------------------------------------------------------------
--
-- This table is the panel's record of what has been published. It is NOT the
-- source of truth for the desktop updater: that reads latest.json from GitHub
-- Releases, because src-tauri/src/update_identity.rs pins both the artifact
-- filename prefix and the download host. Moving the updater feed off GitHub
-- means changing that file deliberately, which is out of scope here.
--
-- So the panel publishes a release to GitHub and records what it did. If the
-- two ever disagree, GitHub is what every existing installation is reading.

CREATE TABLE wafx_releases (
  id                    TEXT    PRIMARY KEY,
  version               TEXT    NOT NULL,          -- semver, no leading 'v'
  channel               TEXT    NOT NULL DEFAULT 'stable',
  notes                 TEXT    NOT NULL DEFAULT '',

  installer_url_kind    TEXT    NOT NULL DEFAULT 'external',
  installer_url         TEXT    NOT NULL,
  installer_sha256      TEXT,
  installer_size_bytes  INTEGER,

  -- Contents of the generated .sig files. Not paths: the updater plugin
  -- verifies the artifact against the signature string itself, so a URL here
  -- would be silently ignored.
  nsis_signature        TEXT,
  msi_signature         TEXT,

  published             INTEGER NOT NULL DEFAULT 0,
  release_date          TEXT,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  CHECK (channel IN ('stable', 'beta')),
  CHECK (installer_url_kind IN ('external', 'r2')),
  CHECK (installer_url_kind = 'r2' OR installer_url LIKE 'https://%'),
  CHECK (installer_sha256 IS NULL OR (
           length(installer_sha256) = 64
           AND installer_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK (installer_size_bytes IS NULL OR installer_size_bytes > 0),
  CHECK (published IN (0, 1)),

  UNIQUE (version)
);

CREATE INDEX idx_releases_channel ON wafx_releases (channel, published, release_date DESC);

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------

CREATE TABLE admins (
  id            TEXT    PRIMARY KEY,
  username      TEXT    NOT NULL,
  -- PBKDF2-SHA256, 310000 iterations, 16-byte salt. WebCrypto does the work;
  -- the iteration count is stored so it can be raised later without
  -- invalidating anyone's password.
  password_hash TEXT    NOT NULL,
  password_salt TEXT    NOT NULL,
  iterations    INTEGER NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_login_at TEXT,

  CHECK (disabled IN (0, 1)),
  CHECK (iterations >= 100000),
  CHECK (length(password_salt) >= 16),
  CHECK (length(password_hash) >= 32),

  UNIQUE (username)
);

-- Only the SHA-256 of a session token is stored. The token itself exists once,
-- in an HttpOnly cookie; a dump of this table cannot be replayed.
CREATE TABLE admin_sessions (
  token_hash   TEXT    PRIMARY KEY,
  admin_id     TEXT    NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_sessions_admin   ON admin_sessions (admin_id);
CREATE INDEX idx_sessions_expiry  ON admin_sessions (expires_at);

-- Panel actions are recorded because the panel is the only place a privileged
-- operator touches data. Who un-published something is worth knowing after the
-- fact; at this scale there is no volume problem and no reason to trim this.
CREATE TABLE admin_audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT,
  action   TEXT    NOT NULL,
  target   TEXT,
  ip       TEXT,
  at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_audit_at ON admin_audit (at DESC);
