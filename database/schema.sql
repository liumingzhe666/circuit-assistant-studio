PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO app_metadata (key, value) VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS library_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  publisher TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '',
  isbn TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'zh-CN',
  source_type TEXT NOT NULL,
  original_name TEXT NOT NULL,
  original_path TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  file_sha256 TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL DEFAULT 0,
  rights_status TEXT NOT NULL DEFAULT 'user-provided'
    CHECK (rights_status IN ('user-provided', 'licensed', 'public-domain', 'unknown')),
  rights_note TEXT NOT NULL DEFAULT '',
  page_count INTEGER NOT NULL DEFAULT 0,
  extracted_chars INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'needs-ocr', 'error')),
  accessed_at TEXT NOT NULL DEFAULT '',
  imported_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_library_sources_publisher
  ON library_sources(publisher);
CREATE INDEX IF NOT EXISTS idx_library_sources_imported_at
  ON library_sources(imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_library_sources_source_url
  ON library_sources(source_url);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES library_sources(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  page_start INTEGER,
  page_end INTEGER,
  char_start INTEGER NOT NULL DEFAULT 0,
  char_end INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  UNIQUE(source_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source
  ON knowledge_chunks(source_id, chunk_index);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  chunk_id UNINDEXED,
  source_id UNINDEXED,
  title,
  publisher,
  heading,
  content,
  search_terms,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS import_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_sha256 TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('imported', 'duplicate', 'needs-ocr', 'error')),
  source_id INTEGER REFERENCES library_sources(id) ON DELETE SET NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_import_log_created_at
  ON import_log(created_at DESC);

DROP VIEW IF EXISTS library_catalog;
CREATE VIEW library_catalog AS
SELECT
  s.id,
  s.title,
  s.publisher,
  s.authors,
  s.isbn,
  s.source_type,
  s.source_url,
  s.rights_status,
  s.rights_note,
  s.page_count,
  s.extracted_chars,
  s.chunk_count,
  s.status,
  s.accessed_at,
  s.imported_at
FROM library_sources AS s;
