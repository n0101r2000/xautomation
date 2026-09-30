-- 生成画像の管理テーブル (Aki画像生成 + Mio画像QA)
CREATE TABLE IF NOT EXISTS generated_images (
  image_id TEXT PRIMARY KEY,
  post_id TEXT,                       -- 紐付く投稿 (任意)
  purpose TEXT DEFAULT 'thumbnail',   -- thumbnail/infographic/note_cover
  prompt TEXT NOT NULL,               -- 生成に使ったプロンプト
  title_text TEXT,                    -- 画像内テキスト
  r2_key TEXT NOT NULL,               -- R2オブジェクトキー
  model TEXT,                         -- gpt-image-2 等
  qa_status TEXT DEFAULT 'pending',   -- pending/ok/needs_fix/ng
  qa_issues TEXT,                     -- JSON配列 (Mio画像QA結果)
  cost_usd REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES x_posts(post_id)
);

CREATE INDEX IF NOT EXISTS idx_generated_images_post ON generated_images(post_id);
