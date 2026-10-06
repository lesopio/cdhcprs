/**
 * 活动轨迹 —— Kimi 风格时间线（2026-09-30 按用户参考图重做）
 *
 * 设计（对照 docs 之外的用户参考截图）：
 * - 折叠态：一行最新活动摘要 + 展开箭头（不做重面板框）；
 * - 展开态：左侧竖线时间线，每步 = 能力图标 + 步骤名（含「N 条结果」）+ 可展开的
 *   来源明细列表（标题居左、域名/路径居右，参考图来源列表样式）；
 * - skipped 步骤整体不渲染（参考图只展示实际发生的活动，「未配置，已跳过」无信息量）；
 * - 全部完成时摘要行显示「思考已完成」；仍在生成时摘要行为当前步骤 + thinking-dots。
 * - 正文与轨迹之间用 hairline 分隔（参考图布局）。
 *
 * 图标按 step.id 映射（vl=图片分析、generate_queries=检索词、web_search=网络搜索、
 * knowledge_base=知识库、external_kb=指南共识库、rerank=证据重排、synthesis=证据整合），
 * 未知 id 兜底 generic 图标。
 */
import { useEffect, useRef, useState } from 'react'
import MaterialIcon from '@/components/MaterialIcon'
import type { TraceStep } from '@/lib/chat-types'
/** 能力图标映射（按 step.id，未识别的按关键字兜底） */
function stepIcon(id: string, title: string): string {
  const table: Record<string, string> = {
    vl: 'image_search',
    generate_queries: 'edit_note',
    web_search: 'travel_explore',
    knowledge_base: 'menu_book',
    external_kb: 'verified',
    mirror: 'cloud_done',
    rerank: 'sort',
    synthesis: 'merge_type',
  }
  if (table[id]) return table[id]
  if (/搜索|检索/.test(title)) return 'travel_explore'
  if (/权威|指南|知识/.test(title)) return 'verified'
  if (/镜像/.test(title)) return 'cloud_done'
  if (/图片/.test(title)) return 'image_search'
  if (/证据|整合|摘要/.test(title)) return 'merge_type'
  return 'bolt'
}

/** 从 details/summary 中提取「标题 + 域名或路径」的来源条目（参考图来源列表样式） */
function extractSources(step: TraceStep): Array<{ label: string; host: string }> {
  const out: Array<{ label: string; host: string }> = []
  const push = (raw: unknown) => {
    if (typeof raw !== 'string') return
    // 形如「标题 - https://host/path」或「标题 | 域名」或纯标题
    const m = raw.match(/^(.{2,80}?)\s*(?:-|｜|\|)\s*((?:https?:\/\/)?[\w.-]+\.[a-z]{2,}(?:\/[^\s]*)?)$/i)
    if (m) {
      let host = m[2].replace(/^https?:\/\//, '')
      host = host.split('/')[0]
      out.push({ label: m[1].trim(), host })
    } else {
      out.push({ label: raw.trim().slice(0, 60), host: '' })
    }
  }
  if (Array.isArray(step.details)) step.details.forEach(push)
  // 网络搜索步骤把来源标题并入 summary 的场景：无 details 时从 summary 的「·」分段提取
  if (!out.length && step.id === 'web_search' && step.summary) {
    step.summary.split(/[·•]\s*/).forEach((seg) => { if (seg.trim()) push(seg.trim()) })
  }
  return out.slice(0, 12)
}

interface Props {
  trace: TraceStep[]
  /** 证据整合阶段的模型思考（并入 evidence 轨迹步骤内展示） */
  thinkingEvidence?: string
  /** 正文生成前的模型思考（时间线末尾独立一步「组织回答」） */
  thinkingAnswer?: string
  /** 正文思考是否仍在增长（生成中）——影响时间线自动展开/折叠 */
  answerThinkingStreaming?: boolean
}

export default function ActivityTrace({ trace, thinkingEvidence, thinkingAnswer, answerThinkingStreaming }: Props) {
  // 生成中自动展开、完成后 1.2s 自动折叠；用户手动开合后以手动为准（manualRef）
  const [open, setOpen] = useState(false)
  const manualRef = useRef(false)
  const prevRunningRef = useRef(false)
  const isRunningNow = answerThinkingStreaming || (trace || []).some((s) => s.status === 'running')

  useEffect(() => {
    if (isRunningNow && !prevRunningRef.current && !manualRef.current) setOpen(true)
    if (!isRunningNow && prevRunningRef.current) {
      const t = setTimeout(() => { if (!manualRef.current) setOpen(false) }, 1200)
      prevRunningRef.current = isRunningNow
      return () => clearTimeout(t)
    }
    prevRunningRef.current = isRunningNow
  }, [isRunningNow])

  // 思考容器流式自动滚底（与主会话跟随口径一致）：正在运行的步骤内的 .tl-thought
  // 无条件跟随最新行——打字机每帧增量小，跟随即所见；完成后停止干预（用户可自由滚动回看）
  const rootRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.querySelectorAll('.tl-step.running .tl-thought').forEach((el) => {
      const box = el as HTMLElement
      box.scrollTop = box.scrollHeight
    })
  }, [thinkingEvidence, thinkingAnswer, trace])

  // skipped 不渲染。注意：useSseChat 对 message.trace 就地 push（数组引用不变），
  // 这里不能用 useMemo([trace]) 缓存——流式期间引用不变会导致时间线永远不更新，必须每次过滤
  const visible = (trace || []).filter((s) => s.status !== 'skipped')
  const hasContent = visible.length > 0 || !!thinkingEvidence || !!thinkingAnswer
  if (!hasContent) return null

  const running = visible.find((s) => s.status === 'running')
  const failed = visible.find((s) => s.status === 'failed')
  const finished = !running && !answerThinkingStreaming
  const latest = visible[visible.length - 1]
  // 折叠摘要行：轨迹步运行中→当前步骤；正文思考阶段（无 running 轨迹步）→「正在组织回答…」
  const summaryText = running
    ? running.summary || running.title
    : answerThinkingStreaming
    ? '正在组织回答…'
    : failed
    ? failed.summary || '生成失败'
    : latest.summary || latest.title

  return (
    <details
      ref={rootRef}
      className="trace-timeline"
      open={open}
      onToggle={(e) => {
        // 用户手动开合时记录，停止自动干预；程序化 setOpen 不触发原生 onToggle
        manualRef.current = (e.currentTarget as HTMLDetailsElement).open !== open
      }}
    >
      <summary>
        <span className="trace-timeline-label">
          {running || answerThinkingStreaming ? (
            <>
              <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>
              <em>{summaryText}</em>
            </>
          ) : finished && !failed ? (
            <>思考已完成</>
          ) : (
            <>生成失败：{summaryText}</>
          )}
        </span>
        <MaterialIcon name="expand_more" size={16} />
      </summary>
      <div className="trace-timeline-body">
        <ol className="timeline">
          {visible.map((step, i) => {
            const sources = extractSources(step)
            const isLast = i === visible.length - 1
            // 证据整合步骤：其思考（thinkingEvidence）并入步骤体内展示
            const stepThought = step.id === 'evidence' ? thinkingEvidence : undefined
            return (
              <li key={step.id} className={`tl-step ${step.status}${isLast && !thinkingAnswer ? ' last' : ''}`}>
                <span className="tl-node">
                  {step.status === 'running' ? (
                    <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>
                  ) : step.status === 'failed' ? (
                    <MaterialIcon name="error" size={16} />
                  ) : (
                    <MaterialIcon name={stepIcon(step.id, step.title)} size={16} />
                  )}
                </span>
                <div className="tl-body">
                  <div className="tl-title-row">
                    <span className="tl-title">
                      {step.status === 'running' ? step.title : step.title}
                      {step.count != null && <small>（{step.count} 条结果）</small>}
                      {step.status === 'running' && <small>进行中…</small>}
                    </span>
                    {step.summary && step.status !== 'running' && (
                      <span className="tl-summary">{step.summary}</span>
                    )}
                  </div>
                  {stepThought && <div className="tl-thought">{stepThought}</div>}
                  {sources.length > 0 && (
                    <ul className="tl-sources">
                      {sources.map((s, si) => (
                        <li key={si}>
                          <span className="tl-source-label">{s.label}</span>
                          {s.host && <span className="tl-source-host">{s.host}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            )
          })}
          {thinkingAnswer && (
            <li className={`tl-step thinking${answerThinkingStreaming ? ' running' : ''}${finished && !failed ? '' : ' last'}`}>
              <span className="tl-node">
                {answerThinkingStreaming ? (
                  <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>
                ) : (
                  <MaterialIcon name="neurology" size={16} />
                )}
              </span>
              <div className="tl-body">
                <div className="tl-title-row">
                  <span className="tl-title">组织回答</span>
                  {answerThinkingStreaming && <small>进行中…</small>}
                </div>
                <div className="tl-thought">{thinkingAnswer}</div>
              </div>
            </li>
          )}
          {finished && !failed && (
            <li className="tl-step done-mark last">
              <span className="tl-node"><MaterialIcon name="check" size={16} /></span>
              <div className="tl-body"><span className="tl-title">思考已完成</span></div>
            </li>
          )}
        </ol>
      </div>
      <style>{`
        /* Kimi 风格时间线：无面板框，折叠一行 + 展开竖线时间线 */
        .trace-timeline{border-bottom:1px solid var(--color-borderLight);padding:2px 2px 10px;margin-bottom:10px}
        .trace-timeline>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;padding:4px 2px;font-size:13px;color:var(--color-textTertiary)}
        .trace-timeline>summary::-webkit-details-marker{display:none}
        .trace-timeline>summary>.material-symbol{margin-left:auto;transition:transform .2s;color:var(--color-textTertiary)}
        .trace-timeline[open]>summary>.material-symbol{transform:rotate(180deg)}
        .trace-timeline-label{display:inline-flex;align-items:center;gap:8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .trace-timeline-label em{font-style:normal;color:var(--color-textSecondary)}
        .trace-timeline-body{padding:6px 2px 2px}
        .timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
        .tl-step{position:relative;display:grid;grid-template-columns:26px 1fr;gap:8px;padding:6px 0;font-size:13px}
        /* 竖线：连接相邻节点 */
        .tl-step:not(.last)::before{content:'';position:absolute;left:12px;top:26px;bottom:-6px;width:2px;background:var(--color-borderLight);border-radius:1px}
        .tl-node{width:26px;height:26px;border-radius:9999px;background:var(--color-bgSecondary);display:flex;align-items:center;justify-content:center;color:var(--color-textSecondary);flex:0 0 26px}
        .tl-step.completed .tl-node{color:var(--color-textPrimary)}
        .tl-step.failed .tl-node{color:var(--color-danger,#C0392B)}
        .tl-step.running .tl-node{background:var(--color-primarySoft);color:var(--color-textPrimary)}
        .tl-step.running .thinking-dots{height:14px}
        .tl-step.running .thinking-dots>span{width:3px;height:3px}
        .tl-title-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
        .tl-summary{overflow-wrap:anywhere;word-break:break-word;white-space:normal;max-width:100%}
        .tl-source-label{overflow-wrap:anywhere;word-break:break-word}
        .tl-step{min-width:0}
        .tl-body{min-width:0;overflow:hidden}
        .tl-title{color:var(--color-textPrimary);font-weight:500}
        .tl-step.skipped .tl-title{color:var(--color-textTertiary)}
        .tl-title small{color:var(--color-textTertiary);font-weight:400;margin-left:4px}
        .tl-summary{color:var(--color-textTertiary);font-size:12px;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
        .tl-sources{list-style:none;margin:6px 0 0;padding:6px 10px;background:var(--color-bgSecondary);border-radius:10px;display:flex;flex-direction:column;gap:4px;max-width:640px}
        .tl-sources li{display:flex;align-items:baseline;gap:10px;font-size:12px;color:var(--color-textSecondary);min-width:0}
        .tl-source-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .tl-source-host{color:var(--color-textTertiary);font-size:11px;flex:0 0 auto}
        /* 思考过程步骤：弱化小字 + 限高内滚（超长思维链防溢出）；完成后收成摘要高度 */
        .tl-thought{margin-top:4px;font-size:12px;color:var(--color-textTertiary);line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;scrollbar-width:thin;border-left:2px solid var(--color-borderLight);padding-left:10px}
        /* 步骤完成后思考收窄为预览高度（流式 200px 全展开会把时间线撑出容器） */
        .tl-step:not(.running) .tl-thought{max-height:72px}
        .done-mark .tl-title{color:var(--color-textTertiary);font-weight:400}
        @media (prefers-reduced-motion:reduce){.thinking-dots>span{animation:none}}
        @media print{.trace-timeline{display:none}}
        /* 手机窄屏基础档（≤680）：时间线节点 26→22px 收窄缩进、字号微降，摘要行触控 ≥44px（::after 扩大热区不改外观） */
        @media (max-width:680px){
          .trace-timeline{padding:0 0 8px;margin-bottom:8px}
          .trace-timeline>summary{position:relative;padding:10px 2px;font-size:12px}
          .trace-timeline>summary::after{content:'';position:absolute;inset:-4px}
          .trace-timeline-body{padding:4px 0 0}
          .tl-step{grid-template-columns:22px 1fr;gap:6px;font-size:12px;padding:5px 0}
          .tl-step:not(.last)::before{left:10px;top:22px}
          .tl-node{width:22px;height:22px;flex:0 0 22px}
          .tl-sources{padding:6px 8px;margin-top:5px}
          .tl-sources li{gap:6px}
          .tl-thought{padding-left:8px}
        }
      `}</style>
    </details>
  )
}
