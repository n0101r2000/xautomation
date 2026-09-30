/* Virtual Office SPA */
const $app = document.getElementById('app');
let currentView = 'office';
let officeTimer = null;
let kpiChart = null;

const STATUS_JA = { idle: '待機中', working: '作業中', error: 'エラー' };
const STATUS_CLS = {
  idle: 'bg-white',
  working: 'bg-blue-50 border-blue-300 desk-working',
  error: 'bg-red-50 border-red-300 desk-error'
};
const DOT_CLS = { idle: 'bg-gray-300', working: 'bg-blue-500', error: 'bg-red-500' };
const GATE_JA = { weekly_planning: '週次企画', daily_posts: '日次投稿', paid_note: '有料note' };
const SLOT_NAMES = ['', '朝のニュース速報', '1日の予告', 'ノウハウ図解', 'バズ狙いスレッド', '昼休みTips', '引用RT', 'ケーススタディ分解', 'ツール比較・アフィ', '質問投げかけ', '実践報告・失敗談', 'note告知', '深夜の一言'];
const SLOT_TIMES = ['', '06:30', '07:30', '09:00', '11:00', '12:15', '14:00', '16:00', '18:00', '19:30', '21:00', '22:30', '23:30'];

// 実際の予約時刻(scheduled_atはUTC保存)をJST表示。P1-5の時間最適化でデフォルトとずれても正しく出る
 function slotTimeLabel(p) {
  if (p && p.scheduled_at) {
    const d = new Date(p.scheduled_at.replace(' ', 'T') + 'Z');
    if (!isNaN(d.getTime())) {
      const j = new Date(d.getTime() + 9 * 3600 * 1000);
      return `${String(j.getUTCHours()).padStart(2, '0')}:${String(j.getUTCMinutes()).padStart(2, '0')}`;
    }
  }
  return SLOT_TIMES[p?.slot_number] || '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// Xのweighted文字数(サーバ側 xWeightedLength と同じロジック): CJK=2, ASCII=1, URL=23固定、上陥0280
const X_WEIGHT_LIMIT = 280;
function xWeightedLength(text) {
  let weight = 0;
  const withoutUrls = String(text || '').replace(/https?:\/\/[^\s]+/g, () => { weight += 23; return ''; });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) || 0;
    if ((cp >= 0x0000 && cp <= 0x10ff) || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037)) weight += 1;
    else weight += 2;
  }
  return weight;
}

function summarizeManualRun(api, d) {
  if (d.skippedNoCreds || d.replies?.collect?.skippedNoCreds) return 'Xキー未設定のためスキップしました';
  if (api === '/api/riko/crawl') return `${d.collected ?? 0}件収集 → ネタ${d.inserted ?? 0}件投入`;
  if (api === '/api/pipeline/run') return `ネタ${d.riko?.inserted ?? 0}件 → 翻訳${d.kai?.translated ?? 0}本 → 投稿${d.yuto?.postsCreated ?? 0}本生成($${(d.totalCostUsd || 0).toFixed(3)})`;
  if (api === '/api/sora/publish-due') return d.published > 0 ? `${d.published}件をXに投稿しました` : '時刻到来の投稿はありませんでした';
  if (api === '/api/replies/collect') return `メンション${d.fetched ?? 0}件回収 → 返信案${d.drafted ?? 0}件生成(承認画面へ)`;
  if (api === '/api/replies/publish') return d.published > 0 ? `${d.published}件の返信を送信しました` : '送信対象の承認済み返信はありませんでした';
  if (api === '/api/selfrepost/run') return d.reposted ? `インプ${d.impressions ?? '-'}の投稿をセルフRTしました` : (d.error || '本日は対象なし(公開済み投稿なし or 実行済み)');
  if (api === '/api/kpi/collect') return `KPI収集完了(Xフォロワー${d.xFollowers ?? '未取得'})`;
  return '完了しました';
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `fade-in px-4 py-3 rounded-lg shadow-lg text-white text-sm ${type === 'success' ? 'bg-emerald-600' : 'bg-red-600'}`;
  el.innerHTML = `<i class="fas ${type === 'success' ? 'fa-check' : 'fa-triangle-exclamation'} mr-2"></i>${esc(msg)}`;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function setNav(view) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

async function updateApprovalBadge() {
  try {
    const { data } = await axios.get('/api/office');
    const total = (data.pending_approvals || []).reduce((s, r) => s + r.cnt, 0) + (data.pending_replies || 0);
    const badge = document.getElementById('approval-badge');
    if (total > 0) { badge.textContent = total; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  } catch (e) { /* noop */ }
}

/* ============ オフィスビュー ============ */
async function renderOffice() {
  const { data } = await axios.get('/api/office');
  const { workers, tasks, kpi_today, kpi_yesterday, pending_approvals, pending_replies, recent_logs, note_session } = data;
  let nanaReport = null;
  let weekPlan = null;
  try { nanaReport = (await axios.get('/api/reports/daily')).data.reports?.[0] || null; } catch (e) {}
  try { weekPlan = (await axios.get('/api/plans/weekly')).data.plans?.[0] || null; } catch (e) {}

  const followerDelta = kpi_today && kpi_yesterday ? kpi_today.x_followers - kpi_yesterday.x_followers : 0;
  const revenueToday = kpi_today ? (kpi_today.note_paid_sales || 0) + (kpi_today.affiliate_revenue || 0) : 0;

  const pendingTotal = (pending_approvals || []).reduce((s, r) => s + r.cnt, 0) + (pending_replies || 0);

  $app.innerHTML = `
  <div class="fade-in space-y-6">
    ${note_session?.status === 'expired' ? `
    <section id="note-session-alert" class="bg-red-50 border border-red-300 rounded-xl p-4 flex items-center justify-between flex-wrap gap-2">
      <div class="flex items-center gap-3">
        <i class="fas fa-triangle-exclamation text-red-500 text-xl"></i>
        <div>
          <p class="font-bold text-red-700">noteログインCookieが失効しています</p>
          <p class="text-xs text-slate-500">note閲覧数・メンバー数の自動収集が止まっています(最終確認: ${esc(note_session.checked_at || '-')})。ブラウザでnoteに再ログインしてCookieを再登録してください</p>
        </div>
      </div>
      <button onclick="navigate('kpi')" class="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90"><i class="fas fa-key mr-1"></i>再登録する</button>
    </section>` : ''}
    ${pendingTotal > 0 ? `
    <section id="approval-alert" class="bg-orange-50 border border-orange-300 rounded-xl p-4 flex items-center justify-between flex-wrap gap-2">
      <div class="flex items-center gap-3">
        <i class="fas fa-bell text-brand-orange text-xl"></i>
        <div>
          <p class="font-bold text-brand-navy">承認待ちが ${pendingTotal} 件あります</p>
          <p class="text-xs text-slate-500">${[...(pending_approvals || []).map((r) => `${GATE_JA[r.gate_type] || r.gate_type}: ${r.cnt}件`), ...(pending_replies ? [`リプライ返信: ${pending_replies}件`] : [])].join(' / ')}</p>
        </div>
      </div>
      <button onclick="navigate('approve')" class="bg-brand-orange text-white px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90">承認画面へ</button>
    </section>` : ''}

    <section id="office-floor">
      <div class="flex items-center justify-between mb-3">
        <h2 class="font-bold text-lg text-brand-navy"><i class="fas fa-building mr-2"></i>オフィスフロア</h2>
      </div>
      <div id="manual-run-panel" class="bg-white rounded-xl shadow p-3 mb-3">
        <p class="text-xs font-bold text-brand-navy mb-2"><i class="fas fa-bolt mr-1 text-brand-orange"></i>手動実行（時間を待たずワーカーを今すぐ動かす）</p>
        <div class="flex flex-wrap gap-2 text-xs">
          <button class="manual-run-btn bg-brand-navy text-white px-3 py-1.5 rounded-lg hover:opacity-90" data-api="/api/riko/crawl" data-timeout="180000" data-label="Rikoネタ巡回" data-confirm="Rikoのネタ巡回を実行します（30〜60秒）。よろしいですか？"><i class="fas fa-satellite-dish mr-1"></i>Rikoネタ巡回</button>
          <button class="manual-run-btn bg-brand-orange text-white px-3 py-1.5 rounded-lg hover:opacity-90" data-api="/api/pipeline/run" data-timeout="900000" data-label="フルパイプライン" data-confirm="フルパイプライン（Riko→Kai→Yuto→Mio）を実行します。5〜10分・約$0.2かかります。よろしいですか？"><i class="fas fa-robot mr-1"></i>フルパイプライン</button>
          <button class="manual-run-btn bg-black text-white px-3 py-1.5 rounded-lg hover:opacity-80" data-api="/api/sora/publish-due" data-timeout="120000" data-label="予約分を今すぐ投稿" data-confirm="予約時刻が到来している承認済み投稿を今すぐXに送信します。よろしいですか？"><i class="fab fa-x-twitter mr-1"></i>予約分を今すぐ投稿</button>
          <button class="manual-run-btn bg-sky-600 text-white px-3 py-1.5 rounded-lg hover:opacity-90" data-api="/api/replies/collect" data-timeout="180000" data-label="メンション回収" data-confirm="メンションを回収して返信案を生成します（X APIのRead課金が発生）。よろしいですか？"><i class="fas fa-at mr-1"></i>メンション回収</button>
          <button class="manual-run-btn bg-emerald-600 text-white px-3 py-1.5 rounded-lg hover:opacity-90" data-api="/api/replies/publish" data-timeout="120000" data-label="承認済み返信を送信" data-confirm="承認済みの返信を今すぐ送信します。よろしいですか？"><i class="fas fa-reply mr-1"></i>承認済み返信を送信</button>
          <button class="manual-run-btn bg-purple-600 text-white px-3 py-1.5 rounded-lg hover:opacity-90" data-api="/api/selfrepost/run" data-timeout="120000" data-label="セルフRT" data-confirm="今日の公開済み投稿からインプ上位をセルフRTします（1日1回まで）。よろしいですか？"><i class="fas fa-retweet mr-1"></i>セルフRT</button>
          <button class="manual-run-btn bg-slate-600 text-white px-3 py-1.5 rounded-lg hover:opacity-90" data-api="/api/kpi/collect" data-timeout="120000" data-label="KPI収集" data-confirm="X/noteのKPIを今すぐ収集します（X APIのRead課金が発生）。よろしいですか？"><i class="fas fa-chart-line mr-1"></i>KPI収集</button>
        </div>
        <p id="manual-run-result" class="text-[11px] text-slate-500 mt-2"></p>
      </div>
      <div class="bg-gradient-to-br from-slate-200 to-slate-300 rounded-2xl p-5">
        <!-- 取締役デスク(上座) -->
        <div class="flex justify-center mb-5">
          <article class="bg-brand-navy text-white rounded-xl px-8 py-4 shadow-lg text-center border-2 border-brand-orange">
            <div class="text-3xl">🪑</div>
            <div class="font-bold">取締役(あなた)</div>
            <div class="text-xs text-slate-300">承認のみ担当 — 平日6分/日</div>
          </article>
        </div>
        <!-- 9ワーカー -->
        <div id="worker-grid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          ${workers.map((w) => `
          <article class="worker-desk cursor-pointer rounded-xl border-2 p-3 shadow transition hover:scale-[1.03] ${STATUS_CLS[w.status] || 'bg-white'}" data-worker="${esc(w.worker_name)}">
            <div class="flex items-start justify-between">
              <span class="text-3xl">${w.icon}</span>
              <span class="status-dot ${DOT_CLS[w.status] || 'bg-gray-300'}"></span>
            </div>
            <div class="font-bold mt-1">${esc(w.display_name)}</div>
            <div class="text-[11px] text-slate-500">${esc(w.role)}</div>
            <div class="text-xs mt-2 text-slate-700 leading-snug min-h-[2rem]">${esc(w.current_task)}</div>
            <div class="text-[10px] mt-1 font-bold ${w.status === 'working' ? 'text-blue-600' : w.status === 'error' ? 'text-red-600' : 'text-slate-400'}">${STATUS_JA[w.status] || w.status}</div>
          </article>`).join('')}
        </div>
      </div>
    </section>

    ${nanaReport ? `
    <section id="nana-report" class="bg-white rounded-xl shadow p-4 border-l-4 ${nanaReport.stale_pending > 0 ? 'border-amber-400' : 'border-brand-navy'}">
      <div class="flex items-center justify-between mb-2">
        <h3 class="font-bold text-brand-navy"><span class="text-xl mr-1">📋</span>Nanaの日次レポート <span class="text-xs text-slate-400 font-normal ml-2">${esc(nanaReport.report_date)}</span></h3>
        ${nanaReport.stale_pending > 0 ? `<span class="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full font-bold"><i class="fas fa-triangle-exclamation mr-1"></i>24h超滞留 ${nanaReport.stale_pending}件</span>` : ''}
      </div>
      <div class="text-sm whitespace-pre-wrap leading-relaxed text-slate-700">${esc(nanaReport.body_md)}</div>
    </section>` : ''}

    ${weekPlan ? `
    <section id="weekly-plan" class="bg-white rounded-xl shadow p-4">
      <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 class="font-bold text-brand-navy"><span class="text-xl mr-1">🧑‍💼</span>Alexの今週の計画 <span class="text-xs text-slate-400 font-normal ml-2">${esc(weekPlan.week_start)}週</span></h3>
        <button id="toggle-plan-btn" class="text-xs text-brand-navy underline">詳細を見る</button>
      </div>
      <p class="text-sm font-bold text-brand-orange mb-2">テーマ: ${esc(weekPlan.theme)}</p>
      ${(() => { let ts = []; try { ts = JSON.parse(weekPlan.tasks_json || '[]'); } catch (e) {} return ts.length ? `<div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-1.5 text-[11px]">${ts.map((t) => `<div class="bg-slate-50 rounded-lg p-2"><div class="font-bold text-brand-navy">${esc(t.day)}曜</div><div class="text-slate-600 mt-0.5">${esc(t.x_focus || '')}</div></div>`).join('')}</div>` : ''; })()}
      <div id="plan-detail" class="hidden mt-3 text-sm whitespace-pre-wrap leading-relaxed text-slate-700 border-t pt-3">${esc(weekPlan.body_md)}</div>
    </section>` : ''}

    <div class="grid md:grid-cols-3 gap-4">
      <section id="kpi-summary" class="bg-white rounded-xl shadow p-4">
        <h3 class="font-bold text-brand-navy mb-3"><i class="fas fa-gauge mr-2"></i>本日のKPI</h3>
        ${kpi_today ? `
        <ul class="space-y-2 text-sm">
          <li class="flex justify-between"><span>Xフォロワー</span><span class="font-bold">${kpi_today.x_followers.toLocaleString()} <span class="${followerDelta >= 0 ? 'text-emerald-600' : 'text-red-500'} text-xs">(${followerDelta >= 0 ? '+' : ''}${followerDelta})</span></span></li>
          <li class="flex justify-between"><span>インプレッション</span><span class="font-bold">${(kpi_today.x_impressions_total || 0).toLocaleString()}</span></li>
          <li class="flex justify-between"><span>本日売上</span><span class="font-bold text-brand-orange">¥${revenueToday.toLocaleString()}</span></li>
          <li class="flex justify-between"><span>メンバーシップ</span><span class="font-bold">${kpi_today.membership_count}人(¥${(kpi_today.membership_revenue || 0).toLocaleString()}/月)</span></li>
        </ul>` : '<p class="text-sm text-slate-400">データなし</p>'}
        <button onclick="navigate('kpi')" class="mt-3 text-xs text-brand-navy underline">詳細グラフを見る →</button>
      </section>

      <section id="task-board" class="bg-white rounded-xl shadow p-4">
        <h3 class="font-bold text-brand-navy mb-3"><i class="fas fa-list-check mr-2"></i>タスクボード</h3>
        <ul class="space-y-2 text-xs max-h-52 overflow-y-auto">
          ${tasks.length ? tasks.map((t) => `
          <li class="flex items-center gap-2 border-b border-slate-100 pb-1.5">
            <span class="px-1.5 py-0.5 rounded font-bold ${t.status === 'processing' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}">${t.status === 'processing' ? '処理中' : '待機'}</span>
            <span class="font-bold text-brand-navy">${esc(t.worker_name)}</span>
            <span class="text-slate-600 truncate">${esc(t.task_type)}</span>
          </li>`).join('') : '<li class="text-slate-400">キューは空です</li>'}
        </ul>
      </section>

      <section id="activity-log" class="bg-white rounded-xl shadow p-4">
        <h3 class="font-bold text-brand-navy mb-3"><i class="fas fa-clock-rotate-left mr-2"></i>直近のアクティビティ</h3>
        <ul class="space-y-2 text-xs max-h-52 overflow-y-auto">
          ${recent_logs.map((l) => `
          <li class="flex items-start gap-2 border-b border-slate-100 pb-1.5">
            <i class="fas ${l.status === 'success' ? 'fa-circle-check text-emerald-500' : l.status === 'running' ? 'fa-spinner text-blue-500' : 'fa-circle-xmark text-red-500'} mt-0.5"></i>
            <div><span class="font-bold text-brand-navy">${esc(l.worker_name)}</span> <span class="text-slate-600">${esc(l.action)}</span></div>
          </li>`).join('')}
        </ul>
      </section>
    </div>
  </div>`;

  document.querySelectorAll('.worker-desk').forEach((el) => {
    el.addEventListener('click', () => openWorkerModal(el.dataset.worker));
  });
  document.querySelectorAll('.manual-run-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.confirm && !confirm(btn.dataset.confirm)) return;
      const orig = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>実行中...';
      const resultEl = document.getElementById('manual-run-result');
      try {
        const { data } = await axios.post(btn.dataset.api, {}, { timeout: Number(btn.dataset.timeout || 120000) });
        const summary = summarizeManualRun(btn.dataset.api, data);
        toast(`${btn.dataset.label}: ${summary}`);
        if (resultEl) resultEl.textContent = `✓ ${btn.dataset.label} — ${summary}`;
        if (currentView === 'office') renderOffice();
        updateApprovalBadge();
      } catch (e) {
        const msg = e.response?.data?.error || e.response?.data?.errors?.join(' / ') || e.message || '実行に失敗しました';
        toast(`${btn.dataset.label}: ${msg}`, 'error');
        if (resultEl) resultEl.textContent = `✗ ${btn.dataset.label} — ${msg}`;
        btn.disabled = false; btn.innerHTML = orig;
      }
    });
  });
  document.getElementById('toggle-plan-btn')?.addEventListener('click', () => {
    document.getElementById('plan-detail')?.classList.toggle('hidden');
  });
}

async function openWorkerModal(name) {
  const { data } = await axios.get(`/api/workers/${name}`);
  const { worker, logs } = data;
  const root = document.getElementById('modal-root');
  root.innerHTML = `
  <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onclick="if(event.target===this)this.parentNode.innerHTML=''">
    <div class="bg-white rounded-2xl max-w-lg w-full max-h-[80vh] overflow-y-auto shadow-2xl fade-in">
      <div class="bg-brand-navy text-white p-4 rounded-t-2xl flex items-center gap-3 sticky top-0">
        <span class="text-4xl">${worker.icon}</span>
        <div class="flex-1">
          <div class="font-bold text-lg">${esc(worker.display_name)}</div>
          <div class="text-xs text-slate-300">${esc(worker.role)}</div>
        </div>
        <button onclick="document.getElementById('modal-root').innerHTML=''" class="text-white/70 hover:text-white text-xl"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="p-4 space-y-3">
        <div class="bg-slate-50 rounded-lg p-3 text-sm">
          <span class="status-dot ${DOT_CLS[worker.status]} mr-2"></span>
          <span class="font-bold">${STATUS_JA[worker.status]}</span> — ${esc(worker.current_task)}
        </div>
        <h4 class="font-bold text-sm text-brand-navy">実行ログ</h4>
        <ul class="space-y-2 text-xs">
          ${logs.length ? logs.map((l) => `
          <li class="border border-slate-200 rounded-lg p-2">
            <div class="flex items-center gap-2">
              <i class="fas ${l.status === 'success' ? 'fa-circle-check text-emerald-500' : l.status === 'running' ? 'fa-spinner fa-spin text-blue-500' : 'fa-circle-xmark text-red-500'}"></i>
              <span class="font-bold">${esc(l.action)}</span>
            </div>
            <div class="text-slate-400 mt-1">${esc(l.started_at)}${l.output_json ? ' / ' + esc(l.output_json) : ''}</div>
          </li>`).join('') : '<li class="text-slate-400">ログはまだありません</li>'}
        </ul>
      </div>
    </div>
  </div>`;
}

/* ============ 承認ビュー ============ */
async function renderApprove() {
  let xStatus = { connected: false };
  let cronStatus = null;
  const [postsRes, topicsRes, notesRes, approvedRes] = await Promise.all([
    axios.get('/api/posts?status=pending'),
    axios.get('/api/topics?status=pending'),
    axios.get('/api/notes'),
    axios.get('/api/posts?status=approved')
  ]);
  let replies = [];
  try { replies = (await axios.get('/api/replies?status=pending')).data.replies || []; } catch (e) {}
  try { xStatus = (await axios.get('/api/x/status')).data; } catch (e) {}
  try { cronStatus = (await axios.get('/api/cron/status')).data; } catch (e) {}
  const posts = postsRes.data.posts;
  const topics = topicsRes.data.topics;
  const notes = notesRes.data.articles.filter((a) => a.approval_status === 'pending');
  const approvedPosts = (approvedRes.data.posts || []).filter((p) => !p.published_at);

  $app.innerHTML = `
  <div class="fade-in space-y-8">
    <section id="gate-daily">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h2 class="font-bold text-lg text-brand-navy"><i class="fas fa-calendar-day mr-2"></i>ゲート② 明日のX投稿承認(${posts.length}本)</h2>
        ${posts.length ? `<button id="approve-all-btn" class="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90"><i class="fas fa-check-double mr-1"></i>QA通過分を一括承認</button>` : ''}
      </div>
      ${posts.length ? `<div class="grid md:grid-cols-2 gap-3">${posts.map(postCard).join('')}</div>`
        : `<p class="bg-white rounded-xl p-6 text-center text-slate-400 text-sm">承認待ちの投稿はありません 🎉<br>
           <button id="pipeline-run-btn" class="mt-3 bg-brand-orange text-white px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90"><i class="fas fa-robot mr-1"></i>パイプラインを今すぐ実行(Riko→Kai→Yuto→Mio)</button></p>`}
    </section>

    <section id="gate-replies">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h2 class="font-bold text-lg text-brand-navy"><i class="fas fa-reply mr-2"></i>リプライ返信の承認(${replies.length}件)</h2>
        ${replies.length ? `<button id="approve-all-replies-btn" class="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90"><i class="fas fa-check-double mr-1"></i>QA通過分を一括承認</button>` : ''}
      </div>
      ${replies.length ? `<div class="grid md:grid-cols-2 gap-3">${replies.map(replyCard).join('')}</div>`
        : `<p class="bg-white rounded-xl p-6 text-center text-slate-400 text-sm">承認待ちの返信はありません${xStatus.connected ? '' : '(X API接続後、メンションを自動回収して返信案をここに並べます)'}</p>`}
    </section>

    <section id="gate-weekly">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h2 class="font-bold text-lg text-brand-navy"><i class="fas fa-lightbulb mr-2"></i>ゲート① 週次企画の選定(${topics.length}案)</h2>
        <button id="riko-crawl-btn" class="bg-brand-navy text-white px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90"><i class="fas fa-satellite-dish mr-1"></i>Riko巡回のみ実行</button>
      </div>
      <p class="text-xs text-slate-500 mb-2"><i class="fas fa-circle-info mr-1"></i>日次の投稿生成はパイプラインが自動で進行します(ここでの承認は不要)。このゲートは週次企画(noteテーマ等)の選定用です</p>
      ${topics.length ? `<div class="grid md:grid-cols-2 gap-3">${topics.map(topicCard).join('')}</div>`
        : '<p class="bg-white rounded-xl p-6 text-center text-slate-400 text-sm">選定待ちの企画はありません</p>'}
    </section>

    <section id="gate-note">
      <h2 class="font-bold text-lg text-brand-navy mb-3"><i class="fas fa-file-lines mr-2"></i>ゲート③ 有料note公開承認(${notes.length}本)</h2>
      ${notes.length ? notes.map(noteCard).join('')
        : '<p class="bg-white rounded-xl p-6 text-center text-slate-400 text-sm">公開待ちのnote記事はありません</p>'}
    </section>

    <section id="publish-x">
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        <h2 class="font-bold text-lg text-brand-navy"><i class="fab fa-x-twitter mr-2"></i>承認済み → Xへ投稿(${approvedPosts.length}本)</h2>
        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs ${xStatus.connected ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">
          <span class="w-2 h-2 rounded-full ${xStatus.connected ? 'bg-emerald-500' : 'bg-slate-400'}"></span>
          X API ${xStatus.connected ? '接続中' : '未接続'}
        </span>
      </div>
      ${!xStatus.connected ? `<div class="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-slate-700 mb-3">
        <p class="font-bold text-brand-navy mb-1"><i class="fas fa-circle-info mr-1"></i>X API未接続のため、現在は「コピーして投稿」の半自動運用です</p>
        <p class="text-xs">完全自動化には <a href="https://developer.x.com" target="_blank" class="text-blue-600 underline">developer.x.com</a> でアプリ登録し、4つのキー(API Key/Secret、Access Token/Secret)をシークレット登録してください。</p>
      </div>` : ''}
      ${approvedPosts.length ? `<div class="grid md:grid-cols-2 gap-3">${approvedPosts.map((p) => `
      <article class="bg-white rounded-xl shadow p-4 flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-brand-navy bg-slate-100 px-2 py-1 rounded">枠${p.slot_number} ${slotTimeLabel(p)}</span>
          ${qaBadge(p.qa_status, p.qa_issues)}
        </div>
        <p class="text-sm whitespace-pre-wrap leading-relaxed flex-1">${esc(p.body)}</p>
        <div class="flex gap-2 pt-1">
          <button class="copy-post-btn flex-1 bg-slate-100 text-slate-700 py-1.5 rounded-lg text-xs font-bold hover:bg-slate-200" data-body="${esc(p.body).replace(/"/g, '&quot;')}"><i class="fas fa-copy mr-1"></i>コピーして投稿</button>
          ${xStatus.connected ? `<button class="publish-x-btn flex-1 bg-black text-white py-1.5 rounded-lg text-xs font-bold hover:opacity-80" data-id="${esc(p.post_id)}"><i class="fab fa-x-twitter mr-1"></i>Xへ自動投稿</button>` : ''}
        </div>
      </article>`).join('')}</div>`
        : '<p class="bg-white rounded-xl p-6 text-center text-slate-400 text-sm">X投稿待ちの承認済み投稿はありません</p>'}
    </section>

    <section id="cron-cycle">
      <h2 class="font-bold text-lg text-brand-navy mb-3"><i class="fas fa-clock-rotate-left mr-2"></i>自動サイクル(Cron)</h2>
      <div class="bg-white rounded-xl shadow p-4 text-sm space-y-3">
        <div class="flex items-center gap-3 flex-wrap">
          <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs ${cronStatus?.secretConfigured ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">
            <span class="w-2 h-2 rounded-full ${cronStatus?.secretConfigured ? 'bg-emerald-500' : 'bg-amber-500'}"></span>
            定時実行 ${cronStatus?.secretConfigured ? '設定済み' : '未設定(手動ボタンは利用可)'}
          </span>
          <span class="text-xs text-slate-500">🌅 毎朝1回: NanaのKPI自動収集 → [月]Riko競合リサーチ+Alex週次計画 → Riko巡回 → Kai翻訳 → Yuto12枠執筆+Aki図解 → note執筆(日=有料¥100/土=メンバー限定/毎月1日=月次まとめ¥500)+Akiカバー画像 → Rui分析 → Nanaレポート / ⏰毎時: Sora自動投稿+承認済みリプライ送信 / 🔁8・12・18・22時: メンション回収→返信案生成 / 📊毎週月曜: 投稿時間最適化 / ♻️毎日: 高実績投稿リサイクル</span>
        </div>
        ${cronStatus?.recentRuns?.length ? `
        <div class="overflow-x-auto"><table class="w-full text-xs">
          <thead><tr class="text-left text-slate-400 border-b"><th class="py-1 pr-3">日時</th><th class="py-1 pr-3">ワーカー</th><th class="py-1 pr-3">処理</th><th class="py-1 pr-3">結果</th><th class="py-1">詳細</th></tr></thead>
          <tbody>${cronStatus.recentRuns.map((r) => {
            let d = {}; try { d = JSON.parse(r.output_json || '{}'); } catch (e) {}
            const WORKER_JA = { alex: 'Alex', riko: 'Riko', kai: 'Kai', yuto: 'Yuto', aki: 'Aki', sora: 'Sora', rui: 'Rui', nana: 'Nana', mio: 'Mio' };
            const ACTION_JA = { weekly_plan: '週次計画', auto_crawl: '巡回(自動)', manual_crawl: '巡回(手動)', auto_translate: '翻訳', auto_write: 'X執筆', auto_note: 'note執筆', auto_qa: 'QA審査', auto_infographic: '図解生成', daily_analysis: '日次分析', weekly_analysis: '週次分析', monthly_analysis: '月次分析', daily_report: '日次レポート', quote_crawl: '話題ツイート収集', auto_publish: '自動投稿', x_publish: 'X投稿(手動)', kpi_collect: 'KPI自動収集', competitor_research: '競合リサーチ', monthly_note: '月次まとめnote', note_cover: 'noteカバー画像', mention_collect: 'メンション回収', reply_publish: 'リプライ返信', slot_optimize: '投稿時間最適化', post_recycle: '投稿リサイクル', self_repost: 'セルフRT' };
            let detail = '';
            if (r.action === 'mention_collect') detail = `メンション${d.fetched ?? 0}件 → 返信案${d.drafted ?? 0}件生成${d.costUsd ? ` ($${d.costUsd.toFixed(4)})` : ''}`;
            else if (r.action === 'slot_optimize') detail = `実績${d.analyzed ?? 0}投稿を分析${d.changes?.length ? ` 変更: ${d.changes.join(' / ').slice(0, 60)}` : '(変更なし)'}`;
            else if (r.action === 'post_recycle') detail = `インプ${d.sourceImpressions ?? '-'}の投稿をリライト${d.costUsd ? ` ($${d.costUsd.toFixed(4)})` : ''}`;
            else if (r.action === 'self_repost') detail = `インプ${d.impressions ?? '-'}の投稿をセルフRT`;
            else if (r.worker_name === 'riko') detail = `収集${d.collected ?? '-'}件 → ネタ${d.inserted ?? '-'}件投入${d.costUsd ? ` ($${d.costUsd.toFixed(4)})` : ''}`;
            else if (r.worker_name === 'kai') detail = `翻訳${d.translated ?? '-'}本${d.costUsd ? ` ($${d.costUsd.toFixed(4)})` : ''}`;
            else if (r.worker_name === 'mio') detail = `審査${d.checked ?? '-'}本(OK ${d.ok ?? 0} / 要修正 ${d.needsFix ?? 0} / NG ${d.ng ?? 0})`;
            else if (r.worker_name === 'alex') detail = `テーマ:${d.theme ? esc(d.theme).slice(0, 30) : '-'}${d.costUsd ? ` ($${d.costUsd.toFixed(4)})` : ''}`;
            else if (r.worker_name === 'aki') detail = `図解「${d.title ? esc(d.title) : '-'}」 QA:${d.qaStatus || '-'}${d.costUsd ? ` ($${d.costUsd.toFixed(4)})` : ''}`;
            else if (r.worker_name === 'rui') detail = `分析完了${d.proposals != null ? ` 提案${d.proposals}つ` : ''}${d.costUsd ? ` ($${d.costUsd.toFixed(4)})` : ''}`;
            else if (r.action === 'kpi_collect') detail = `Xフォロワー${d.xFollowers ?? '未取得'} / noteフォロワー${d.noteFollowers ?? '未取得'}`;
            else if (r.worker_name === 'nana') detail = `承認待ち${d.pending ?? '-'}件 / 滞留${d.stale ?? 0}件${d.costUsd ? ` ($${d.costUsd.toFixed(4)})` : ''}`;
            else if (r.action === 'auto_note') detail = `note「${d.title ? esc(d.title).slice(0, 25) : '-'}」(${d.type === 'paid_single' ? '有料¥100' : d.type === 'membership' ? 'メンバー限定' : '無料'}) QA:${d.qaStatus || '-'}${d.costUsd ? ` ($${d.costUsd.toFixed(4)})` : ''}`;
            else if (r.action === 'monthly_note') detail = `月次まとめ「${d.title ? esc(d.title).slice(0, 25) : '-'}」(¥500) QA:${d.qaStatus || '-'}${d.costUsd ? ` ($${d.costUsd.toFixed(4)})` : ''}`;
            else detail = `投稿${d.postsCreated ?? '-'}本生成${d.costUsd ? ` ($${d.costUsd.toFixed(4)})` : ''}`;
            return `<tr class="border-b border-slate-50"><td class="py-1 pr-3 text-slate-500">${esc((r.finished_at || '').slice(5, 16))}</td><td class="py-1 pr-3 font-bold">${WORKER_JA[r.worker_name] || r.worker_name}</td><td class="py-1 pr-3">${ACTION_JA[r.action] || r.action}</td><td class="py-1 pr-3">${r.status === 'success' ? '<span class="text-emerald-600">成功</span>' : '<span class="text-red-500">失敗</span>'}</td><td class="py-1 text-slate-500">${esc(detail)}</td></tr>`;
          }).join('')}</tbody>
        </table></div>` : '<p class="text-xs text-slate-400">まだ自動サイクルの実行履歴がありません</p>'}
      </div>
    </section>
  </div>`;

  document.getElementById('riko-crawl-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('riko-crawl-btn');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>巡回中(30〜60秒)...';
    try {
      const { data } = await axios.post('/api/riko/crawl', {}, { timeout: 180000 });
      toast(`Riko巡回完了: ${data.collected}件収集 → ${data.inserted}件のネタを投入しました`);
      renderApprove(); updateApprovalBadge();
    } catch (e) {
      toast(e.response?.data?.error || '巡回に失敗しました', 'error');
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-satellite-dish mr-1"></i>Riko巡回のみ実行';
    }
  });

  document.getElementById('pipeline-run-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('pipeline-run-btn');
    if (!confirm('フルパイプライン(Riko巡回→Kai翻訳→Yuto12枠執筆→Mio QA)を実行します。所要時間は5〜10分、コストは約$0.2です。よろしいですか？')) return;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>実行中(5〜10分、このままお待ちください)...';
    try {
      const { data } = await axios.post('/api/pipeline/run', {}, { timeout: 900000 });
      toast(`パイプライン完了: ネタ${data.riko.inserted}件 → 翻訳${data.kai.translated}本 → 投稿${data.yuto.postsCreated}本生成($${(data.totalCostUsd || 0).toFixed(3)})`);
      renderApprove(); updateApprovalBadge();
    } catch (e) {
      toast(e.response?.data?.error || 'パイプライン実行に失敗しました', 'error');
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-robot mr-1"></i>パイプラインを今すぐ実行(Riko→Kai→Yuto→Mio)';
    }
  });

  document.querySelectorAll('.copy-post-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(btn.dataset.body);
      toast('コピーしました。Xアプリに貼り付けて投稿してください');
      window.open('https://x.com/compose/post', '_blank');
    });
  });

  document.querySelectorAll('.publish-x-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('この投稿を今すぐXに公開します。よろしいですか？')) return;
      btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>投稿中...';
      try {
        const { data } = await axios.post(`/api/posts/${btn.dataset.id}/publish-x`, {}, { timeout: 60000 });
        toast(`Xへ投稿しました${data.with_image ? '(画像付き)' : ''}`);
        window.open(data.tweet_url, '_blank');
        renderApprove();
      } catch (e) {
        toast(e.response?.data?.error || '投稿に失敗しました', 'error');
        btn.disabled = false; btn.innerHTML = '<i class="fab fa-x-twitter mr-1"></i>Xへ自動投稿';
      }
    });
  });

  document.getElementById('approve-all-btn')?.addEventListener('click', async () => {
    const { data } = await axios.post('/api/posts/approve-all');
    toast(`${data.approved}本を承認しました${data.skipped ? `(QA未通過 ${data.skipped}本は保留)` : ''}`);
    renderApprove(); updateApprovalBadge();
  });

  document.getElementById('approve-all-replies-btn')?.addEventListener('click', async () => {
    const { data } = await axios.post('/api/replies/approve-all');
    toast(`返信${data.approved}件を承認しました(次の自動サイクルで送信されます)`);
    renderApprove();
  });

  document.querySelectorAll('.reply-decision-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { id, decision } = btn.dataset;
      try {
        const payload = { decision };
        // 承認時: 編集欄の内容が元の下書きと違えば編集本文として送信
        if (decision === 'approved') {
          const ta = document.querySelector(`.reply-edit-body[data-id="${CSS.escape(id)}"]`);
          if (ta && ta.value.trim() && ta.value.trim() !== (ta.dataset.original || '')) payload.body = ta.value.trim();
        }
        await axios.post(`/api/replies/${id}/decision`, payload);
        toast(decision === 'approved' ? '返信を承認しました(次の自動サイクルで送信)' : '返信を却下しました');
        renderApprove();
      } catch (e) {
        toast(e?.response?.data?.error || '処理に失敗しました', 'error');
      }
    });
  });

  // 返信編集欄: 入力のたびにweighted文字数を更新(280超は赤表示)
  document.querySelectorAll('.reply-edit-body').forEach((ta) => {
    const counter = document.querySelector(`.reply-char-count[data-id="${CSS.escape(ta.dataset.id)}"]`);
    const update = () => {
      if (!counter) return;
      const w = xWeightedLength(ta.value);
      counter.textContent = `${w}/280`;
      counter.classList.toggle('text-red-500', w > X_WEIGHT_LIMIT);
      counter.classList.toggle('text-slate-400', w <= X_WEIGHT_LIMIT);
    };
    ta.addEventListener('input', update);
    update();
  });
  bindDecisionButtons();
}

function replyCard(r) {
  return `
  <article class="bg-white rounded-xl shadow p-4 flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-xs font-bold text-brand-navy bg-slate-100 px-2 py-1 rounded"><i class="fas fa-at mr-1"></i>${esc(r.mention_author || '')}</span>
      ${qaBadge(r.qa_status, r.qa_issues)}
    </div>
    <div class="bg-slate-50 rounded-lg p-2 text-xs text-slate-500">
      <p class="font-bold mb-1">受信メンション:</p>
      <p class="whitespace-pre-wrap">${esc((r.mention_text || '').slice(0, 200))}</p>
    </div>
    <div class="text-sm">
      <div class="flex items-center justify-between mb-1">
        <p class="text-xs font-bold text-slate-400">Soraの返信案(編集できます):</p>
        <span class="reply-char-count text-[10px] text-slate-400 font-mono" data-id="${esc(r.reply_id)}"></span>
      </div>
      <textarea class="reply-edit-body w-full border border-slate-200 rounded-lg p-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-emerald-300 resize-y" rows="3" data-id="${esc(r.reply_id)}" data-original="${esc(r.draft_body)}">${esc(r.draft_body)}</textarea>
    </div>
    <div class="flex gap-2 pt-1">
      <button class="reply-decision-btn flex-1 bg-emerald-600 text-white py-1.5 rounded-lg text-xs font-bold hover:opacity-90" data-id="${esc(r.reply_id)}" data-decision="approved"><i class="fas fa-check mr-1"></i>承認(自動送信)</button>
      <button class="reply-decision-btn flex-1 bg-slate-200 text-slate-600 py-1.5 rounded-lg text-xs font-bold hover:bg-slate-300" data-id="${esc(r.reply_id)}" data-decision="rejected"><i class="fas fa-xmark mr-1"></i>却下</button>
    </div>
  </article>`;
}

function qaBadge(qa_status, qa_issues) {
  if (qa_status === 'ok') return '<span class="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-bold"><i class="fas fa-shield-halved mr-1"></i>QA通過</span>';
  if (qa_status === 'needs_fix') return '<span class="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold"><i class="fas fa-triangle-exclamation mr-1"></i>要修正</span>';
  if (qa_status === 'ng') return '<span class="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-bold">NG</span>';
  return '<span class="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">QA待ち</span>';
}

function postCard(p) {
  let issues = [];
  try { issues = JSON.parse(p.qa_issues || '[]'); } catch (e) {}
  let imageUrls = [];
  try { imageUrls = JSON.parse(p.image_urls || '[]'); } catch (e) {}
  const isAffiliateSlot = p.slot_number === 8 || (p.body || '').includes('#PR');
  return `
  <article class="post-card bg-white rounded-xl shadow p-4 flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-xs font-bold text-brand-navy bg-slate-100 px-2 py-1 rounded">枠${p.slot_number} ${slotTimeLabel(p)} ${esc(SLOT_NAMES[p.slot_number])}${p.recycled_from ? ' ♻️リサイクル' : ''}</span>
      ${qaBadge(p.qa_status, p.qa_issues)}
    </div>
    <p class="text-sm whitespace-pre-wrap leading-relaxed flex-1">${esc(p.body)}</p>
    ${p.quote_tweet_id ? `<div class="quote-source bg-sky-50 border border-sky-200 rounded-lg p-2 text-xs">
      <div class="flex items-center justify-between mb-1">
        <span class="font-bold text-sky-700"><i class="fas fa-quote-left mr-1"></i>引用元ツイート ${esc(p.quote_author || '')}</span>
        <a href="https://x.com/${esc((p.quote_author || '').replace('@', ''))}/status/${esc(p.quote_tweet_id)}" target="_blank" class="text-sky-500 underline">Xで見る</a>
      </div>
      <p class="text-slate-600 whitespace-pre-wrap">${esc((p.quote_text || '').slice(0, 200))}${(p.quote_text || '').length > 200 ? '…' : ''}</p>
      <p class="text-[10px] text-slate-400 mt-1">※承認するとこのツイートへの引用RTとして投稿されます(投稿時に削除済みなら通常投稿に自動切替)</p>
    </div>` : ''}
    ${imageUrls.length ? `<div class="flex gap-2">${imageUrls.map((u) => `<img src="${esc(u)}" alt="添付図解" class="h-32 rounded-lg border border-slate-200 object-cover cursor-pointer" onclick="window.open('${esc(u)}', '_blank')">`).join('')}<span class="text-[10px] text-slate-400 self-end">🎨 Aki生成図解(クリックで拡大)</span></div>` : ''}
    ${issues.length ? `<div class="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-800">${issues.map((i) => `<div><b>[${esc(i.rule)}]</b> ${esc(i.detail)}</div>`).join('')}</div>` : ''}
    ${isAffiliateSlot ? `<button class="embed-affiliate-btn w-full bg-brand-orange/10 text-brand-orange border border-brand-orange/40 py-1.5 rounded-lg text-xs font-bold hover:bg-brand-orange/20" data-id="${esc(p.post_id)}"><i class="fas fa-link mr-1"></i>アフィリンクを自動埋め込み</button>` : ''}
    ${p.qa_status === 'needs_fix' || p.qa_status === 'ng' ? `<button class="llm-rewrite-btn w-full bg-purple-50 text-purple-700 border border-purple-300 py-1.5 rounded-lg text-xs font-bold hover:bg-purple-100" data-id="${esc(p.post_id)}"><i class="fas fa-wand-magic-sparkles mr-1"></i>Yuto(AI)にリライトさせる</button>` : ''}
    <div class="flex gap-2 pt-1">
      <button class="decision-btn flex-1 bg-emerald-600 text-white py-1.5 rounded-lg text-xs font-bold hover:opacity-90" data-kind="post" data-id="${esc(p.post_id)}" data-decision="approved"><i class="fas fa-check mr-1"></i>承認</button>
      <button class="decision-btn flex-1 bg-slate-200 text-slate-700 py-1.5 rounded-lg text-xs font-bold hover:bg-slate-300" data-kind="post" data-id="${esc(p.post_id)}" data-decision="rejected"><i class="fas fa-rotate-left mr-1"></i>差戻</button>
    </div>
  </article>`;
}

function topicCard(t) {
  let axes = [];
  try { axes = JSON.parse(t.appeal_axis || '[]'); } catch (e) {}
  const mediumJa = { x_single: 'X単発', x_thread: 'Xスレッド', note_free: 'note無料', note_paid: 'note有料' };
  return `
  <article class="topic-card bg-white rounded-xl shadow p-4 flex flex-col gap-2">
    <div class="flex items-center gap-2 flex-wrap">
      <span class="text-[10px] px-2 py-0.5 rounded-full font-bold ${t.urgency === 'high' ? 'bg-red-100 text-red-700' : t.urgency === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}">${t.urgency}</span>
      <span class="text-[10px] bg-brand-navy text-white px-2 py-0.5 rounded-full">${mediumJa[t.target_medium] || t.target_medium}</span>
      ${axes.map((a) => `<span class="text-[10px] bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">${esc(a)}</span>`).join('')}
    </div>
    <h3 class="font-bold text-sm">${esc(t.title_ja)}</h3>
    <p class="text-xs text-slate-500 flex-1"><i class="fas fa-bullseye mr-1"></i>${esc(t.why_hit)}</p>
    <div class="flex gap-2 pt-1">
      <button class="decision-btn flex-1 bg-emerald-600 text-white py-1.5 rounded-lg text-xs font-bold hover:opacity-90" data-kind="topic" data-id="${esc(t.topic_id)}" data-decision="approved"><i class="fas fa-check mr-1"></i>採用</button>
      <button class="decision-btn flex-1 bg-slate-200 text-slate-700 py-1.5 rounded-lg text-xs font-bold hover:bg-slate-300" data-kind="topic" data-id="${esc(t.topic_id)}" data-decision="rejected"><i class="fas fa-xmark mr-1"></i>見送り</button>
    </div>
  </article>`;
}

function noteCard(n) {
  const typeJa = { free: '無料', paid_single: `有料 ¥${n.price_yen}`, monthly_summary: `月次まとめ ¥${n.price_yen}`, membership: 'メンバーシップ' };
  const published = n.approval_status === 'published';
  return `
  <article class="note-card bg-white rounded-xl shadow p-4 mb-3">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <span class="text-[10px] ${n.type === 'free' ? 'bg-slate-500' : 'bg-brand-orange'} text-white px-2 py-0.5 rounded-full font-bold">${typeJa[n.type] || n.type}</span>
          ${qaBadge(n.qa_status, null)}
          <span class="text-[10px] text-slate-400">${esc((n.created_at || '').slice(0, 10))}</span>
          ${n.note_url ? `<a href="${esc(n.note_url)}" target="_blank" class="text-[10px] text-emerald-600 underline"><i class="fas fa-link mr-0.5"></i>noteで見る</a>` : ''}
        </div>
        <h3 class="font-bold">${esc(n.title)}</h3>
      </div>
      <div class="flex gap-2 flex-wrap">
        <button class="note-preview-btn bg-slate-200 text-slate-700 px-4 py-2 rounded-lg text-xs font-bold hover:bg-slate-300" data-id="${esc(n.article_id)}"><i class="fas fa-eye mr-1"></i>全文プレビュー</button>
        <button class="note-publish-btn bg-brand-orange text-white px-4 py-2 rounded-lg text-xs font-bold hover:opacity-90" data-id="${esc(n.article_id)}"><i class="fas fa-paper-plane mr-1"></i>公開する</button>
      </div>
    </div>
    ${published && !n.note_url ? `
    <div class="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2">
      <input type="url" class="note-url-input flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-xs" placeholder="noteで公開したらURLを貼り付け → 枠11の告知が実URL連動になります (https://note.com/...)" data-id="${esc(n.article_id)}">
      <button class="note-url-save-btn bg-brand-navy text-white px-3 py-1.5 rounded-lg text-xs font-bold" data-id="${esc(n.article_id)}">URL登録</button>
    </div>` : ''}
  </article>`;
}

function bindDecisionButtons() {
  document.querySelectorAll('.llm-rewrite-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Yutoがリライト中...(10〜30秒)';
      try {
        const { data } = await axios.post(`/api/posts/${btn.dataset.id}/rewrite`);
        toast(data.qa.status === 'ok' ? 'リライト完了: QA通過になりました' : `リライト完了 (QA: ${data.qa.status})`);
        renderApprove();
      } catch (e) {
        toast(e.response?.data?.error || 'リライトに失敗しました', 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-1"></i>Yuto(AI)にリライトさせる';
      }
    });
  });
  document.querySelectorAll('.embed-affiliate-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const { data } = await axios.post(`/api/posts/${btn.dataset.id}/embed-affiliate`);
      if (data.ok) {
        toast(`${data.result.detected.map((d) => d.tool_name).join('・')} のリンクを埋め込みました${data.result.pr_added ? '(PR表記も自動追加)' : ''}`);
        renderApprove();
      } else {
        toast(data.message || '埋め込み対象が見つかりませんでした', 'error');
        btn.disabled = false;
      }
    });
  });
  document.querySelectorAll('.decision-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { kind, id, decision } = btn.dataset;
      let reason;
      if (decision === 'rejected' && kind === 'post') {
        reason = prompt('差戻理由(Yutoに伝わります):') || undefined;
      }
      const url = kind === 'post' ? `/api/posts/${id}/decision` : `/api/topics/${id}/decision`;
      await axios.post(url, { decision, reason });
      toast(decision === 'approved' ? '承認しました' : '差戻しました');
      renderApprove(); updateApprovalBadge();
    });
  });
  document.querySelectorAll('.note-preview-btn').forEach((btn) => {
    btn.addEventListener('click', () => openNotePreview(btn.dataset.id));
  });
  document.querySelectorAll('.note-publish-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('この記事を公開しますか?')) return;
      try {
        await axios.post(`/api/notes/${btn.dataset.id}/publish`);
        toast('公開処理をキューに投入しました。noteで公開後、URLを登録してください');
        renderApprove(); updateApprovalBadge();
      } catch (e) {
        toast(e.response?.data?.error || '公開に失敗しました', 'error');
      }
    });
  });
  document.querySelectorAll('.note-url-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = document.querySelector(`.note-url-input[data-id="${btn.dataset.id}"]`);
      const url = (input?.value || '').trim();
      if (!url) { toast('URLを入力してください', 'error'); return; }
      try {
        await axios.post(`/api/notes/${btn.dataset.id}/url`, { note_url: url });
        toast('note URLを登録しました。明日以降の枠11告知に使われます');
        renderApprove();
      } catch (e) {
        toast(e.response?.data?.error || 'URL登録に失敗しました', 'error');
      }
    });
  });
}

async function openNotePreview(id) {
  const { data } = await axios.get(`/api/notes/${id}`);
  const a = data.article;
  const images = data.images || [];
  const purposeJa = { note_cover: 'カバー画像', note_diagram: '本文用図解', infographic: '図解', thumbnail: 'サムネイル' };
  const qaChip = (s) => s === 'ok' ? '<span class="text-[10px] bg-emerald-100 text-emerald-700 font-bold px-1.5 py-0.5 rounded">QA合格</span>' : s === 'ng' ? '<span class="text-[10px] bg-red-100 text-red-600 font-bold px-1.5 py-0.5 rounded">QA不合格</span>' : '<span class="text-[10px] bg-amber-100 text-amber-700 font-bold px-1.5 py-0.5 rounded">要修正</span>';
  const imagesHtml = images.length ? `
    <div class="mb-4">
      <div class="text-xs font-bold text-brand-navy mb-2"><i class="fas fa-images mr-1"></i>Aki生成画像(${images.length}枚) — クリックで拡大 / ⬇でダウンロードしてnoteに挿入</div>
      <div class="grid grid-cols-2 gap-2">
        ${images.map((im) => `
          <div class="border border-slate-200 rounded-lg overflow-hidden">
            <img src="/api/images/${esc(im.image_id)}/file" alt="${esc(im.title_text || '')}" class="w-full aspect-video object-cover cursor-pointer bg-slate-100" loading="lazy" onclick="window.open('/api/images/${esc(im.image_id)}/file', '_blank')">
            <div class="flex items-center justify-between px-2 py-1.5 bg-slate-50">
              <span class="text-[10px] text-slate-500 truncate">${esc(purposeJa[im.purpose] || im.purpose)}: ${esc(im.title_text || '')}</span>
              <span class="flex items-center gap-1 shrink-0">${qaChip(im.qa_status)}
                <a href="/api/images/${esc(im.image_id)}/file" download="${esc(im.image_id)}.png" class="text-brand-navy hover:text-brand-orange" title="ダウンロード"><i class="fas fa-download text-xs"></i></a>
              </span>
            </div>
          </div>`).join('')}
      </div>
    </div>` : '';
  const typeJa = { free: '無料記事', paid_single: `有料記事 ¥${a.price_yen}`, monthly_summary: `月次まとめ ¥${a.price_yen}`, membership: 'メンバーシップ' };
  // paywall位置で分割して可視化(有料記事のみ)
  const marker = '<!--paywall-->';
  const hasPaywall = a.type !== 'free' && a.body_md.includes(marker);
  let bodyHtml;
  if (hasPaywall) {
    const [freePart, ...rest] = a.body_md.split(marker);
    const paidPart = rest.join(marker);
    bodyHtml = `
      <pre class="whitespace-pre-wrap text-sm leading-relaxed font-sans">${esc(freePart.trim())}</pre>
      <div class="my-4 flex items-center gap-3">
        <div class="flex-1 border-t-2 border-dashed border-brand-orange"></div>
        <span class="bg-brand-orange text-white text-xs font-bold px-3 py-1.5 rounded-full"><i class="fas fa-lock mr-1"></i>ここから有料(¥${a.price_yen})</span>
        <div class="flex-1 border-t-2 border-dashed border-brand-orange"></div>
      </div>
      <div class="bg-orange-50/60 rounded-xl p-3 border border-orange-200">
        <pre class="whitespace-pre-wrap text-sm leading-relaxed font-sans">${esc(paidPart.trim())}</pre>
      </div>`;
  } else {
    bodyHtml = `<pre class="whitespace-pre-wrap text-sm leading-relaxed font-sans">${esc(a.body_md)}</pre>`;
  }
  const root = document.getElementById('modal-root');
  root.innerHTML = `
  <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onclick="if(event.target===this)this.parentNode.innerHTML=''">
    <div class="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto shadow-2xl fade-in">
      <div class="bg-brand-navy text-white p-4 rounded-t-2xl flex items-center justify-between sticky top-0 gap-2">
        <h3 class="font-bold flex-1">${esc(a.title)}</h3>
        <button id="copy-note-md-btn" class="bg-white/15 hover:bg-white/25 text-white text-xs font-bold px-3 py-1.5 rounded-lg"><i class="fas fa-copy mr-1"></i>Markdownをコピー</button>
        <button onclick="document.getElementById('modal-root').innerHTML=''" class="text-white/70 hover:text-white text-xl"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="p-5">
        <div class="text-xs text-slate-400 mb-3">種別: ${typeJa[a.type] || esc(a.type)}${hasPaywall ? ' / 下のオレンジの線がnoteの有料化ラインになります' : ''} / 文字数: 約${a.body_md.replace(marker, '').length}字</div>
        ${imagesHtml}
        ${bodyHtml}
      </div>
    </div>
  </div>`;
  document.getElementById('copy-note-md-btn')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(a.body_md.replace(marker, '\n\n───── ここに有料ラインを設定 ─────\n\n'));
    toast('Markdownをコピーしました。noteのエディタに貼り付けて公開してください');
  });
}

/* ============ KPIビュー ============ */
async function renderKPI() {
  const { data } = await axios.get('/api/kpi?days=14');
  const { history, summary } = data;
  let analyses = { daily: [], weekly: [] };
  try { analyses = (await axios.get('/api/reports/analysis')).data; } catch (e) {}
  let settings = {};
  try { settings = (await axios.get('/api/settings')).data.settings || {}; } catch (e) {}
  let pubNotes = [];
  try {
    const nr = (await axios.get('/api/notes')).data.articles || [];
    pubNotes = nr.filter((a) => a.approval_status === 'published').slice(0, 8);
  } catch (e) {}
  const latestDaily = analyses.daily?.[0];
  const latestWeekly = analyses.weekly?.[0];
  const latestMonthly = analyses.monthly?.[0];
  const latestCompetitor = analyses.competitor?.[0];
  const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const latestKpi = history[history.length - 1] || {};
  let weeklyProposals = [];
  try { weeklyProposals = JSON.parse(latestWeekly?.proposals_json || '[]'); } catch (e) {}

  $app.innerHTML = `
  <div class="fade-in space-y-6">
    <h2 class="font-bold text-lg text-brand-navy"><i class="fas fa-chart-line mr-2"></i>KPIダッシュボード(直近14日)</h2>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      ${summary ? `
      <div class="bg-white rounded-xl shadow p-4"><div class="text-xs text-slate-400">フォロワー増(前日比)</div><div class="text-2xl font-bold ${summary.followers_delta >= 0 ? 'text-emerald-600' : 'text-red-500'}">${summary.followers_delta >= 0 ? '+' : ''}${summary.followers_delta}</div></div>
      <div class="bg-white rounded-xl shadow p-4"><div class="text-xs text-slate-400">本日売上</div><div class="text-2xl font-bold text-brand-orange">¥${summary.revenue_today.toLocaleString()}</div></div>
      <div class="bg-white rounded-xl shadow p-4"><div class="text-xs text-slate-400">期間累計売上</div><div class="text-2xl font-bold text-brand-navy">¥${summary.revenue_total.toLocaleString()}</div></div>
      <div class="bg-white rounded-xl shadow p-4"><div class="text-xs text-slate-400">メンバーシップ</div><div class="text-2xl font-bold text-brand-navy">${history[history.length-1]?.membership_count ?? 0}人</div></div>
      ` : ''}
    </div>
    <div class="bg-white rounded-xl shadow p-4">
      <h3 class="font-bold text-sm text-brand-navy mb-3">Xフォロワー / 売上の推移</h3>
      <canvas id="kpi-chart" height="110"></canvas>
    </div>

    <section id="kpi-input-section" class="bg-white rounded-xl shadow p-4 border-l-4 border-emerald-500">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-1">
        <h3 class="font-bold text-sm text-brand-navy"><i class="fas fa-pen-to-square mr-1 text-emerald-600"></i>📊 数値入力(1日2分の収益記録)</h3>
        <button id="kpi-auto-collect-btn" class="bg-emerald-600 text-white text-xs font-bold px-3 py-1.5 rounded-lg hover:opacity-90"><i class="fas fa-rotate mr-1"></i>自動収集を今実行</button>
      </div>
      <p class="text-[11px] text-slate-500 mb-3">自動収集: Xフォロワー・Xインプレ/エンゲージ(直近20投稿)・noteフォロワー・note閲覧数・メンバー数。手入力は note売上とアフィ収益のみです(空欄は上書きしません)</p>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <label class="block"><span class="text-slate-500">日付</span><input id="kpi-date" type="date" value="${todayJst}" class="w-full border border-slate-200 rounded-lg px-2 py-1.5 mt-0.5"></label>
        <label class="block"><span class="text-slate-500">Xインプレッション(累計)</span><input id="kpi-imp" type="number" min="0" placeholder="${latestKpi.x_impressions_total || 0}" class="w-full border border-slate-200 rounded-lg px-2 py-1.5 mt-0.5"></label>
        <label class="block"><span class="text-slate-500">Xエンゲージメント(累計)</span><input id="kpi-eng" type="number" min="0" placeholder="${latestKpi.x_engagements_total || 0}" class="w-full border border-slate-200 rounded-lg px-2 py-1.5 mt-0.5"></label>
        <label class="block"><span class="text-slate-500">note売上(本日・円)</span><input id="kpi-sales" type="number" min="0" placeholder="0" class="w-full border border-slate-200 rounded-lg px-2 py-1.5 mt-0.5"></label>
        <label class="block"><span class="text-slate-500">メンバー数</span><input id="kpi-members" type="number" min="0" placeholder="${latestKpi.membership_count || 0}" class="w-full border border-slate-200 rounded-lg px-2 py-1.5 mt-0.5"></label>
        <label class="block"><span class="text-slate-500">メンバー収益(月額・円)</span><input id="kpi-mrev" type="number" min="0" placeholder="${latestKpi.membership_revenue || 0}" class="w-full border border-slate-200 rounded-lg px-2 py-1.5 mt-0.5"></label>
        <label class="block"><span class="text-slate-500">アフィ収益(本日・円)</span><input id="kpi-aff" type="number" min="0" placeholder="0" class="w-full border border-slate-200 rounded-lg px-2 py-1.5 mt-0.5"></label>
        <div class="flex items-end"><button id="kpi-save-btn" class="w-full bg-brand-navy text-white font-bold rounded-lg px-3 py-1.5"><i class="fas fa-floppy-disk mr-1"></i>保存</button></div>
      </div>
      <div class="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2 flex-wrap text-xs">
        <span class="text-slate-500"><i class="fas fa-gear mr-1"></i>noteユーザー名(自動収集用):</span>
        <input id="note-username-input" type="text" value="${esc(settings.note_username || '')}" placeholder="例: mune_ai_fukugyo (note.com/○○ の○○部分)" class="border border-slate-200 rounded-lg px-2 py-1.5 w-64">
        <button id="note-username-save-btn" class="bg-slate-600 text-white font-bold rounded-lg px-3 py-1.5">設定</button>
        <span class="text-[10px] text-slate-400">設定するとnoteフォロワー数・スキ数を毎朝自動取得します</span>
      </div>
      <div id="note-session-row" class="mt-2 pt-2 border-t border-slate-100 text-xs">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-slate-500"><i class="fas fa-cookie-bite mr-1"></i>noteログインCookie(閲覧数・メンバー数の自動収集用):</span>
          ${settings.note_session_registered === 'yes'
            ? (settings.note_session_status === 'expired'
               ? `<span class="bg-red-100 text-red-700 font-bold px-2 py-0.5 rounded"><i class="fas fa-triangle-exclamation mr-1"></i>失効中 — 再登録してください</span>`
               : `<span class="bg-emerald-100 text-emerald-700 font-bold px-2 py-0.5 rounded"><i class="fas fa-circle-check mr-1"></i>登録済み(末尾…${esc(settings.note_session_tail || '')})</span>`)
            : `<span class="bg-slate-100 text-slate-500 px-2 py-0.5 rounded">未登録</span>`}
          ${settings.note_session_checked_at ? `<span class="text-[10px] text-slate-400">最終確認: ${esc(settings.note_session_checked_at)}</span>` : ''}
        </div>
        <div class="flex items-center gap-2 flex-wrap mt-2">
          <input id="note-session-input" type="password" placeholder="_note_session_v5 の値を貼り付け(名前=値 形式でもOK)" class="border border-slate-200 rounded-lg px-2 py-1.5 w-80">
          <button id="note-session-save-btn" class="bg-slate-600 text-white font-bold rounded-lg px-3 py-1.5">${settings.note_session_registered === 'yes' ? '再登録' : '登録'}</button>
          <button id="note-session-help-btn" class="text-brand-navy underline">取得手順</button>
        </div>
        <div id="note-session-help" class="hidden mt-2 bg-slate-50 rounded-lg p-3 text-[11px] text-slate-600 leading-relaxed">
          <p class="font-bold mb-1">📋 Cookieの取得手順(Chrome、1分)</p>
          <ol class="list-decimal ml-4 space-y-0.5">
            <li>PCのChromeで note.com を開き、ログインした状態にする</li>
            <li>F12キー(または右クリック→検証)で開発者ツールを開く</li>
            <li>上部タブの「Application」(アプリケーション)→左側「Cookie」→「https://note.com」をクリック</li>
            <li>一覧から <code class="bg-white px-1 rounded border">_note_session_v5</code> を探し、Value列の値をダブルクリック→コピー</li>
            <li>上の入力欄に貼り付けて「登録」→ 自動で有効性を検証します</li>
          </ol>
          <p class="mt-1 text-slate-400">※ 有効期限は数か月です。失効するとオフィス画面に赤い通知が出るので、同じ手順で再登録してください。Cookieはパスワード相当の秘密情報のため、このアプリ以外には貼らないでください。</p>
        </div>
      </div>
    </section>

    ${pubNotes.length ? `
    <section id="note-sales-section" class="bg-white rounded-xl shadow p-4">
      <h3 class="font-bold text-sm text-brand-navy mb-1"><i class="fas fa-yen-sign mr-1 text-brand-orange"></i>記事別売上の記録(noteダッシュボードの数字を転記)</h3>
      <p class="text-[11px] text-slate-500 mb-3">どの記事が売れたかを記録すると、Ruiが「売れる記事の型」を分析して次の企画に反映します</p>
      <div class="space-y-2">
        ${pubNotes.map((a) => `
        <div class="flex items-center gap-2 text-xs flex-wrap border-b border-slate-50 pb-2">
          <span class="flex-1 min-w-[180px] font-bold truncate" title="${esc(a.title)}">${esc(a.title)}</span>
          <span class="text-[10px] text-slate-400">${a.type === 'free' ? '無料' : '¥' + a.price_yen}</span>
          <input type="number" min="0" class="note-stat-view border border-slate-200 rounded px-2 py-1 w-20" placeholder="view ${a.view_count || 0}" data-id="${esc(a.article_id)}">
          <input type="number" min="0" class="note-stat-sales border border-slate-200 rounded px-2 py-1 w-20" placeholder="売上 ${a.sales_count || 0}件" data-id="${esc(a.article_id)}">
          <input type="number" min="0" class="note-stat-rev border border-slate-200 rounded px-2 py-1 w-24" placeholder="¥${a.revenue_yen || 0}" data-id="${esc(a.article_id)}">
          <button class="note-stat-save-btn bg-slate-600 text-white rounded px-2 py-1 font-bold" data-id="${esc(a.article_id)}">保存</button>
        </div>`).join('')}
      </div>
    </section>` : ''}

    ${latestDaily || latestWeekly || latestMonthly || latestCompetitor ? `
    <section id="rui-analysis" class="space-y-4">
      <h2 class="font-bold text-lg text-brand-navy"><span class="text-xl mr-1">📊</span>Ruiの分析レポート</h2>
      ${latestMonthly ? `
      <div class="bg-white rounded-xl shadow p-4 border-l-4 border-purple-500">
        <h3 class="font-bold text-brand-navy mb-2">月次レポート(30日総括+来月戦略) <span class="text-xs text-slate-400 font-normal ml-2">${esc(latestMonthly.report_date)}</span></h3>
        <div class="text-sm whitespace-pre-wrap leading-relaxed text-slate-700 max-h-80 overflow-y-auto">${esc(latestMonthly.body_md)}</div>
      </div>` : ''}
      ${latestCompetitor ? `
      <div class="bg-white rounded-xl shadow p-4 border-l-4 border-sky-500">
        <h3 class="font-bold text-brand-navy mb-2">Rikoの競合リサーチ(AI副業系noteの売れ筋傾向) <span class="text-xs text-slate-400 font-normal ml-2">${esc(latestCompetitor.report_date)}</span></h3>
        <div class="text-sm whitespace-pre-wrap leading-relaxed text-slate-700 max-h-72 overflow-y-auto">${esc(latestCompetitor.body_md)}</div>
      </div>` : ''}
      ${latestWeekly ? `
      <div class="bg-white rounded-xl shadow p-4 border-l-4 border-brand-orange">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold text-brand-navy">週次分析(7日総括) <span class="text-xs text-slate-400 font-normal ml-2">${esc(latestWeekly.report_date)}</span></h3>
        </div>
        <div class="text-sm whitespace-pre-wrap leading-relaxed text-slate-700 max-h-72 overflow-y-auto">${esc(latestWeekly.body_md)}</div>
        ${weeklyProposals.length ? `
        <div class="mt-3 border-t pt-3">
          <h4 class="font-bold text-sm text-brand-navy mb-2"><i class="fas fa-lightbulb mr-1 text-brand-orange"></i>今週の改善提案(Alexの週次計画に反映されます)</h4>
          <div class="grid md:grid-cols-3 gap-3">${weeklyProposals.map((p, i) => `
            <div class="bg-orange-50 rounded-lg p-3 text-xs">
              <div class="font-bold text-brand-navy mb-1">${i + 1}. ${esc(p.title || '')}</div>
              <div class="text-slate-600 mb-1">${esc(p.action || '')}</div>
              <div class="text-brand-orange">→ ${esc(p.expected || '')}</div>
            </div>`).join('')}</div>
        </div>` : ''}
      </div>` : ''}
      ${latestDaily ? `
      <div class="bg-white rounded-xl shadow p-4">
        <h3 class="font-bold text-brand-navy mb-2">日次分析 <span class="text-xs text-slate-400 font-normal ml-2">${esc(latestDaily.report_date)}</span></h3>
        <div class="text-sm whitespace-pre-wrap leading-relaxed text-slate-700 max-h-72 overflow-y-auto">${esc(latestDaily.body_md)}</div>
      </div>` : ''}
    </section>` : ''}
    <div class="bg-white rounded-xl shadow p-4 overflow-x-auto">
      <h3 class="font-bold text-sm text-brand-navy mb-3">日次明細</h3>
      <table class="w-full text-xs">
        <thead><tr class="text-left text-slate-400 border-b">
          <th class="py-2 pr-3">日付</th><th class="py-2 pr-3">フォロワー</th><th class="py-2 pr-3">インプ</th><th class="py-2 pr-3">エンゲージ</th><th class="py-2 pr-3">note売上</th><th class="py-2 pr-3">サブスク</th><th class="py-2">アフィ</th>
        </tr></thead>
        <tbody>
          ${[...history].reverse().map((r) => `
          <tr class="border-b border-slate-50">
            <td class="py-1.5 pr-3">${r.date}</td>
            <td class="py-1.5 pr-3 font-bold">${r.x_followers.toLocaleString()}</td>
            <td class="py-1.5 pr-3">${(r.x_impressions_total || 0).toLocaleString()}</td>
            <td class="py-1.5 pr-3">${(r.x_engagements_total || 0).toLocaleString()}</td>
            <td class="py-1.5 pr-3">¥${(r.note_paid_sales || 0).toLocaleString()}</td>
            <td class="py-1.5 pr-3">¥${(r.membership_revenue || 0).toLocaleString()}</td>
            <td class="py-1.5">¥${(r.affiliate_revenue || 0).toLocaleString()}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;

  // 数値入力フォームのイベント
  document.getElementById('kpi-save-btn')?.addEventListener('click', async () => {
    const val = (id) => { const v = document.getElementById(id)?.value; return v === '' || v === undefined ? undefined : Number(v); };
    try {
      await axios.post('/api/kpi/daily', {
        date: document.getElementById('kpi-date')?.value,
        x_impressions_total: val('kpi-imp'),
        x_engagements_total: val('kpi-eng'),
        note_paid_sales: val('kpi-sales'),
        membership_count: val('kpi-members'),
        membership_revenue: val('kpi-mrev'),
        affiliate_revenue: val('kpi-aff'),
      });
      toast('KPIを保存しました');
      renderKPI();
    } catch (e) {
      toast(e.response?.data?.error || 'KPI保存に失敗しました', 'error');
    }
  });
  document.getElementById('kpi-auto-collect-btn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>収集中...';
    try {
      const { data } = await axios.post('/api/kpi/collect');
      const parts = [];
      if (data.xFollowers !== undefined) parts.push(`Xフォロワー: ${data.xFollowers}`);
      if (data.xImpressions !== undefined) parts.push(`Xインプレ: ${data.xImpressions.toLocaleString()}`);
      if (data.noteFollowers !== undefined) parts.push(`noteフォロワー: ${data.noteFollowers}`);
      if (data.noteViewsTotal !== undefined) parts.push(`note閲覧: ${data.noteViewsTotal.toLocaleString()}`);
      if (data.membershipCount !== undefined) parts.push(`メンバー: ${data.membershipCount}人`);
      if (data.noteSessionStatus === 'expired') toast('⚠️ noteログインCookieが失効しています。再登録してください', 'error');
      toast(parts.length ? `自動収集完了 — ${parts.join(' / ')}` : (data.errors?.[0] || '取得できる指標がありませんでした'), parts.length ? 'success' : 'error');
      renderKPI();
    } catch (e) {
      toast(e.response?.data?.errors?.[0] || '自動収集に失敗しました', 'error');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-rotate mr-1"></i>自動収集を今実行';
    }
  });
  document.getElementById('note-username-save-btn')?.addEventListener('click', async () => {
    const value = document.getElementById('note-username-input')?.value || '';
    try {
      await axios.post('/api/settings', { key: 'note_username', value });
      toast('noteユーザー名を設定しました。明日から自動収集されます');
    } catch (e) {
      toast(e.response?.data?.error || '設定に失敗しました', 'error');
    }
  });
  document.getElementById('note-session-help-btn')?.addEventListener('click', () => {
    document.getElementById('note-session-help')?.classList.toggle('hidden');
  });
  document.getElementById('note-session-save-btn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const value = document.getElementById('note-session-input')?.value || '';
    if (!value.trim()) { toast('Cookie値を貼り付けてください', 'error'); return; }
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>検証中...';
    try {
      const { data } = await axios.post('/api/settings', { key: 'note_session_v5', value });
      toast(`Cookieを登録しました${data.nickname ? `(${data.nickname} さんとして認証確認済み)` : ''}。note閲覧数・メンバー数が自動収集されます`);
      renderKPI();
    } catch (e) {
      toast(e.response?.data?.error || 'Cookieの登録に失敗しました', 'error');
      btn.disabled = false;
      btn.innerHTML = '登録';
    }
  });
  document.querySelectorAll('.note-stat-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const pick = (cls) => { const el = document.querySelector(`.${cls}[data-id="${id}"]`); const v = el?.value; return v === '' || v === undefined ? undefined : Number(v); };
      try {
        await axios.post(`/api/notes/${id}/stats`, { view_count: pick('note-stat-view'), sales_count: pick('note-stat-sales'), revenue_yen: pick('note-stat-rev') });
        toast('記事売上を保存しました');
      } catch (e) {
        toast('保存に失敗しました', 'error');
      }
    });
  });

  if (kpiChart) { kpiChart.destroy(); kpiChart = null; }
  const ctx = document.getElementById('kpi-chart');
  kpiChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: history.map((r) => r.date.slice(5)),
      datasets: [
        { label: 'Xフォロワー', data: history.map((r) => r.x_followers), borderColor: '#1E3A5F', backgroundColor: 'rgba(30,58,95,0.08)', fill: true, tension: 0.3, yAxisID: 'y' },
        { label: '日次売上(¥)', data: history.map((r) => (r.note_paid_sales || 0) + (r.affiliate_revenue || 0)), borderColor: '#FF7A45', backgroundColor: 'rgba(255,122,69,0.08)', fill: true, tension: 0.3, yAxisID: 'y1' }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { position: 'left', title: { display: true, text: 'フォロワー' } },
        y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: '売上(¥)' } }
      }
    }
  });
}

/* ============ QAチェックビュー ============ */
async function renderQA() {
  let llmStatus = { connected: false, keyHint: null };
  try { llmStatus = (await axios.get('/api/llm/status')).data; } catch (e) {}

  $app.innerHTML = `
  <div class="fade-in max-w-3xl mx-auto space-y-5">
    <h2 class="font-bold text-lg text-brand-navy"><i class="fas fa-shield-halved mr-2"></i>QAチェッカー(Mio)& AI執筆(Yuto)</h2>
    <div class="flex items-center gap-2 text-xs">
      <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full ${llmStatus.connected ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">
        <span class="w-2 h-2 rounded-full ${llmStatus.connected ? 'bg-emerald-500' : 'bg-slate-400'}"></span>
        OpenAI ${llmStatus.connected ? `接続中 (${llmStatus.keyHint})` : '未接続'}
      </span>
    </div>

    <!-- Yuto AI執筆スタジオ -->
    <section id="yuto-studio" class="bg-white rounded-xl shadow p-4 space-y-3 border-2 border-brand-orange/30">
      <h3 class="font-bold text-sm text-brand-navy"><i class="fas fa-pen-nib mr-1 text-brand-orange"></i>Yuto AI執筆スタジオ <span class="text-[10px] font-normal text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full border border-purple-200">gpt-5</span></h3>
      <p class="text-xs text-slate-500">テーマを入れると、Yuto(GPT-5)が注釈・円換算・法令ルールを守った投稿を執筆します。執筆後は自動でキーワードQAも実行。</p>
      <div class="flex gap-2 flex-wrap">
        <input id="yuto-theme" class="flex-1 min-w-[240px] border border-slate-300 rounded-lg p-2.5 text-sm" placeholder="例: 海外で流行しているFaceless YouTube(顔出しなし動画)の始め方">
        <select id="yuto-slot" class="border border-slate-300 rounded-lg p-2 text-sm">
          ${Array.from({length:12},(_,i)=>`<option value="${i+1}">枠${i+1}</option>`).join('')}
        </select>
      </div>
      <div class="flex gap-2">
        <button id="yuto-write-btn" class="bg-brand-orange text-white px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90" ${llmStatus.connected ? '' : 'disabled'}><i class="fas fa-wand-magic-sparkles mr-1"></i>Yutoに執筆させる</button>
      </div>
      <div id="yuto-result"></div>
    </section>

    <section id="qa-form" class="bg-white rounded-xl shadow p-4 space-y-3">
      <h3 class="font-bold text-sm text-brand-navy"><i class="fas fa-magnifying-glass mr-1"></i>投稿文チェック</h3>
      <textarea id="qa-text" rows="6" class="w-full border border-slate-300 rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange" placeholder="例: この方法なら誰でも簡単に稼げる!絶対おすすめです!"></textarea>
      <label class="flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" id="qa-affiliate" class="rounded">
        アフィリエイトリンクを含む投稿
      </label>
      <div class="flex gap-2 flex-wrap">
        <button id="qa-check-btn" class="bg-brand-navy text-white px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90"><i class="fas fa-bolt mr-1"></i>キーワードチェック(即時)</button>
        <button id="qa-llm-btn" class="bg-blue-600 text-white px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90" ${llmStatus.connected ? '' : 'disabled'}><i class="fas fa-brain mr-1"></i>Mio 実AIチェック <span class="text-[10px] opacity-80">(gpt-5-mini)</span></button>
      </div>
    </section>
    <section id="qa-result"></section>
  </div>`;

  // Yuto執筆
  document.getElementById('yuto-write-btn').addEventListener('click', async () => {
    const theme = document.getElementById('yuto-theme').value.trim();
    if (!theme) { toast('テーマを入力してください', 'error'); return; }
    const btn = document.getElementById('yuto-write-btn');
    const box = document.getElementById('yuto-result');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Yutoが執筆中...(10〜30秒)';
    try {
      const { data } = await axios.post('/api/llm/write', { theme, slot: +document.getElementById('yuto-slot').value });
      const qaBadge = data.qa.status === 'ok'
        ? '<span class="text-emerald-600 font-bold"><i class="fas fa-circle-check mr-1"></i>キーワードQA: OK</span>'
        : `<span class="text-amber-600 font-bold"><i class="fas fa-triangle-exclamation mr-1"></i>キーワードQA: ${data.qa.status}(${data.qa.issues.length}件)</span>`;
      box.innerHTML = `
      <div class="fade-in mt-3 space-y-2">
        <div class="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <pre id="yuto-draft" class="whitespace-pre-wrap text-sm font-sans">${esc(data.draft)}</pre>
        </div>
        <div class="flex items-center justify-between flex-wrap gap-2 text-xs">
          <div>${qaBadge}<span class="text-slate-400 ml-3">${esc(data.model)} / ${data.usage ? data.usage.total_tokens + ' tokens' : ''} / 約$${(data.costUsd || 0).toFixed(4)}</span></div>
          <button id="yuto-save-btn" class="bg-brand-navy text-white px-4 py-1.5 rounded-lg font-bold hover:opacity-90"><i class="fas fa-inbox mr-1"></i>承認キューに追加</button>
        </div>
      </div>`;
      document.getElementById('yuto-save-btn').addEventListener('click', async () => {
        const { data: d2 } = await axios.post('/api/llm/write', { theme, slot: +document.getElementById('yuto-slot').value, save: true });
        toast(`承認キューに追加しました (${d2.savedPostId})`);
        updateApprovalBadge();
      });
    } catch (e) {
      box.innerHTML = `<div class="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">エラー: ${esc(e.response?.data?.error || e.message)}</div>`;
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-1"></i>Yutoに執筆させる';
    }
  });

  // Mio 実LLMチェック
  document.getElementById('qa-llm-btn').addEventListener('click', async () => {
    const text = document.getElementById('qa-text').value.trim();
    if (!text) { toast('本文を入力してください', 'error'); return; }
    const btn = document.getElementById('qa-llm-btn');
    const box = document.getElementById('qa-result');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Mioが審査中...';
    try {
      const { data } = await axios.post('/api/llm/qa', { text });
      const v = data.llm?.verdict || 'unknown';
      const vColor = v === 'ok' ? 'emerald' : v === 'ng' ? 'red' : 'amber';
      const vLabel = v === 'ok' ? 'OK — 問題なし' : v === 'ng' ? 'NG(公開停止)' : v === 'needs_fix' ? '要修正' : '判定不能';
      box.innerHTML = `
      <div class="fade-in bg-${vColor}-50 border border-${vColor}-300 rounded-xl p-5 space-y-3">
        <p class="font-bold text-${vColor}-700"><i class="fas fa-brain mr-1"></i>Mio(AI)判定: ${vLabel}</p>
        ${(data.llm?.issues || []).map((i) => `
        <div class="bg-white rounded-lg p-3 text-sm">
          <div class="font-bold text-brand-navy">[${esc(i.law || '')}] 「${esc(i.quote || '')}」</div>
          <div class="text-xs text-slate-700 mt-1">${esc(i.reason || '')}</div>
          ${i.suggestion ? `<div class="text-xs text-emerald-700 mt-1"><i class="fas fa-lightbulb mr-1"></i>修正案: ${esc(i.suggestion)}</div>` : ''}
        </div>`).join('')}
        ${data.llm?.rewrite ? `
        <div class="bg-white rounded-lg p-3">
          <div class="text-[10px] text-slate-400 mb-1">Mioによる書き直し案:</div>
          <pre class="whitespace-pre-wrap text-sm font-sans">${esc(data.llm.rewrite)}</pre>
        </div>` : ''}
        <div class="text-[10px] text-slate-400">${esc(data.model || '')} / ${data.usage ? data.usage.total_tokens + ' tokens' : ''} / 約$${(data.costUsd || 0).toFixed(4)}</div>
      </div>`;
    } catch (e) {
      box.innerHTML = `<div class="fade-in bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">エラー: ${esc(e.response?.data?.error || e.message)}</div>`;
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-brain mr-1"></i>Mio 実AIチェック <span class="text-[10px] opacity-80">(gpt-5-mini)</span>';
    }
  });

  document.getElementById('qa-check-btn').addEventListener('click', async () => {
    const text = document.getElementById('qa-text').value.trim();
    if (!text) { toast('本文を入力してください', 'error'); return; }
    const { data } = await axios.post('/api/qa/check', { text, has_affiliate: document.getElementById('qa-affiliate').checked });
    const box = document.getElementById('qa-result');
    if (data.status === 'ok') {
      box.innerHTML = `<div class="fade-in bg-emerald-50 border border-emerald-300 rounded-xl p-5 text-center">
        <i class="fas fa-circle-check text-emerald-500 text-3xl mb-2"></i>
        <p class="font-bold text-emerald-700">判定: OK — 問題は検出されませんでした</p></div>`;
    } else {
      box.innerHTML = `<div class="fade-in ${data.status === 'ng' ? 'bg-red-50 border-red-300' : 'bg-amber-50 border-amber-300'} border rounded-xl p-5">
        <p class="font-bold ${data.status === 'ng' ? 'text-red-700' : 'text-amber-700'} mb-3">
          <i class="fas fa-triangle-exclamation mr-1"></i>判定: ${data.status === 'ng' ? 'NG(公開停止)' : '要修正'} — ${data.issues.length}件の指摘
        </p>
        <ul class="space-y-2">
          ${data.issues.map((i) => `
          <li class="bg-white rounded-lg p-3 text-sm">
            <div class="font-bold text-brand-navy">[${esc(i.rule)}] 検出語: 「${esc(i.matched)}」</div>
            <div class="text-xs text-slate-500 mt-1">根拠: ${esc(i.law)}</div>
            <div class="text-xs text-slate-700 mt-1">${esc(i.detail)}</div>
          </li>`).join('')}
        </ul>
      </div>`;
    }
  });
}

/* ============ アフィリンク管理ビュー ============ */
async function renderAffiliate() {
  const [linksRes, glossaryRes] = await Promise.all([
    axios.get('/api/affiliate/links'),
    axios.get('/api/glossary')
  ]);
  const links = linksRes.data.links;
  const glossary = glossaryRes.data.glossary;

  $app.innerHTML = `
  <div class="fade-in max-w-4xl mx-auto space-y-6">
    <h2 class="font-bold text-lg text-brand-navy"><i class="fas fa-link mr-2"></i>アフィリエイトリンク管理</h2>
    <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-slate-700">
      <p class="font-bold text-brand-navy mb-1"><i class="fas fa-circle-info mr-1"></i>仕組み</p>
      <p>ASP(A8.net等)への提携申請は規約上、人間の操作が必要です。<b>提携承認後にここへ1回登録</b>すれば、以後は投稿文からツール名を自動検出し、リンク+PR表記を自動で埋め込みます(承認画面のボタン、または本番ではYutoが執筆時に自動実行)。</p>
    </div>

    <section id="affiliate-register" class="bg-white rounded-xl shadow p-4 space-y-3">
      <h3 class="font-bold text-sm text-brand-navy">新規リンク登録</h3>
      <div class="grid sm:grid-cols-2 gap-3">
        <input id="af-tool" class="border border-slate-300 rounded-lg p-2 text-sm" placeholder="ツール名(例: ElevenLabs)">
        <input id="af-aliases" class="border border-slate-300 rounded-lg p-2 text-sm" placeholder="検出ワード カンマ区切り(例: イレブンラボ,elevenlabs)">
        <input id="af-url" class="border border-slate-300 rounded-lg p-2 text-sm sm:col-span-2" placeholder="アフィリエイトURL(提携承認後に発行されたもの)">
        <input id="af-program" class="border border-slate-300 rounded-lg p-2 text-sm" placeholder="ASP名(例: A8.net)">
        <input id="af-note" class="border border-slate-300 rounded-lg p-2 text-sm" placeholder="メモ(報酬率など)">
      </div>
      <button id="af-add-btn" class="bg-brand-navy text-white px-5 py-2 rounded-lg text-sm font-bold hover:opacity-90"><i class="fas fa-plus mr-1"></i>登録</button>
    </section>

    <section id="affiliate-list" class="bg-white rounded-xl shadow p-4">
      <h3 class="font-bold text-sm text-brand-navy mb-3">登録済みリンク(${links.length}件)</h3>
      <div class="space-y-2">
        ${links.length ? links.map((l) => `
        <div class="border border-slate-200 rounded-lg p-3 flex items-center justify-between flex-wrap gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-bold text-sm">${esc(l.tool_name)}</span>
              <span class="text-[10px] px-2 py-0.5 rounded-full font-bold ${l.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">${l.status === 'active' ? '自動埋め込み中' : '停止中'}</span>
              ${l.program ? `<span class="text-[10px] text-slate-400">${esc(l.program)}</span>` : ''}
              <span class="text-[10px] px-2 py-0.5 rounded-full font-bold bg-sky-100 text-sky-700"><i class="fas fa-arrow-pointer mr-0.5"></i>クリック ${l.clicks_7d ?? 0}/7日 (累計${l.clicks_total ?? 0})</span>
            </div>
            <div class="text-xs text-slate-500 truncate max-w-md">${esc(l.affiliate_url)}</div>
            <div class="text-[11px] text-sky-600 truncate max-w-md">計測URL: /go/${esc(l.link_id)}</div>
            ${l.note ? `<div class="text-[11px] text-amber-600">${esc(l.note)}</div>` : ''}
          </div>
          <div class="flex gap-2">
            <button class="af-toggle-btn text-xs bg-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-300" data-id="${esc(l.link_id)}">${l.status === 'active' ? '停止' : '再開'}</button>
            <button class="af-delete-btn text-xs bg-red-100 text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-200" data-id="${esc(l.link_id)}">削除</button>
          </div>
        </div>`).join('') : '<p class="text-sm text-slate-400">まだ登録がありません</p>'}
      </div>
    </section>

    <section id="embed-tester" class="bg-white rounded-xl shadow p-4 space-y-3">
      <h3 class="font-bold text-sm text-brand-navy">埋め込みテスター</h3>
      <p class="text-xs text-slate-500">投稿文を貼ると、検出されるリンクと埋め込み後の本文をプレビューできます。</p>
      <textarea id="embed-text" rows="4" class="w-full border border-slate-300 rounded-lg p-3 text-sm" placeholder="例: AIナレーションならElevenLabsが自然な印象です。動画編集はCapCutで十分でした。"></textarea>
      <button id="embed-test-btn" class="bg-brand-orange text-white px-5 py-2 rounded-lg text-sm font-bold hover:opacity-90"><i class="fas fa-wand-magic-sparkles mr-1"></i>プレビュー</button>
      <div id="embed-result"></div>
    </section>

    <section id="glossary-list" class="bg-white rounded-xl shadow p-4">
      <h3 class="font-bold text-sm text-brand-navy mb-3"><i class="fas fa-book mr-1"></i>用語注釈辞書(${glossary.length}語)— Yutoが素人向け注釈に使用</h3>
      <div class="grid sm:grid-cols-2 gap-2 text-xs">
        ${glossary.map((g) => `<div class="border border-slate-100 rounded-lg p-2"><b class="text-brand-navy">${esc(g.term)}</b> — ${esc(g.annotation)}</div>`).join('')}
      </div>
    </section>
  </div>`;

  document.getElementById('af-add-btn').addEventListener('click', async () => {
    const tool_name = document.getElementById('af-tool').value.trim();
    const affiliate_url = document.getElementById('af-url').value.trim();
    if (!tool_name || !affiliate_url) { toast('ツール名とURLは必須です', 'error'); return; }
    const aliases = [tool_name, ...document.getElementById('af-aliases').value.split(',').map((s) => s.trim()).filter(Boolean)];
    await axios.post('/api/affiliate/links', {
      tool_name, affiliate_url, aliases,
      program: document.getElementById('af-program').value.trim() || null,
      note: document.getElementById('af-note').value.trim() || null
    });
    toast('リンクを登録しました。以後自動埋め込み対象になります');
    renderAffiliate();
  });
  document.querySelectorAll('.af-toggle-btn').forEach((b) => b.addEventListener('click', async () => {
    await axios.post(`/api/affiliate/links/${b.dataset.id}/toggle`); renderAffiliate();
  }));
  document.querySelectorAll('.af-delete-btn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('削除しますか?')) return;
    await axios.post(`/api/affiliate/links/${b.dataset.id}/delete`); toast('削除しました'); renderAffiliate();
  }));
  document.getElementById('embed-test-btn').addEventListener('click', async () => {
    const text = document.getElementById('embed-text').value.trim();
    if (!text) { toast('本文を入力してください', 'error'); return; }
    const { data } = await axios.post('/api/affiliate/embed', { text });
    const box = document.getElementById('embed-result');
    if (!data.changed) {
      box.innerHTML = '<div class="fade-in bg-slate-50 rounded-lg p-3 text-sm text-slate-500">検出されたツール名はありませんでした</div>';
      return;
    }
    box.innerHTML = `
    <div class="fade-in space-y-2">
      <div class="text-xs text-emerald-700 font-bold"><i class="fas fa-check mr-1"></i>検出: ${data.detected.map((d) => `${esc(d.tool_name)}(「${esc(d.matched)}」にマッチ)`).join(' / ')}${data.pr_added ? ' + PR表記を自動追加' : ''}</div>
      <div class="bg-slate-50 border border-slate-200 rounded-lg p-3">
        <div class="text-[10px] text-slate-400 mb-1">埋め込み後の本文:</div>
        <pre class="whitespace-pre-wrap text-sm font-sans">${esc(data.embedded)}</pre>
      </div>
    </div>`;
  });
}

/* ============ Aki画像スタジオ ============ */
async function renderImages() {
  let llmStatus = { connected: false };
  try { llmStatus = (await axios.get('/api/llm/status')).data; } catch (e) {}
  const { data } = await axios.get('/api/images');
  const images = data.images || [];

  const imgQaBadge = (s) => {
    if (s === 'ok') return '<span class="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-bold"><i class="fas fa-shield-halved mr-1"></i>QA通過</span>';
    if (s === 'needs_fix') return '<span class="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold"><i class="fas fa-triangle-exclamation mr-1"></i>要修正</span>';
    if (s === 'ng') return '<span class="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-bold">NG</span>';
    return '<span class="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-bold">未審査</span>';
  };

  $app.innerHTML = `
  <div class="fade-in max-w-5xl mx-auto space-y-6">
    <h2 class="font-bold text-lg text-brand-navy"><i class="fas fa-image mr-2"></i>Aki 画像スタジオ <span class="text-[10px] font-normal text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full border border-purple-200">gpt-image-2</span></h2>
    <p class="text-sm text-slate-500">タイトルを入れるとAkiがブランドガイド(ネイビー×オレンジ)準拠の投稿用画像を生成。生成後はMio(GPT-5)が画像内の誤字・法令リスク・権利リスクを自動審査します。1枚あたり約$0.05〜0.10(画像生成+QA)。</p>

    <section id="image-generator" class="bg-white rounded-xl shadow p-4 space-y-3 border-2 border-brand-orange/30">
      <div class="grid sm:grid-cols-3 gap-3">
        <input id="img-title" class="sm:col-span-2 border border-slate-300 rounded-lg p-2.5 text-sm" placeholder="画像内テキスト(例: AI副業 検証レポート)">
        <select id="img-purpose" class="border border-slate-300 rounded-lg p-2 text-sm">
          <option value="thumbnail">X用サムネ(横長)</option>
          <option value="infographic">図解(縦長)</option>
          <option value="note_cover">noteアイキャッチ</option>
        </select>
      </div>
      <input id="img-extra" class="w-full border border-slate-300 rounded-lg p-2.5 text-sm" placeholder="追加指定(任意。例: グラフ要素を入れる)">
      <button id="img-gen-btn" class="bg-brand-orange text-white px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90" ${llmStatus.connected ? '' : 'disabled'}><i class="fas fa-wand-magic-sparkles mr-1"></i>Akiに生成させる(自動でMio審査)</button>
      <div id="img-gen-result"></div>
    </section>

    <section id="image-gallery" class="bg-white rounded-xl shadow p-4">
      <h3 class="font-bold text-sm text-brand-navy mb-3">生成済み画像(${images.length}件)</h3>
      ${images.length ? `<div class="grid grid-cols-2 md:grid-cols-3 gap-3">
        ${images.map((img) => {
          let issues = [];
          try { issues = JSON.parse(img.qa_issues || '[]'); } catch (e) {}
          return `
          <figure class="image-card border border-slate-200 rounded-lg overflow-hidden flex flex-col">
            <img src="/api/images/${esc(img.image_id)}/file" alt="${esc(img.title_text || '')}" class="w-full aspect-video object-cover bg-slate-100" loading="lazy">
            <figcaption class="p-2 space-y-1 flex-1 flex flex-col">
              <div class="flex items-center justify-between gap-1">
                ${imgQaBadge(img.qa_status)}
                <span class="text-[10px] text-slate-400">$${(img.cost_usd || 0).toFixed(3)}</span>
              </div>
              <div class="text-xs font-bold truncate">${esc(img.title_text || '')}</div>
              ${issues.length ? `<div class="text-[10px] text-amber-700 bg-amber-50 rounded p-1">${issues.map((i) => esc(i.detail || '')).join('<br>')}</div>` : ''}
              <div class="flex gap-1 mt-auto pt-1">
                <button class="img-reqa-btn flex-1 bg-blue-50 text-blue-700 border border-blue-200 py-1 rounded text-[10px] font-bold hover:bg-blue-100" data-id="${esc(img.image_id)}"><i class="fas fa-brain mr-0.5"></i>再審査</button>
                <button class="img-del-btn flex-1 bg-slate-100 text-slate-500 py-1 rounded text-[10px] font-bold hover:bg-red-50 hover:text-red-600" data-id="${esc(img.image_id)}"><i class="fas fa-trash mr-0.5"></i>削除</button>
              </div>
            </figcaption>
          </figure>`;
        }).join('')}
      </div>` : '<p class="text-sm text-slate-400 text-center py-6">まだ画像がありません。上のフォームから生成してください。</p>'}
    </section>
  </div>`;

  document.getElementById('img-gen-btn').addEventListener('click', async () => {
    const title = document.getElementById('img-title').value.trim();
    if (!title) { toast('画像内テキストを入力してください', 'error'); return; }
    const btn = document.getElementById('img-gen-btn');
    const box = document.getElementById('img-gen-result');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Akiが生成中→Mioが審査中...(30〜90秒)';
    try {
      const { data: d } = await axios.post('/api/images/generate', {
        purpose: document.getElementById('img-purpose').value,
        title,
        extra: document.getElementById('img-extra').value.trim() || undefined,
      }, { timeout: 180000 });
      toast(`生成完了 (QA: ${d.qa.verdict})`);
      renderImages();
    } catch (e) {
      box.innerHTML = `<div class="mt-2 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">エラー: ${esc(e.response?.data?.error || e.message)}</div>`;
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-1"></i>Akiに生成させる(自動でMio審査)';
    }
  });

  document.querySelectorAll('.img-reqa-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      try {
        const { data: d } = await axios.post(`/api/images/${btn.dataset.id}/qa`, {}, { timeout: 120000 });
        toast(`Mio審査完了: ${d.verdict}${d.summary ? ' — ' + d.summary : ''}`);
        renderImages();
      } catch (e) {
        toast(e.response?.data?.error || '審査に失敗しました', 'error');
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-brain mr-0.5"></i>再審査';
      }
    });
  });

  document.querySelectorAll('.img-del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await axios.delete(`/api/images/${btn.dataset.id}`);
      toast('削除しました');
      renderImages();
    });
  });
}

/* ============ AIコスト可視化 ============ */
let costChart = null;
async function renderCost() {
  const app = document.getElementById('app');
  app.innerHTML = '<div class="text-center py-12 text-slate-400"><i class="fas fa-spinner fa-spin text-2xl"></i></div>';
  const { data } = await axios.get('/api/models/cost');
  const t = data.totals;
  const fmtUsd = (v) => '$' + v.toFixed(2);
  const fmtJpy = (v) => '¥' + Math.round(v).toLocaleString();
  const saving = t.oldClaudeMonthlyUsd - t.monthlyUsd;
  const savingPct = Math.round((saving / t.oldClaudeMonthlyUsd) * 100);

  const modelBadge = (m) => {
    const colors = { 'gpt-5': 'bg-purple-100 text-purple-700 border-purple-300', 'gpt-5-mini': 'bg-blue-100 text-blue-700 border-blue-300', 'gpt-5-nano': 'bg-emerald-100 text-emerald-700 border-emerald-300' };
    return `<span class="inline-block px-2 py-0.5 rounded-full text-xs font-bold border ${colors[m] || 'bg-slate-100 text-slate-600'}">${m}</span>`;
  };

  app.innerHTML = `
  <div class="fade-in space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <h2 class="text-xl font-bold text-brand-navy"><i class="fas fa-microchip mr-2 text-brand-orange"></i>AIモデル構成 & コスト試算 (OpenAI移行プラン)</h2>
      <span class="text-xs text-slate-400">為替: $1 = ¥${data.usdJpy}</span>
    </div>

    <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm">
      <div class="font-bold text-emerald-800 mb-1"><i class="fas fa-key mr-1"></i>OpenAI APIキーで運用可能です</div>
      <p class="text-emerald-700 text-xs leading-relaxed">Anthropicキーは不要。全ワーカーをOpenAI GPT-5ファミリー(gpt-5 / gpt-5-mini / gpt-5-nano)に置き換えた構成です。API呼び出しはOpenAI互換エンドポイント1本に統一されるため、実装もシンプルになります。</p>
    </div>

    <!-- サマリーカード -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div class="text-xs text-slate-400 mb-1">1日あたり</div>
        <div class="text-2xl font-bold text-brand-navy">${fmtUsd(t.dailyUsd)}</div>
        <div class="text-xs text-slate-500">${fmtJpy(t.dailyUsd * data.usdJpy)}/日</div>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div class="text-xs text-slate-400 mb-1">月額 (30日)</div>
        <div class="text-2xl font-bold text-brand-orange">${fmtUsd(t.monthlyUsd)}</div>
        <div class="text-xs text-slate-500">${fmtJpy(t.monthlyJpy)}/月</div>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div class="text-xs text-slate-400 mb-1">旧Claude構成 (月額)</div>
        <div class="text-2xl font-bold text-slate-400 line-through">${fmtUsd(t.oldClaudeMonthlyUsd)}</div>
        <div class="text-xs text-slate-500">${fmtJpy(t.oldClaudeMonthlyUsd * data.usdJpy)}/月</div>
      </div>
      <div class="bg-white rounded-xl shadow-sm border-2 border-emerald-300 p-4">
        <div class="text-xs text-emerald-600 mb-1 font-bold">OpenAI移行で削減</div>
        <div class="text-2xl font-bold text-emerald-600">-${savingPct}%</div>
        <div class="text-xs text-emerald-600">${fmtJpy(saving * data.usdJpy)}/月 お得</div>
      </div>
    </div>

    <!-- チャート + モデル料金表 -->
    <div class="grid md:grid-cols-2 gap-4">
      <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <h3 class="font-bold text-brand-navy text-sm mb-3"><i class="fas fa-chart-bar mr-1"></i>ワーカー別 月額コスト (USD)</h3>
        <canvas id="cost-chart" height="230"></canvas>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <h3 class="font-bold text-brand-navy text-sm mb-3"><i class="fas fa-tags mr-1"></i>モデル料金表 (USD / 100万トークン)</h3>
        <table class="w-full text-xs">
          <thead><tr class="text-slate-400 border-b"><th class="text-left py-2">モデル</th><th class="text-left">位置づけ</th><th class="text-right">入力</th><th class="text-right">出力</th></tr></thead>
          <tbody>
            ${Object.entries(data.pricing).map(([id, p]) => `
            <tr class="border-b border-slate-100">
              <td class="py-2">${modelBadge(id)}</td>
              <td class="text-slate-600">${esc(p.tier)}</td>
              <td class="text-right font-mono">$${p.input.toFixed(2)}</td>
              <td class="text-right font-mono">$${p.output.toFixed(2)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div class="mt-3 space-y-1">
          ${data.byModel.map((m) => `
          <div class="flex items-center justify-between text-xs bg-slate-50 rounded-lg px-3 py-2">
            <div>${modelBadge(m.model)} <span class="text-slate-500 ml-1">${m.workers.join(', ')}</span></div>
            <div class="font-mono font-bold">${fmtUsd(m.monthlyCostUsd)}/月</div>
          </div>`).join('')}
        </div>
      </div>
    </div>

    <!-- ワーカー別詳細テーブル -->
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4 overflow-x-auto">
      <h3 class="font-bold text-brand-navy text-sm mb-3"><i class="fas fa-users mr-1"></i>ワーカー別 モデル割当と試算根拠</h3>
      <table class="w-full text-xs min-w-[900px]">
        <thead>
          <tr class="text-slate-400 border-b">
            <th class="text-left py-2">ワーカー</th><th class="text-left">推奨モデル</th><th class="text-left">旧構成</th>
            <th class="text-left">1日のタスク</th><th class="text-right">呼出/日</th><th class="text-right">トークン/日</th>
            <th class="text-right">円/月</th>
          </tr>
        </thead>
        <tbody>
          ${data.rows.map((r) => `
          <tr class="border-b border-slate-100 hover:bg-slate-50">
            <td class="py-2 whitespace-nowrap">${r.icon} <b>${esc(r.name)}</b><div class="text-slate-400">${esc(r.role)}</div></td>
            <td>${modelBadge(r.model)}</td>
            <td class="text-slate-400 line-through whitespace-nowrap">${esc(r.oldModel)}</td>
            <td class="text-slate-600 max-w-[260px]"><div>${esc(r.dailyTasks)}</div><div class="text-[10px] text-slate-400 mt-0.5">${esc(r.reason)}</div></td>
            <td class="text-right font-mono">${r.dailyCalls}</td>
            <td class="text-right font-mono whitespace-nowrap">入 ${(r.dailyInputTokens / 1000).toFixed(0)}k<br>出 ${(r.dailyOutputTokens / 1000).toFixed(0)}k</td>
            <td class="text-right font-mono font-bold text-brand-navy whitespace-nowrap">${fmtJpy(r.monthlyCostJpy)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr class="font-bold text-brand-navy">
            <td class="py-2" colspan="6" class="text-right">合計</td>
            <td class="text-right font-mono text-brand-orange">${fmtJpy(t.monthlyJpy)}/月</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- 注意事項 -->
    <div class="bg-amber-50 border border-amber-200 rounded-xl p-4">
      <h3 class="font-bold text-amber-800 text-sm mb-2"><i class="fas fa-circle-info mr-1"></i>前提・注意事項</h3>
      <ul class="text-xs text-amber-700 space-y-1 list-disc pl-4">
        ${data.notes.map((n) => `<li>${esc(n)}</li>`).join('')}
      </ul>
    </div>
  </div>`;

  // チャート描画
  if (costChart) { costChart.destroy(); costChart = null; }
  const colorFor = (m) => m === 'gpt-5' ? '#9333ea' : m === 'gpt-5-mini' ? '#2563eb' : '#059669';
  costChart = new Chart(document.getElementById('cost-chart'), {
    type: 'bar',
    data: {
      labels: data.rows.map((r) => `${r.name} (${r.role.split('/')[0]})`),
      datasets: [{
        label: '月額コスト (USD)',
        data: data.rows.map((r) => +r.monthlyCostUsd.toFixed(3)),
        backgroundColor: data.rows.map((r) => colorFor(r.model)),
        borderRadius: 6,
      }],
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` $${ctx.raw}/月 (¥${Math.round(ctx.raw * data.usdJpy).toLocaleString()})` } } },
      scales: { x: { ticks: { callback: (v) => '$' + v } } },
    },
  });
}

/* ============ ルーティング ============ */
function navigate(view) {
  currentView = view;
  setNav(view);
  if (officeTimer) { clearInterval(officeTimer); officeTimer = null; }
  if (view === 'office') {
    renderOffice();
    officeTimer = setInterval(() => { if (currentView === 'office') renderOffice(); }, 15000);
  }
  else if (view === 'approve') renderApprove();
  else if (view === 'kpi') renderKPI();
  else if (view === 'qa') renderQA();
  else if (view === 'affiliate') renderAffiliate();
  else if (view === 'cost') renderCost();
  else if (view === 'images') renderImages();
}
window.navigate = navigate;

document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.view)));

/* ============ 認証(メール+パスワード) ============ */
function renderLogin(registered) {
  document.getElementById('app-header')?.classList.add('hidden');
  $app.innerHTML = `
  <div class="fade-in min-h-[80vh] flex items-center justify-center">
    <div class="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
      <div class="text-center mb-6">
        <div class="text-4xl mb-2">🏢</div>
        <h1 class="font-bold text-xl text-brand-navy">AI Virtual Office</h1>
        <p class="text-sm text-slate-500 mt-1">Mさん / 海外AI副業の検証部屋</p>
      </div>
      ${registered ? '' : `<div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 mb-4"><i class="fas fa-key mr-1"></i>初回設定: 許可されたメールアドレスと新しいパスワード(8文字以上)を登録してください</div>`}
      <form id="login-form" class="space-y-4">
        <div>
          <label class="block text-xs font-bold text-slate-600 mb-1">メールアドレス</label>
          <input id="login-email" type="email" required class="w-full border rounded-lg px-3 py-2 text-sm" placeholder="you@example.com" autocomplete="username">
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-600 mb-1">パスワード${registered ? '' : '(8文字以上・新規設定)'}</label>
          <input id="login-password" type="password" required minlength="8" class="w-full border rounded-lg px-3 py-2 text-sm" autocomplete="${registered ? 'current-password' : 'new-password'}">
        </div>
        <button type="submit" class="w-full bg-brand-navy text-white py-2.5 rounded-lg font-bold text-sm hover:opacity-90">
          <i class="fas ${registered ? 'fa-right-to-bracket' : 'fa-user-plus'} mr-1"></i>${registered ? 'ログイン' : '初回登録して開始'}
        </button>
        <p id="login-error" class="hidden text-xs text-red-600 text-center"></p>
      </form>
    </div>
  </div>`;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    try {
      await axios.post(registered ? '/api/auth/login' : '/api/auth/register', { email, password });
      location.reload();
    } catch (err) {
      errEl.textContent = err.response?.data?.error || '認証に失敗しました';
      errEl.classList.remove('hidden');
    }
  });
}

// 401を検知したらログイン画面へ
axios.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && err.response?.data?.needLogin) {
      axios.get('/api/auth/status').then(({ data }) => renderLogin(data.registered)).catch(() => renderLogin(true));
      return new Promise(() => {}); // 後続処理を止める
    }
    return Promise.reject(err);
  }
);

async function boot() {
  try {
    const { data } = await axios.get('/api/auth/status');
    if (!data.loggedIn) { renderLogin(data.registered); return; }
    document.getElementById('app-header')?.classList.remove('hidden');
    // ログアウトボタンをヘッダーに追加
    const nav = document.querySelector('#app-header nav');
    if (nav && !document.getElementById('logout-btn')) {
      const btn = document.createElement('button');
      btn.id = 'logout-btn';
      btn.className = 'px-3 py-2 rounded-lg hover:bg-white/10 text-xs text-white/70';
      btn.innerHTML = '<i class="fas fa-right-from-bracket mr-1"></i>ログアウト';
      btn.addEventListener('click', async () => { await axios.post('/api/auth/logout'); location.reload(); });
      nav.appendChild(btn);
    }
    navigate('office');
    updateApprovalBadge();
    setInterval(updateApprovalBadge, 30000);
  } catch (e) {
    renderLogin(true);
  }
}
boot();
