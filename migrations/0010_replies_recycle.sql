-- P1-4 リプライ自動返信: mentions回収→返信下書き→承認→自動送信
CREATE TABLE IF NOT EXISTS x_replies (
  reply_id TEXT PRIMARY KEY,
  mention_tweet_id TEXT UNIQUE NOT NULL, -- 返信先(受信したメンション)のツイートID
  mention_author TEXT,                    -- @username
  mention_author_id TEXT,
  mention_text TEXT,                      -- メンション本文
  draft_body TEXT,                        -- 生成した返信下書き
  qa_status TEXT DEFAULT 'pending',       -- pending/ok/needs_fix/ng
  qa_issues TEXT,                         -- JSON配列
  approval_status TEXT DEFAULT 'pending', -- pending/approved/rejected
  posted_tweet_id TEXT,                   -- 送信済み返信のツイートID
  published_at DATETIME,
  cost_usd REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_x_replies_status ON x_replies(approval_status, published_at);

-- P1-6 高実績投稿リサイクル: 再投稿元の追跡
ALTER TABLE x_posts ADD COLUMN recycled_from TEXT;
