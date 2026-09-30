-- 生成画像とnote記事の紐付け (有料note本文用図解)
ALTER TABLE generated_images ADD COLUMN article_id TEXT;
