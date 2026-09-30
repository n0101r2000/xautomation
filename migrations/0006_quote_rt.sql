-- 枠6 引用RT機能: 引用元ツイート情報
ALTER TABLE x_posts ADD COLUMN quote_tweet_id TEXT;
ALTER TABLE x_posts ADD COLUMN quote_author TEXT;   -- @screenName
ALTER TABLE x_posts ADD COLUMN quote_text TEXT;     -- 引用元本文(承認画面表示用)
