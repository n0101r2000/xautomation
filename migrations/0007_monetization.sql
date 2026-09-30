-- 収益化基盤: note実URL・カバー画像・アプリ設定
ALTER TABLE note_articles ADD COLUMN note_url TEXT;
ALTER TABLE note_articles ADD COLUMN cover_image_id TEXT;
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
