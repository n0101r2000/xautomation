-- アフィリエイトリンク管理
-- ASPの提携申請・リンク発行は人間が1回だけ行い、ここに登録する。
-- 以後は投稿文からツール名を自動検出し、リンク+PR表記を自動埋め込みする。

CREATE TABLE IF NOT EXISTS affiliate_links (
  link_id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,          -- 表示名(例: ElevenLabs)
  aliases TEXT NOT NULL,            -- 検出用エイリアス JSON配列(例: ["ElevenLabs","イレブンラボ"])
  affiliate_url TEXT NOT NULL,      -- アフィリエイトリンク(登録後は自動使用)
  program TEXT,                     -- ASP/プログラム名(例: 公式アフィリエイト, A8.net)
  note TEXT,                        -- メモ(報酬率など)
  status TEXT DEFAULT 'active',     -- active/paused
  auto_embed INTEGER DEFAULT 1,     -- 1=自動埋め込み対象
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_affiliate_status ON affiliate_links(status);

-- 用語注釈辞書(Yutoが素人向け注釈を付けるための辞書)
CREATE TABLE IF NOT EXISTS glossary (
  term TEXT PRIMARY KEY,            -- 固有名詞(例: KDP)
  annotation TEXT NOT NULL,         -- 素人向け注釈(例: Amazonで誰でも電子書籍を出せるサービス)
  category TEXT                     -- service/platform/term
);
