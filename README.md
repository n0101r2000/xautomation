# AI Virtual Office — Mさん / 海外AI副業の検証部屋

## プロジェクト概要
- **名称**: AI Virtual Office(Mさん / 海外AI副業の検証部屋 運用ダッシュボード)
- **目的**: 9人のAIワーカーが海外一次情報の収集→翻訳→執筆→QA→投稿を自走し、取締役(あなた)は**3つの承認ゲートのみ**を操作する擬似オフィスの管理画面
- **収益方針**: まず0→1の初売上を作る。価格は **有料単発note¥100 / 月次まとめnote¥500** の低価格検証特化路線(メンバーシップは当面休止)
- **最優先KPI**: Xフォロワーの増加。X Premium加入済みで1投稿最大25,000字 — ツリー/スレッド分割は廃止し、長文は1投稿完結型。文体は「人が書いているような自然な日本語」(AIっぽい定型表現はQAで自動検出)、専門知識ゼロの読者でも読める言葉選びを徹底
- **主な機能**:
  - 🏢 **オフィスビュー**: 取締役デスク+9ワーカーの稼働状態をリアルタイム表示(15秒毎に自動更新)+手動実行パネル(ネタ巡回/パイプライン/予約投稿/メンション回収/返信送信/セルフRT/KPI収集を時間を待たず即時実行)
  - 👷 **実処理とワーカーアイコンの連動**: パイプライン各フェーズの開始/終了時に `worker_status` を実更新(例: Alex「週次計画を立案中」→ Riko「海外ソース巡回中」→ Kai「翻訳・要約中」→ Yuto+Mio「執筆/QA審査中」→ Aki「画像生成中」→ Rui「実績分析中」→ Nana「日次レポート作成中」)。異常終了時も `finally` で全員 idle に復帰するためアイコンが固まらない
  - 🔒 **二重実行ガード**: `app_settings` の `pipeline_running_at` フラグで多重起動を防止。実行中に再度実行すると「パイプラインは既に実行中です(約N分前に開始)」を即時返却。20分経過した残留ロックは自動失効(異常終了時のデッドロック防止)
  - ✅ **承認2ゲート**:  ①日次X投稿12本の一括/個別承認・差戻(理由付き) ②有料note全文プレビュー→公開
  - 📊 **KPIダッシュボード**: フォロワー・売上の2軸グラフ(Chart.js)+日次明細テーブル+**KPI手動入力フォーム**(Xインプレ/note売上/メンバー数/アフィ収益)+**記事別売上入力**
  - 🔄 **KPI自動収集(ほぼ全自動)**: Xフォロワー数・Xインプレ/エンゲージメント(直近20投稿、X API従量課金)・noteフォロワー数・スキ累計(note公開API)・**note閲覧数PV・メンバー数(note session Cookie登録で有効化)**を毎日自動取得。手動入力はnote売上とアフィ収益のみ(売上API非存在のため)。自動値と手動値は互いに上書きしない設計
  - 🍪 **note session Cookie管理**: KPI画面から `_note_session_v5` Cookieを登録(保存前に自動検証)。**失効を毎朝自動検知しオフィス画面に赤い通知バナーを表示→ワンクリックで再登録画面へ**。Cookie値はAPIレスポンスでマスク(末尾4桁のみ表示)
  - 🛡️ **QAチェッカー(Mio)**: 禁止表現・法令リスク(薬機法/景表法/金商法/ステマ規制)を実際に検出する実動ロジック
  - 🔗 **アフィリンク自動埋め込み**: 提携済みリンクを1回登録すれば、投稿文からツール名を自動検出してリンク+PR表記を自動挿入(承認画面のワンボタン/埋め込み後に自動再QA)
  - 📖 **用語注釈辞書**: 固有名詞(KDP・Etsy等)の素人向け注釈を辞書管理。Yutoの執筆ルールに組み込み
  - 📋 **Nana日次レポート**: 毎日の実績・承認待ち・24h滞留リマインドをオフィス画面に表示(300字以内)
  - 📊 **Rui分析**: 日次仮説分析 + 日曜の週次7日総括・改善提案3つ(KPI画面に表示、提案はAlexの週次計画に自動反映)
  - 🧑‍💼 **Alex週次計画**: 月曜に週のテーマを決定し曜日別に切り口を配分。Yutoの執筆プロンプトに毎日注入
  - 📝 **note自動執筆(商品ライン対応)**: 毎日1本 — 平日=無料 / 日曜=**有料単発¥100** / 土曜=**メンバーシップ(月¥500)限定記事** / 毎月1日=**月次まとめnote¥500(主力商品、5000字超)**。有料はpaywall位置付きでゲート③に並び、全文プレビューで有料ラインを可視化、Markdownコピーで半自動公開。本文にはアフィリンクを自動埋め込み(#PR付き)
  - 🔗 **note URL連動+販売導線**: 公開済みnoteの実URLを登録すると、Xの枠11(note宣伝枠)が実URL付き告知に自動切替。有料note公開後2日間は「発売モード」で枠2+枠11が価格訴求付き販売導線に
  - 🎨 **Aki画像増産体制(1日10枚以上OK)**: パイプラインで全12枠の投稿をAkiが一括判定→画像が効く枠だけに図解/アイキャッチを生成(最大8枚/日、枠3は必須)→**Mio(別ワーカー)が画像QA→合格分のみ各X投稿に自動添付**(不合格は記録のみ・添付見送り)
  - 🖼️ **Aki noteカバー画像**: 毎日のnote記事にブランド準拠のカバー画像(1536×1024)を自動生成しゲート③に添付
  - 📐 **Aki有料note本文用図解**: 有料記事(¥100単発/メンバー限定/月次まとめ)の本文から図解ポイントを抽出し最大2枚生成→Mio QA→ゲート③のプレビューに表示・ダウンロードしてnoteに挿入できる
  - 🔎 **Riko競合リサーチ**: 毎週月曜にAI副業系noteの売れ筋・価格相場・タイトル傾向を自動分析し、Alexの週次計画に自動反映(KPI画面にレポート表示)

## URL
- **本番**: https://0c9c4d00-0596-4d2b-8bc9-5a2b11a4709d.vip.gensparksite.com
- **GitHub**: https://github.com/daichi763/xautomation
- **サンドボックスプレビュー(開発用)**: https://3000-i94l1sj6tl7trvmsyql1g-3844e1b6.sandbox.novita.ai

## 機能エントリ(API)
| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/office` | ワーカー状態+タスク+KPI+承認待ち+直近ログ |
| GET | `/api/workers/:name` | ワーカー詳細と実行ログ |
| GET | `/api/topics?status=pending` | 企画ネタ一覧(ゲート①) |
| POST | `/api/topics/:id/decision` | 企画の採用/見送り `{decision}` |
| GET | `/api/posts?status=pending` | X投稿一覧(ゲート②) |
| POST | `/api/posts/:id/decision` | 投稿の承認/差戻 `{decision, reason?}` |
| POST | `/api/posts/approve-all` | QA通過分を一括承認 |
| GET | `/api/replies?status=pending` | リプライ返信下書き一覧(ゲート②) |
| POST | `/api/replies/:id/decision` | 返信の承認/却下 `{decision, body?}`(承認時に本文編集可) |
| POST | `/api/replies/approve-all` | QA通過の返信を一括承認 |
| GET | `/go/:link_id` | アフィリンククリック計測リダイレクト(公開・認証不要。記録→実アフィURLへ302) |
| GET | `/api/notes` / `/api/notes/:id` | note記事一覧/全文(ゲート③) |
| POST | `/api/notes/:id/publish` | note公開(QA=NGは拒否) |
| GET | `/api/kpi?days=14` | KPI履歴+サマリ |
| POST | `/api/kpi/daily` | KPI手動入力(インプレ/note売上/メンバー数/アフィ収益等、未入力項目は上書きしない) |
| POST | `/api/kpi/collect` | KPI自動収集を今すぐ実行(Xフォロワー+noteフォロワー/スキ) |
| GET/POST | `/api/settings` | アプリ設定(noteユーザー名 / note session Cookieの登録。Cookieは保存前に自動検証・レスポンスではマスク) |
| POST | `/api/notes/:id/url` | 公開済みnoteの実URL登録(枠11の宣伝投稿が実URL連動に) |
| POST | `/api/notes/:id/stats` | 記事別の閲覧数/売上件数/売上金額を記録 |
| POST | `/api/notes/monthly/run` | 月次まとめnote(¥500)を今すぐ生成 |
| POST | `/api/reports/competitor/run` | Riko競合リサーチを今すぐ実行 |
| POST | `/api/qa/check` | QAチェック実行 `{text, has_affiliate?}` |
| GET | `/api/qa/rules` | 禁止表現ルールDB |
| POST | `/api/replies/collect` | 手動: メンション回収→返信下書き生成(通常はJST 8/12/18/22時自動) |
| POST | `/api/replies/publish` | 手動: 承認済み返信を即時送信(通常は毎時自動) |
| POST | `/api/sora/publish-due` | 手動: 予約時刻到来分の承認済み投稿を即時X送信(通常は毎時自動) |
| POST | `/api/selfrepost/run` | 手動: セルフRT即時実行、1日1回ガード付(通常はJST 21時自動) |
| GET/POST | `/api/affiliate/links` | アフィリンク一覧/登録 |
| POST | `/api/affiliate/links/:id/toggle` `/delete` | リンク停止・再開/削除 |
| POST | `/api/affiliate/embed` | 埋め込みプレビュー `{text}` |
| POST | `/api/posts/:id/embed-affiliate` | 投稿へ自動埋め込み+再QA |
| GET | `/api/glossary` / POST `/api/glossary/suggest` | 用語辞書/注釈サジェスト |
| POST | `/api/riko/crawl` | Riko実巡回のみ(RSS/Reddit収集→gpt-5-mini選定→10ネタ投入) |
| POST | `/api/pipeline/run` | フルパイプライン手動実行(Riko→Kai→Yuto→Mio) |
| GET | `/api/cron/status` | 自動サイクル状態+実行履歴 |
| GET | `/api/reports/daily` | Nana日次レポート(直近7件) |
| POST | `/api/reports/daily/run` | Nanaレポートを今すぐ生成 |
| POST | `/api/reports/analysis/run` | Rui日次分析を今すぐ実行 |
| GET | `/api/quote/candidates` | 引用RT候補(日本語話題ツイート)のプレビュー |
| GET | `/api/reports/analysis` | Rui分析レポート(日次/週次) |
| GET | `/api/plans/weekly` | Alex週次計画(直近4週) |
| POST | `/api/cron/run` | 定時実行エンドポイント(`Authorization: Bearer CRON_SECRET` 必須、セッション不要) |
| GET | `/api/auth/status` | 認証状態(登録済み/ログイン中か) |
| POST | `/api/auth/register` `/login` `/logout` | メール+パスワード認証(許可メールのみ登録可) |

## データアーキテクチャ
- **ストレージ**: Cloudflare D1(ローカルは `--local` SQLite) + R2(生成画像の保存)
- **テーブル**: `worker_status` / `worker_logs` / `topic_candidates` / `x_posts`(recycled_from列でリサイクル追跡) / `note_articles`(note_url・cover_image_id列含む) / `kpi_daily` / `approval_queue` / `task_queue` / `affiliate_links` / `glossary` / `generated_images` / `daily_reports`(Nana) / `analysis_reports`(Rui・競合リサーチ含む) / `weekly_plans`(Alex) / `auth_users` / `auth_sessions` / `app_settings` / `x_replies`(リプライ返信) / `affiliate_clicks`(クリック計測。x_posts.self_reposted_atでセルフRT追跡)
- **KPI収集の仕組み(ほぼ全自動)**:
  - 自動(X API従量課金 — 月$1.5程度): Xフォロワー数(`/2/users/me` $0.01/回)、Xインプレ/エンゲージメント(`/2/users/{id}/tweets` Owned Read $0.001/件・直近20投稿)
  - 自動(note公開API — 無料): noteフォロワー数・スキ累計(KPI画面でnoteユーザー名を設定すると有効化)
  - 自動(note非公式API — session Cookie必要): note閲覧数PV(`/api/v1/stats/pv`)、メンバー数(`/api/v2/circle/members`)。KPI画面で `_note_session_v5` Cookieを登録すると有効化。低頻度アクセス(1日1回)の個人利用
  - **Cookie失効の自動検知**: 毎朝の収集時に401/403やデータ空を検知すると `note_session_status='expired'` を記録→オフィス画面最上部に赤い通知バナー(「再登録する」ボタン付き)を表示。再登録時は保存前に有効性を自動検証
  - 手動(API非存在): note売上件数・金額(noteダッシュボード目視)、アフィ収益(ASP管理画面目視)。KPI画面の入力フォームで1日30秒で入力
  - UPSERTはCOALESCE方式: 自動収集と手動入力が互いの値を上書きしない
- **データフロー**: 企画承認→Kai翻訳タスク投入 / 投稿承認→Sora予約タスク投入 / 差戻→Yuto書き直しタスク投入(task_queue経由で連鎖)
- **QAロジック**: `src/qa-rules.ts` に禁止表現DB(指示書08章)を実装。API・UI両方から利用

## コンテンツ方針(2回目の修正で反映)
- **素人向け注釈**: 固有名詞初出時に「※KDP=Amazonで誰でも無料で電子書籍を出せる仕組み」形式の1行注釈を必須化(glossaryテーブル+Yutoプロンプトに反映)
- **金額は円換算を先に**: 「月45万円($3,000)」形式
- **リプ誘発枠(枠5・9・12)**: 専門知識ゼロでも答えられる普遍的なお金の質問(「月3万円あったら何に使う?」「副業を始めない理由①〜④」等)を毎日3本配置
- **アフィリエイト運用**: ASP提携申請のみ人間が実施(規約上必須)。リンク登録後は完全自動 — ツール名検出→リンク挿入→PR表記→再QAまでワンボタン/本番ではYuto執筆時に自動実行

## 指示書からの変更点(改善)
元の指示書はAI作成のため、以下を現実的な構成に調整しました:
1. **Cloudflare Queues → D1テーブル(task_queue)**: Queues は Pages では利用不可+有料機能のため、D1で同等のキュー機構を実装(挙動は同一、後からWorkers移行可)
2. **Cron Triggers → GitHub Actions 毎時実行**: Pages では Cron 未対応のため、GitHub Actionsから `/api/cron/run` を毎時呼び出し(毎時10分)。サーバー側で振り分け: JST 5時台=フルパイプライン(1日1回ガード付き)、毎時=Sora自動予約投稿(承認済み+投稿時刻到来分をXへ)。CRON_SECRETのBearer認証で保護
   - **有効化手順(2分・手動)**: GitHub App権限の制約でワークフローの自動配置ができないため、①リポジトリ直下の `github-actions-cron.yml` を `.github/workflows/cron.yml` にリネームして配置(GitHub Web UIの「Add file」でOK)、② Settings → Secrets and variables → Actions で `CRON_SECRET` を登録(値は取締役に別途共有)。それまでは承認画面の手動ボタンで同じ処理を実行可能
3. **LLM/Buffer/note自動投稿は未接続**: APIキー(OpenAI/Buffer)とnote認証情報が必要なため、タスク投入までを実装。キー提供後に接続可能
4. **LLMをAnthropic Claude→OpenAI GPT-5ファミリに変更**: ユーザーのOpenAI APIキーで運用可能に。モデル割当とコスト試算はダッシュボードの「AIコスト」タブで可視化(`src/model-plan.ts` / `/api/models/cost`)
5. **React → CDNベースのVanilla JS SPA**: ビルド構成を単純化し、同一Pagesプロジェクト内でAPI+UIを完結

## AIモデル構成(OpenAI移行プラン)
**OpenAI APIキーで運用可能です(Anthropicキー不要)**。詳細はダッシュボードの「AIコスト」タブ参照。

**品質優先方針(取締役指示)**: コストより情報の質を優先。主要ワーカーをgpt-5+推論(reasoning_effort)に格上げ済み。

| モデル | 担当ワーカー | 推論レベル |
|---|---|---|
| **gpt-5** | Yuto(執筆/noteはhigh) / Riko(選定) / Kai(翻訳) / Rui(分析) / Alex(週次計画はhigh) / Aki(図解設計) | medium中心 |
| **gpt-5-mini** | Nana(日次レポート) / Mio(QA) | low |
| **gpt-5-nano** | Sora(SNS定型作業) | low |

- **試算コスト**: パイプライン1回約$0.5〜1.0(note執筆+分析含む) → 月約$15〜30(約¥2,300〜4,500)。画像生成は増産体制で約$0.3〜0.6/日(X用最大8枚+noteカバー1枚+本文図解最大2枚、QA込み約$0.05/枚)
- 料金・トークン前提は `src/model-plan.ts` に一元管理(変更すればUIに即反映)

### 実LLM接続(稼働中)
- ヘルパー: `src/llm.ts` (fetchのみ使用、Workers完全対応、`reasoning_effort: low` で推論トークンを抑制)
- API: `GET /api/llm/status` / `POST /api/llm/write` (Yuto執筆) / `POST /api/llm/qa` (Mio審査) / `POST /api/posts/:id/rewrite` (Yutoリライト)
- キー管理: ローカル=`.dev.vars`(gitignore済み) / 本番=Workerシークレット `OPENAI_API_KEY`。**キーはコード・Gitに一切含まない**

## 未実装(次の開発ステップ)
- [x] OpenAI API 接続 — Yuto(gpt-5)の実AI執筆/リライト、Mio(gpt-5-mini)の実AI法務審査が稼働中
- [x] Rikoの実LLM化 — RSS/Reddit実巡回 + gpt-5-miniによるネタ選定・日本向けアレンジが稼働中(`src/sources.ts` / `src/riko.ts`)
- [ ] Kaiの実LLM化(翻訳タスクの自動化)
- [x] X API 直接接続 — OAuth1.0a署名実装済み。`X_API_KEY`/`X_API_SECRET`/`X_ACCESS_TOKEN`/`X_ACCESS_TOKEN_SECRET` の4シークレット登録で自動投稿が有効化(未登録時はコピペ半自動運用)
- [x] スレッド自動投稿(P0-1) — weighted 280(日本語140字相当)超えの長文を自動分割しリプライ連結で連投(「1/」番号形式→段落→文の優先順で分割、番号なしは(n/m)自動付与、画像は先頭のみ)。枠4バズスレッド・枠7長文が正しく投稿できる(`postThread`/`splitForThread` in `src/x-api.ts`)
- [x] 枠8アフィリンク自動埋込(P0-2) — パイプラインが枠8(ツール比較)の本文にactiveなアフィリンクを自動埋込+PR表記。**リンク未登録/全pausedなら本文を一切変えずそのまま投稿(検証済み)**。※現在の登録リンクはダミーのため全件paused—実ASP提携後に設定画面から実URL登録で収益化開始
- [x] 投稿別実績の自動書き戻し(P0-3) — KPI収集時に直近50投稿の個別imp/engを取得しbuffer_id(tweet_id)でx_postsに書き戻し。Ruiの枠別分析・売上TOP共通点分析が実データで回る(Owned Read 約$0.05/日)
  - ※Buffer APIは新規開発者受付終了のため、指示書のBuffer経由構成からX API直接接続に変更
- [ ] note Browser Rendering(有料プラン+専用Workerが必要)
- [x] Reddit/RSS の実巡回 — 指示書§04の12 subreddit + 4 RSSフィードを巡回(subredditは日替わり6つローテーション)
- [ ] YouTube/X監視アカウントの巡回(YouTube Data APIキー / X APIキー取得後に有効化)
- [x] 全自動パイプライン(指示書準拠) — 毎朝1回: Riko巡回(10ネタ)→Kai翻訳(上位4ネタのソース深堀り)→Yuto12枠執筆→Mio QA(要修正は自動リライト1回)→ゲート②に12本並ぶ。途中承認なし、取締役の操作は最終の一括承認のみ
- [x] Kaiの実LLM化 — 英語ソース(Redditは本文+上位コメント取得)を深堀り翻訳・要約しYutoの執筆入力に(`src/kai.ts`)
- [x] 認証 — アプリ内メール+パスワード認証(PBKDF2 10万回ハッシュ+30日セッションCookie)。登録は許可メール(d.omori@dissectera.com)のみ。Gensparkサインインは廃止
- [x] 画像生成連携(Aki) — gpt-image-2でブランド準拠画像を生成しR2に保存。「画像」タブで操作
- [x] 画像QA(Mio) — GPT-5 visionで誤字/法令/権利/ブランド準拠を自動審査。生成時に自動実行+再審査ボタン
- [x] Nana(秘書)実装 — 日次レポート(300字)+24h滞留リマインドをパイプライン末尾で自動生成しオフィス画面に表示(`src/nana.ts`)
- [x] Rui(分析)実装 — 日次仮説分析(毎日)+週次7日総括・改善提案3つ(日曜)。提案はAlexの週次計画に自動連携(`src/rui.ts`)
- [x] Alex(PM)実装 — 月曜に週次テーマ分解+曜日別タスク配分。Rui提案を必ず1つ以上組み込み、Yuto執筆に毎日の切り口を注入(`src/alex.ts`)
- [x] note自動執筆(Yuto) — 毎日1本: 平日=無料 / 日曜=有料単発¥100 / 土曜=メンバーシップ(月¥500)限定記事。gpt-5推論highで2000〜4500字。有料はpaywall位置自動設定→ゲート③で有料ライン可視化+Markdownコピー。アフィリンク自動埋め込み付き(`src/note-writer.ts`)
- [x] 月次まとめnote(¥500・主力商品) — 毎月1日に前月の全検証結果+KPI+Rui月次分析を統合し5000〜7000字のまとめnoteを自動生成(gpt-5推論high、導入・概要は無料公開→paywall→詳細・実践手順は有料)。手動実行APIあり(`runMonthlySummaryNote`)
- [x] KPI自動収集 — 毎朝パイプライン先頭でXフォロワー(X API無料枠)+noteフォロワー/スキ(note公開API)を自動取得しkpi_dailyに記録(`src/kpi-collector.ts`)
- [x] Riko競合リサーチ — 毎週月曜にYahoo!リアルタイム検索でAI副業系noteの売れ筋・価格相場を収集分析→Alex週次計画に自動反映(`src/riko.ts`)
- [x] Aki noteカバー画像 — 毎日のnote記事にカバー画像を自動生成しR2保存・ゲート③に添付(`src/aki.ts`)
- [x] Aki枠3図解の自動組み込み — パイプラインが枠3投稿の図解を自動設計→生成→Mio画像QA(NG時は1回再生成)→ゲート②カードにサムネイル表示→X投稿時に画像添付(`src/aki.ts`)
- [x] Aki画像増産体制(1日10枚以上対応) — 全12枠をAkiがLLM判定し必要な枠にのみ生成(最大8枚/日、infographic/thumbnailを使い分け)。Mio(別ワーカー)のQA合格分のみ各X投稿に自動添付(`runAkiImagePlan`)
- [x] Aki有料note本文用図解 — 有料記事の本文から図解を最大2枚設計・生成→Mio QA→記事に紐付け(generated_images.article_id)→ゲート③で表示・DL(`runAkiNoteDiagrams`)
- [x] Rui月次レポート拡張(D-3完了) — 「売上TOP記事の共通点」「価格別CVR」専用セクションを追加。価格帯別のview→購入転換率と収益順TOP5をDB集計して分析材料に注入(`src/rui.ts`)

## 使い方(取締役向け)
1. **オフィス**: 9人の稼働状況を眺める。デスクをクリックすると実行ログが見える
2. **承認**: オレンジのバッジが付いたら承認画面へ。「QA通過分を一括承認」でスマホ5分運用。QA要修正(枠8など)は指摘内容を確認して個別判断
3. **KPI**: フォロワーと売上の推移を確認
4. **QAチェック**: 自分で書いた投稿文を貼ると、Mioが禁止表現を検出(例:「誰でも簡単に稼げる」→ 景表法指摘)。「Mio 実AIチェック」ボタンでGPT-5 miniによる深い審査+書き直し案も取得可能
5. **AI執筆(Yuto)**: QAタブの「Yuto AI執筆スタジオ」でテーマを入れるとGPT-5が注釈・円換算・法令ルールを守った投稿を執筆。承認キューへの追加も可能
6. **AIリライト**: 承認画面でQA要修正の投稿に「Yuto(AI)にリライトさせる」ボタンが出現。指摘を解消した文面に自動書き換え
7. **全自動パイプライン(「朝起きたら全部揃っている」運用)**: 毎朝JST 5時台に KPI自動収集 → [月曜のみ]Riko競合リサーチ+Alex週次計画 → Riko巡回(10ネタ) → Kai上位4ネタ深堀り翻訳 → 話題ツイート収集(日本語・Yahoo!リアルタイム検索) → Yuto12枠執筆(枠6=引用RT、枠11=公開済みnote実URL宣伝・発売モード対応) → Aki画像計画(全12枠を判定→必要な枠に最大8枚生成→Mio QA合格分のみ添付) → note記事1本執筆(日曜=有料¥100・土曜=メンバー限定・毎月1日=月次まとめ¥500) → Aki noteカバー画像生成+有料記事は本文用図解最大2枚 → Rui分析(日曜は週次、毎月1日は月次も。月次は売上TOP記事の共通点+価格別CVR分析付き) → Nana日次レポート。取締役の操作はゲート②の一括承認+ゲート③のnote公開判断のみ
8. **枠6 引用RT(無料実装)**: Yahoo!リアルタイム検索で日本語の話題ツイートを収集(RT×2+リプ数でスコアリング、スパム/挨拶投稿除外、引用済み除外)→Yutoが「僕の視点の気づき」を添えた引用コメントを執筆→承認画面に引用元原文を表示→投稿時は`quote_tweet_id`で本物の引用RTに。投稿直前にoEmbedで引用元の生存確認(削除済みなら通常投稿に自動切替)。候補なしの日は従来型の通常投稿
9. **Sora自動予約投稿**: 毎時cronが承認済み・投稿時刻到来の投稿を自動でXへ(画像添付・引用RT・**長文はスレッド自動分割投稿**対応)。X APIキー未登録の間は何もせずエラーにもならない
10. **リプライ自動返信(P1-4)**: JST 8/12/18/22時にメンションを自動回収($0.001/件・since_id差分取得)→Soraが返信案を生成(gpt-5-mini・スパムはSKIP判定)→Mio QA→ゲート②の「リプライ返信の承認」で承認→毎時cronが自動送信($0.015/件)。キー未登録時は安全にスキップ
11. **投稿時間最適化(P1-5)**: 毎週月曜に直近60日の投稿別実績から枠ごとのベスト時間帯を再計算(デフォルト±2時間内・3投稿以上・10%以上改善の時のみ採用)し、以降の予約時刻に自動反映。実績がない間はデフォルトのまま
12. **高実績投稿リサイクル(P1-6)**: 14日以上前に公開したインプ上位投稿を1日1本、Yutoが新しい切り口でリライトしてゲート②へ(同じ元投稿は1度だけ・引用RT/note告知は対象外)
13. **アフィリンククリック計測**: 自動埋込されるアフィリンクは `/go/:link_id` 経由の計測URLになり、読者が踏むとクリックを記録して実アフィURLへ302リダイレクト。設定画面のリンク一覧に7日/累計クリック数を表示、Ruiの分析にもツール別クリック数が入る(「どの投稿が収益に近づいたか」が見える)
14. **セルフリポスト**: 毎日JST 21時に当日公開済みインプ最上位の投稿を1本自動RT(夜の別オーディエンスに再露出)。同じ投稿は二度とRTしない・1日1本・Xキー未登録なら何もしない
15. **返信承認待ちの可視化**: ヘッダーの承認バッジ・オフィスの承認待ちアラート・Nana日次レポートにリプライ返信の承認待ち件数も含まれる(24時間滞留リマインド対象)
9. **note公開(ゲート③)**: 承認画面で「全文プレビュー」→有料記事はオレンジの破線が有料化ライン。「Markdownをコピー」→noteエディタに貼付→価格(単発¥100/月次まとめ¥500)と有料ラインを設定して公開→アプリの「公開する」ボタンで記録→**公開後にnoteの実URLを登録**(翌日以降の枠11が実URL付き宣伝に切替わる)
10. **KPI入力ルーティン(1日2分)**: KPI画面で ①初回のみnoteユーザー名を設定(自動収集が有効化) ②毎日: Xアナリティクスのインプレとnoteダッシュボードの売上・メンバー数を転記して保存 ③売れた記事は「記事別売上」にも入力(Ruiの分析精度が上がる)
8. **初回ログイン**: 許可メールアドレスと新しいパスワード(8文字以上)で初回登録。2回目以降は同じメール+パスワードでログイン(30日間有効)

## 開発
```bash
npm run build                                          # ビルド
npx wrangler d1 migrations apply xautomation-db --local  # マイグレーション
npx wrangler d1 execute xautomation-db --local --file=./seed.sql  # シード
pm2 start ecosystem.config.cjs                         # 起動(port 3000)
```

## デプロイ
- **プラットフォーム**: Cloudflare Workers(Genspark管理ホスティング / Workers for Platform)
- **ステータス**: ✅ 本番稼働中
- **DB**: 管理D1(スキーマ+シードデータ適用済み)
- **技術スタック**: Hono + TypeScript + D1(SQLite) + TailwindCSS(CDN) + Chart.js
- **最終更新**: 2026-08-19(運用方針改修: ツリー廃止→長文1投稿完結型(Premium 25,000字)、人間らしい文体+AI表現QA検出、メンバーシップ休止、フォロワー最優先ロードマップ)
