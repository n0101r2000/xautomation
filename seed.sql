-- ============================================================
-- 実利用向け初期データ(デモデータなし)
-- ワーカー9人の登録と用語注釈辞書のみ。
-- 投稿・ネタ・KPIなどはパイプライン実行で実データが生成される。
-- ============================================================

-- ワーカー初期データ(9人)
INSERT OR REPLACE INTO worker_status (worker_name, display_name, role, icon, current_task, status) VALUES
  ('alex', 'Alex', 'PM(進行管理)', '👨‍💼', '待機中', 'idle'),
  ('riko', 'Riko', '企画(リサーチャー)', '🔍', '待機中', 'idle'),
  ('kai',  'Kai',  '翻訳', '🌐', '待機中', 'idle'),
  ('yuto', 'Yuto', 'ライター', '✍️', '待機中', 'idle'),
  ('aki',  'Aki',  '画像担当', '🎨', '待機中', 'idle'),
  ('sora', 'Sora', 'SNS管理', '📱', '待機中', 'idle'),
  ('nana', 'Nana', '秘書', '📋', '待機中', 'idle'),
  ('rui',  'Rui',  '分析', '📊', '待機中', 'idle'),
  ('mio',  'Mio',  'QA', '✅', '待機中', 'idle');

-- 用語注釈辞書(Yuto/QAが素人向け注釈に使用 — 実運用でも利用する実データ)
INSERT OR REPLACE INTO glossary (term, annotation, category) VALUES
  ('KDP', 'Amazonで誰でも無料で電子書籍を出版できる仕組み(Kindle Direct Publishing)', 'service'),
  ('ElevenLabs', '文章を入れると人間そっくりの音声を作ってくれるAIサービス', 'service'),
  ('VOICEVOX', '無料で使える日本語のAI音声読み上げソフト', 'service'),
  ('CapCut', 'スマホでもPCでも使える無料の動画編集アプリ', 'service'),
  ('Etsy', '海外版ミンネのようなハンドメイド作品・デジタル素材の販売サイト', 'platform'),
  ('Reddit', 'アメリカ最大級の掲示板サイト。副業やAIの一次情報の宝庫', 'platform'),
  ('Faceless動画', '顔出しせずナレーションと画面素材だけで作るYouTube動画', 'term'),
  ('AIエージェント', '問い合わせ対応などの作業を自動でこなしてくれるAIの仕組み', 'term'),
  ('Indie Hackers', '海外の個人開発者が収益を公開し合うコミュニティサイト', 'platform'),
  ('ローコンテンツ本', '日記帳や記入式ノートなど、文章をほとんど書かずに作れる本', 'term'),
  ('ASP', 'アフィリエイトの広告を仲介する会社(A8.netなど)', 'term'),
  ('KPI', '目標の達成度を測る数字(フォロワー数・売上など)', 'term');
