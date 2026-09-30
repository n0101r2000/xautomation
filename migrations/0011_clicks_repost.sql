-- ③ アフィリンククリック計測: /go/:link_id リダイレクト経由のクリックを記録
CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id TEXT NOT NULL,
  clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  referer TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_link ON affiliate_clicks(link_id, clicked_at);

-- ④ セルフリポスト: 同じ投稿を二度RTしないための追跡
ALTER TABLE x_posts ADD COLUMN self_reposted_at DATETIME;
