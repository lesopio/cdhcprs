/**
 * 引用清单（迁移自 Vue CitationList.vue）
 * 按来源类型分组，给每条配 <li id="cite-N"> 锚点（MarkdownRenderer 的 [N] 上标会跳到这里）。
 *
 * 2026-09 中性单色化（docs/ui-spec-v3-monochrome.md §3）：去虚线分隔与四色徽章，
 * 收成小号链接行 —— 组标题为弱化灰文本（分组信息保留、徽章底色全撤），
 * 链接统一规格蓝 var(--color-link,#2F6FA8)，hover 下划线；senior 档字号不变。
 */
import { useMemo } from 'react'
import MaterialIcon from '@/components/MaterialIcon'
import type { CitationItem } from '@/lib/chat-types'

const TYPE_META: Record<string, { label: string; cls: string; order: number }> = {
  authoritative: { label: '权威医学库', cls: 'tag-authoritative', order: 0 },
  guideline: { label: '诊疗指南', cls: 'tag-guideline', order: 1 },
  consensus: { label: '专家共识', cls: 'tag-consensus', order: 2 },
  literature: { label: '文献研究', cls: 'tag-literature', order: 3 },
  knowledge: { label: '知识库', cls: 'tag-knowledge', order: 4 },
  mirror: { label: '网络镜像 · 非权威', cls: 'tag-mirror', order: 5 },
  web: { label: '网络来源 · 非权威', cls: 'tag-web', order: 6 },
}

interface Props {
  citations: CitationItem[]
  senior?: boolean
}

export default function CitationList({ citations, senior }: Props) {
  const grouped = useMemo(() => {
    const buckets = new Map<string, CitationItem[]>()
    for (const item of citations) {
      const key = item.type || item.source || 'web'
      const arr = buckets.get(key) || []
      arr.push(item)
      buckets.set(key, arr)
    }
    return Array.from(buckets.entries())
      .map(([type, items]) => {
        const meta = TYPE_META[type] || { label: '其他来源', cls: 'tag-other', order: 99 }
        return { type, label: meta.label, typeClass: meta.cls, order: meta.order, items }
      })
      .sort((a, b) => a.order - b.order)
  }, [citations])

  if (!grouped.length) return null

  return (
    <div className={`citation-list${senior ? ' senior' : ''}`}>
      <div className="citation-title">
        <MaterialIcon name="menu_book" size={16} />
        <span>参考来源（仅供参考，请以医生诊断为准）</span>
      </div>
      {grouped.map((group) => (
        <div key={group.type} className="citation-group">
          <div className="group-label">
            <span className={`type-tag ${group.typeClass}`}>{group.label}</span>
            <span className="group-count">{group.items.length} 条</span>
          </div>
          <ol className="citation-items">
            {group.items.map((item) => (
              <li
                key={`${group.type}-${item.id}`}
                className="citation-item"
                id={item.id ? `cite-${item.id}` : undefined}
              >
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="citation-link"
                  >
                    <span className="citation-index">[{item.id}]</span>
                    <span className="citation-name">{item.title || item.url}</span>
                    <MaterialIcon name="open_in_new" size={13} />
                  </a>
                ) : (
                  <span className="citation-link">
                    <span className="citation-index">[{item.id}]</span>
                    <span className="citation-name">{item.title}</span>
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}
      <style>{`
        /* 中性单色（规格 §3）：hairline 实线分隔、弱化灰组标题、小号规格蓝链接行 */
        .citation-list{margin-top:18px;padding-top:14px;border-top:1px solid var(--color-borderPrimary)}
        .citation-title{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--color-textTertiary);font-weight:600;margin-bottom:10px}
        .citation-group{margin-bottom:10px}
        .group-label{display:flex;align-items:center;gap:8px;margin-bottom:4px}
        .type-tag{font-size:11px;padding:0;border-radius:0;font-weight:600;background:transparent;color:var(--color-textTertiary)}
        .group-count{font-size:11px;color:var(--color-textTertiary)}
        .tag-guideline,.tag-consensus,.tag-literature,.tag-knowledge,.tag-web,.tag-mirror,.tag-authoritative,.tag-other{background:transparent;color:var(--color-textTertiary)}
        .tag-mirror,.tag-web{color:var(--color-textTertiary)}
        .citation-items{list-style:none;margin:0;padding:0}
        .citation-item{margin:3px 0}
        .citation-link{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1.6;color:var(--color-link,#2F6FA8);text-decoration:none;max-width:100%}
        .citation-link:hover{text-decoration:underline}
        .citation-index{color:var(--color-textTertiary);flex:0 0 auto}
        .citation-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:480px}
        .citation-list.senior .citation-title{font-size:18px;gap:10px;margin-bottom:16px}
        .citation-list.senior .type-tag{font-size:16px;padding:4px 14px}
        .citation-list.senior .group-count{font-size:15px}
        .citation-list.senior .citation-link{font-size:18px;gap:8px}
        .citation-list.senior .citation-name{white-space:normal;max-width:none;line-height:1.6}
        /* 手机窄屏基础档（≤680）：长标题由单行省略改为换行，链接行加高到 ≥44px 触控 */
        @media (max-width:680px){
          .citation-list{margin-top:14px;padding-top:12px}
          .citation-link{padding:12px 0;font-size:13px;align-items:flex-start}
          .citation-name{white-space:normal;overflow-wrap:anywhere}
          .group-count{margin-left:auto}
        }
      `}</style>
    </div>
  )
}
