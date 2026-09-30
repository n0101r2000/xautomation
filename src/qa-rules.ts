// 08章: QAルールDB(禁止表現・法令チェック)— Mio が使用する実動ロジック

export const FORBIDDEN_RULES: Record<string, { label: string; law: string; words: string[] }> = {
  absolute_guarantee: {
    label: '断定的保証表現',
    law: '景品表示法(優良誤認)',
    words: ['絶対', '必ず稼げる', '確実に稼げる', '誰でも稼げる', '簡単に稼げる', '不労所得', '完全放置', '自動で稼ぐ', '楽して稼']
  },
  medical_overreach: {
    label: '医療・効能の誇大表現',
    law: '薬機法',
    words: ['治る', '治す', '効く', '副作用なし', '医師も推奨', 'に効果あり']
  },
  financial_advice: {
    label: '投資助言・断定的判断',
    law: '金融商品取引法',
    words: ['買うべき', '今買え', '絶対に上がる', '元本保証', 'リスクゼロ', '確実に儲かる']
  },
  misleading: {
    label: '優良誤認のおそれ',
    law: '景品表示法',
    words: ['業界No.1', '日本一', '世界初', '唯一の']
  },
  ai_style: {
    label: 'AIっぽい定型表現',
    law: '文体ガイドライン(人が書いた文章にする)',
    words: ['刺さる', '刺さり', 'が効く', 'に効く', '結論から言うと', '結論からいうと', 'いかがでしたか', 'いかがだったでしょうか', '解説していきます', '深掘りしていきます', '見ていきましょう', '注目すべきは', '見逃せないのは', 'ポイントは3つ', 'ポイントは以下', '徹底解説します', '完全ガイド', '爆速', '神ツール', '最強の', 'ゲームチェンジャー', '革命的']
  }
}

export interface QaIssue {
  rule: string
  law: string
  matched: string
  detail: string
  severity: 'needs_fix' | 'ng'
}

export interface QaResult {
  status: 'ok' | 'needs_fix' | 'ng'
  issues: QaIssue[]
  checked_at: string
}

/** テキストを禁止表現ルールでチェックする(Mioのコアロジック) */
export function runQaCheck(text: string, hasAffiliateLink = false): QaResult {
  const issues: QaIssue[] = []

  for (const [key, rule] of Object.entries(FORBIDDEN_RULES)) {
    for (const word of rule.words) {
      if (text.includes(word)) {
        issues.push({
          rule: rule.label,
          law: rule.law,
          matched: word,
          detail: `「${word}」は${rule.law}に抵触するおそれがあります。断定を避けた表現(例:「〜な印象」「〜っぽい」)に修正してください。`,
          severity: key === 'financial_advice' || key === 'medical_overreach' ? 'ng' : 'needs_fix'
        })
      }
    }
  }

  // ステマ規制: アフィリンク付きなのにPR表記がない場合
  if (hasAffiliateLink && !text.includes('PR') && !text.includes('アフィリエイト')) {
    issues.push({
      rule: 'ステマ規制',
      law: '景品表示法(2023年10月施行 指定告示)',
      matched: '(PR表記なし)',
      detail: 'アフィリエイトリンクを含む投稿には「#PR」または「アフィリエイトリンクを含みます」の表記が必要です。',
      severity: 'needs_fix'
    })
  }

  const hasNg = issues.some((i) => i.severity === 'ng')
  return {
    status: hasNg ? 'ng' : issues.length > 0 ? 'needs_fix' : 'ok',
    issues,
    checked_at: new Date().toISOString()
  }
}
