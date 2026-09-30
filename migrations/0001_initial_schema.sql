-- AI Virtual Office: Mさん / 海外AI副業の検証部屋
-- 初期スキーマ

-- ワーカー実行ログ
CREATE TABLE IF NOT EXISTS worker_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_name TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running/success/failed
  input_json TEXT,
  output_json TEXT,
  error_message TEXT,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME
);

-- ネタ候補
CREATE TABLE IF NOT EXISTS topic_candidates (
  topic_id TEXT PRIMARY KEY,
  title_ja TEXT NOT NULL,
  appeal_axis TEXT NOT NULL, -- JSON配列
  target_medium TEXT NOT NULL, -- x_single/x_thread/note_free/note_paid
  source_urls TEXT NOT NULL, -- JSON配列
  why_hit TEXT,
  urgency TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending', -- pending/approved/rejected/published
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- X投稿
CREATE TABLE IF NOT EXISTS x_posts (
  post_id TEXT PRIMARY KEY,
  topic_id TEXT,
  slot_number INTEGER NOT NULL, -- 1-12
  scheduled_at DATETIME NOT NULL,
  body TEXT NOT NULL,
  image_urls TEXT, -- JSON配列
  approval_status TEXT DEFAULT 'pending', -- pending/approved/rejected
  qa_status TEXT DEFAULT 'pending', -- pending/ok/needs_fix/ng
  qa_issues TEXT, -- JSON配列
  buffer_id TEXT,
  published_at DATETIME,
  impressions INTEGER DEFAULT 0,
  engagements INTEGER DEFAULT 0,
  followers_gained INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (topic_id) REFERENCES topic_candidates(topic_id)
);

-- note記事
CREATE TABLE IF NOT EXISTS note_articles (
  article_id TEXT PRIMARY KEY,
  topic_id TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL, -- free/paid_single/monthly_summary/membership
  price_yen INTEGER DEFAULT 0,
  body_md TEXT NOT NULL,
  paywall_position INTEGER,
  approval_status TEXT DEFAULT 'pending', -- pending/approved/rejected/published
  qa_status TEXT DEFAULT 'pending',
  qa_issues TEXT,
  published_at DATETIME,
  view_count INTEGER DEFAULT 0,
  sales_count INTEGER DEFAULT 0,
  revenue_yen INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 日次KPI
CREATE TABLE IF NOT EXISTS kpi_daily (
  date DATE PRIMARY KEY,
  x_followers INTEGER DEFAULT 0,
  x_impressions_total INTEGER DEFAULT 0,
  x_engagements_total INTEGER DEFAULT 0,
  note_followers INTEGER DEFAULT 0,
  note_paid_sales INTEGER DEFAULT 0,
  membership_count INTEGER DEFAULT 0,
  membership_revenue INTEGER DEFAULT 0,
  affiliate_revenue INTEGER DEFAULT 0
);

-- 承認キュー(3ゲート)
CREATE TABLE IF NOT EXISTS approval_queue (
  approval_id TEXT PRIMARY KEY,
  gate_type TEXT NOT NULL, -- weekly_planning/daily_posts/paid_note
  target_ids TEXT NOT NULL, -- JSON配列
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME,
  decision TEXT -- approved/rejected/partial
);

-- ワーカーの現在状態(Virtual Office 表示用)
CREATE TABLE IF NOT EXISTS worker_status (
  worker_name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  icon TEXT NOT NULL,
  current_task TEXT DEFAULT '待機中',
  status TEXT DEFAULT 'idle', -- idle/working/error
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- タスクキュー(Cloudflare Queues の D1 代替)
CREATE TABLE IF NOT EXISTS task_queue (
  task_id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  payload TEXT, -- JSON
  status TEXT DEFAULT 'queued', -- queued/processing/done/failed
  priority INTEGER DEFAULT 5,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_worker_logs_worker ON worker_logs(worker_name, started_at);
CREATE INDEX IF NOT EXISTS idx_x_posts_status ON x_posts(approval_status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_topics_status ON topic_candidates(status, created_at);
CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status, priority);
