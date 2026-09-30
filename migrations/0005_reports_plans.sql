-- Nana日次レポート / Rui分析レポート / Alex週次計画

CREATE TABLE IF NOT EXISTS daily_reports (
  report_id TEXT PRIMARY KEY,
  report_date DATE NOT NULL,
  body_md TEXT NOT NULL,          -- 300字以内のレポート本文
  pending_count INTEGER DEFAULT 0, -- 承認待ち総数
  stale_pending INTEGER DEFAULT 0, -- 24時間以上滞留の承認待ち数
  cost_usd REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON daily_reports(report_date);

CREATE TABLE IF NOT EXISTS analysis_reports (
  report_id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL,      -- daily / weekly
  report_date DATE NOT NULL,
  body_md TEXT NOT NULL,          -- 分析本文(Markdown)
  proposals_json TEXT,            -- weekly時: 改善提案3つのJSON配列
  cost_usd REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analysis_reports ON analysis_reports(report_type, report_date);

CREATE TABLE IF NOT EXISTS weekly_plans (
  plan_id TEXT PRIMARY KEY,
  week_start DATE NOT NULL,       -- 週の月曜日
  theme TEXT NOT NULL,            -- 今週のテーマ
  body_md TEXT NOT NULL,          -- テーマ分解+曜日別配分(Markdown)
  tasks_json TEXT,                -- 曜日別タスクJSON
  cost_usd REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_weekly_plans_week ON weekly_plans(week_start);
