/**
 * AI 主动问诊的分步问诊卡（todo A3）
 *
 * 与 IntakeOptions（单条追问气泡）的区别：把后端 intake.turn 逐条追加的多轮问题
 * 收进同一张白底轻卡片（2026-09 按 docs/ui-spec-v3-monochrome.md §3 单色化：16px 圆角 +
 * hairline #E5E5E5 描边 + float 阴影，选中态 #EDEDED 填充 + 近黑对勾，「提交并继续」主按钮近黑），
 * 卡内做「上一问 / 下一问」步骤导航，逐题作答、按序提交；
 * 后端 intake SSE 协议不变，questions / answers 仍由父组件按消息流状态维护。
 *
 * 交互语义（沿用 IntakeOptions 的单选/多选约定）：
 * - 单选题（该题全部 multi=false）：点击选项立即 onAnswer(idx, [label])
 * - 多选题（存在 multi=true）：勾选只改本地暂存，点「提交并继续」后 onAnswer(idx, selections)
 * - answers[i] 为空数组表示第 i 问未作答；只有最后一问未作答时可作答，
 *   已作答的题只读显示已选 chips；submitting 期间禁用按钮、锁定作答。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import MaterialIcon from '@/components/MaterialIcon'
import type { IntakeOption } from '@/lib/chat-types'

interface Props {
  /** 后端 intake.turn 逐条追加的问题序列：questions[i] 即第 i 问 */
  questions: Array<{ reply: string; options: IntakeOption[] }>
  /** answers[i] 为第 i 问已提交的选项；空数组（或缺项）表示未作答 */
  answers: string[][]
  /** 提交请求进行中：禁用全部按钮，防止重复回传 */
  submitting: boolean
  onAnswer: (questionIndex: number, selections: string[]) => void
}

/** 空勾选集合：切到没有暂存勾选的题目时复用同一实例（永不原地修改） */
const EMPTY_SELECTION: ReadonlySet<string> = new Set()

export default function IntakeStepCard({ questions, answers, submitting, onAnswer }: Props) {
  const [current, setCurrent] = useState(0)
  // 多选题的临时勾选：记录“属于哪一题”，切题后旧勾选在派生时直接失效，省去清理副作用
  const [pending, setPending] = useState<{ index: number; set: Set<string> }>(() => ({
    index: 0,
    set: new Set(),
  }))
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // 上一次展示的题号：用于推断切换方向（前进从右滑入、后退从左滑入）
  const prevIndexRef = useRef<number | null>(null)

  const total = questions.length
  // 渲染用的安全题号：题目列表意外收缩时避免越界
  const index = total === 0 ? 0 : Math.min(Math.max(current, 0), total - 1)
  const question = total > 0 ? questions[index] : undefined
  const selections = index < answers.length ? answers[index] : undefined
  const answered = (selections?.length ?? 0) > 0
  const isLast = index === total - 1
  // 与 IntakeOptions 同语义：存在 multi=true 即多选场景，否则全部视为单选
  const isMulti = question?.options.some((option) => option.multi) ?? false
  const pendingSet = pending.index === index ? pending.set : EMPTY_SELECTION
  // 只有最后一问未作答时可作答；submitting 期间一并锁死
  const interactive = isLast && !answered && !submitting

  // questions.length 变化（后端经 intake SSE 追加新问）→ 自动跳到最新的未作答题。
  // 有意不把 answers 列入依赖：用户作答本身不应把视图拽走，题目数量才是跳题信号。
  useEffect(() => {
    if (total === 0) return
    for (let i = total - 1; i >= 0; i -= 1) {
      if ((answers[i]?.length ?? 0) === 0) {
        setCurrent(i)
        return
      }
    }
    setCurrent(total - 1) // 全部已答：停在最后一问供回看
  }, [total])

  // 题目切换过渡：fade + 横移。用 useLayoutEffect 在首帧绘制前设好初值，避免新题闪现一帧；
  // 命中系统「减弱动态效果」时跳过动画（仍更新 prevIndexRef 保持方向推断正确）。
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const prev = prevIndexRef.current
    prevIndexRef.current = index
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const dir = prev === null || index >= prev ? 1 : -1
    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { opacity: 0, x: 26 * dir },
        { opacity: 1, x: 0, duration: 0.36, ease: 'power2.out', clearProps: 'all' },
      )
    }, bodyRef)
    return () => ctx.revert()
  }, [index, total])

  // 单选：点击立即提交（与 IntakeOptions 单选语义一致，选项本身没有持久选中态）
  const answerSingle = (label: string) => {
    if (!interactive) return
    onAnswer(index, [label])
  }

  // 多选：勾选/取消只改本地暂存，等「提交并继续」统一回传
  const togglePending = (label: string) => {
    if (!interactive) return
    setPending((prev) => {
      const base = new Set(prev.index === index ? prev.set : EMPTY_SELECTION)
      if (base.has(label)) {
        base.delete(label)
      } else {
        base.add(label)
      }
      return { index, set: base }
    })
  }

  // 多选提交：Set 按勾选顺序迭代，回传顺序与用户点击顺序一致
  const submitMulti = () => {
    if (!interactive || pendingSet.size === 0) return
    onAnswer(index, Array.from(pendingSet))
  }

  const answeredCount = answers.reduce((count, item) => (item.length > 0 ? count + 1 : count), 0)

  if (!question) return null

  return (
    <section className="isc-card">
      {/* 卡头：标题 + 进度文字 + 圆点指示（圆点纯装饰，信息由文字与 aria-label 承载） */}
      <header className="isc-head">
        <div className="isc-title">
          <MaterialIcon name="smart_toy" size={20} />
          <h3>AI 主动问诊</h3>
        </div>
        <div
          className="isc-progress"
          aria-label={`第 ${index + 1} 问，共 ${total} 问，已答 ${answeredCount} 问`}
        >
          <span className="isc-progress-text">
            第 {index + 1} 问 · 已答 {answeredCount}
          </span>
          <span className="isc-dots" aria-hidden="true">
            {questions.map((_, i) => {
              const done = (answers[i]?.length ?? 0) > 0
              return <span key={i} className={`isc-dot${done ? ' done' : ''}${i === index ? ' current' : ''}`} />
            })}
          </span>
        </div>
      </header>

      {/* 卡体：当前题的 reply + 选项网格 / 已答 chips */}
      <div className="isc-body" ref={bodyRef}>
        {question.reply && <p className="isc-reply">{question.reply}</p>}
        {selections && selections.length > 0 ? (
          <div className="isc-answered">
            <span className="isc-answered-tag">
              <MaterialIcon name="check_circle" size={16} />
              已作答
            </span>
            <span className="isc-chips">
              {selections.map((chip) => (
                <span key={chip} className="isc-chip">
                  {chip}
                </span>
              ))}
            </span>
          </div>
        ) : (
          <>
            {question.options.length > 0 && interactive && (
              <div className="isc-hint">
                <MaterialIcon name="touch_app" size={18} />
                <span>{isMulti ? '点选符合情况的选项（可多选），完成后点提交' : '点选最符合的一项继续'}</span>
              </div>
            )}
            {question.options.length > 0 && (
              <div className="isc-options">
                {question.options.map((option) => {
                  const sel = isMulti && pendingSet.has(option.label)
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`isc-option${sel ? ' selected' : ''}`}
                      disabled={!interactive}
                      aria-pressed={isMulti ? sel : undefined}
                      onClick={() => (isMulti ? togglePending(option.label) : answerSingle(option.label))}
                    >
                      <span className="isc-option-text">{option.label}</span>
                      <MaterialIcon name={sel ? 'check_circle' : 'radio_button_unchecked'} size={20} />
                    </button>
                  )
                })}
              </div>
            )}
            {isMulti && (
              <div className="isc-actions">
                <button
                  type="button"
                  className="isc-submit"
                  disabled={!interactive || pendingSet.size === 0}
                  onClick={submitMulti}
                >
                  <MaterialIcon name="arrow_forward" size={19} />
                  提交并继续
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 卡脚：上一问 / 下一问，两端边界禁用（末问即边界，已答完时「下一问」同样禁用） */}
      <footer className="isc-footer">
        <button
          type="button"
          className="isc-nav"
          disabled={index === 0}
          onClick={() => setCurrent(index - 1)}
        >
          <MaterialIcon name="chevron_left" size={19} />
          上一问
        </button>
        <button
          type="button"
          className="isc-nav"
          disabled={isLast}
          onClick={() => setCurrent(index + 1)}
        >
          下一问
          <MaterialIcon name="chevron_right" size={19} />
        </button>
      </footer>

      <style>{`
        .isc-card{
          border:1px solid var(--isc-hairline);border-radius:16px;background:var(--color-surface,#fff);padding:18px 20px;
          box-shadow:var(--shadow-float);
          /* 语义槽组件级别名（v4 多主题）：全部 var() 回指 tokens.css 全局语义层，
             四主题（graphite/paper/spring/night）切换即跟随，组件内不再写死色值 */
          --isc-ink:var(--color-primary);
          --isc-ink-hover:var(--color-accentHover);
          --isc-selected:var(--color-accentSoft);
          --isc-hover:var(--color-primarySoft);
          --isc-panel:var(--color-bgSecondary);
          --isc-hairline:var(--color-borderPrimary);
          --isc-ease:cubic-bezier(0.4,0,0.2,1);
        }
        .isc-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--isc-hairline);margin-bottom:14px}
        .isc-title{display:flex;align-items:center;gap:8px;color:var(--isc-ink)}
        .isc-title h3{margin:0;font-size:15px;font-weight:600;color:var(--color-textPrimary);font-family:var(--font-family-serif)}
        .isc-progress{display:flex;align-items:center;gap:10px}
        .isc-progress-text{font-size:12px;color:var(--color-textTertiary)}
        .isc-dots{display:flex;align-items:center;gap:6px}
        .isc-dot{width:8px;height:8px;border-radius:9999px;background:var(--isc-hairline);transition:background 160ms var(--isc-ease),box-shadow 160ms var(--isc-ease)}
        .isc-dot.done{background:var(--isc-ink)}
        .isc-dot.current{background:var(--isc-ink);box-shadow:0 0 0 3px rgba(0,0,0,.08)}
        .isc-body{min-height:64px}
        .isc-reply{margin:0 0 14px;font-size:15px;line-height:1.7;color:var(--color-textPrimary)}
        .isc-hint{display:flex;align-items:center;gap:7px;margin-bottom:12px;font-size:12px;color:var(--color-textTertiary)}
        .isc-options{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
        .isc-option{border:1px solid var(--isc-hairline);border-radius:12px;background:var(--color-surface,#fff);padding:12px 14px;display:flex;align-items:center;gap:9px;cursor:pointer;text-align:left;color:var(--color-textPrimary);font:inherit;transition:border-color 160ms var(--isc-ease),background 160ms var(--isc-ease)}
        .isc-option:hover:not(:disabled):not(.selected){border-color:var(--line-strong);background:var(--isc-panel)}
        /* 选中态：#EDEDED 填充 + 近黑描边 + 近黑对勾（规格 §3） */
        .isc-option.selected{border-color:var(--isc-ink);background:var(--isc-selected)}
        .isc-option.selected>.material-symbol{color:var(--isc-ink)}
        .isc-option:disabled{cursor:not-allowed;opacity:.72}
        .isc-option-text{flex:1;min-width:0;font-size:14px;line-height:1.5}
        .isc-actions{margin-top:14px;display:flex;justify-content:flex-end}
        .isc-submit{border:0;border-radius:12px;background:var(--isc-ink);color:var(--color-bgPrimary);padding:10px 18px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-weight:600;transition:background 160ms var(--isc-ease)}
        .isc-submit:hover:not(:disabled){background:var(--isc-ink-hover)}
        .isc-submit:disabled{background:var(--isc-hairline);color:var(--color-textTertiary);cursor:not-allowed}
        .isc-answered{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
        .isc-answered-tag{display:inline-flex;align-items:center;gap:5px;font-size:12px;border-radius:9999px;padding:4px 10px;background:var(--isc-selected);color:var(--isc-ink);white-space:nowrap}
        .isc-chips{display:flex;flex-wrap:wrap;gap:6px}
        .isc-chip{font-size:12px;border-radius:9999px;padding:4px 10px;background:var(--isc-panel);border:1px solid var(--isc-hairline);color:var(--color-textSecondary)}
        .isc-footer{margin-top:16px;padding-top:12px;border-top:1px solid var(--isc-hairline);display:flex;align-items:center;justify-content:space-between;gap:10px}
        .isc-nav{border:1px solid var(--isc-hairline);border-radius:12px;background:var(--color-surface,#fff);color:var(--color-textSecondary);padding:8px 14px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;font:inherit;font-size:13px;transition:border-color 160ms var(--isc-ease),color 160ms var(--isc-ease),background 160ms var(--isc-ease)}
        .isc-nav:hover:not(:disabled){border-color:var(--isc-hairline);color:var(--isc-ink);background:var(--isc-hover)}
        .isc-nav:disabled{opacity:.45;cursor:not-allowed}
        @media (prefers-reduced-motion:reduce){.isc-dot,.isc-option,.isc-nav,.isc-submit{transition:none}}
        /* 手机窄屏基础档（≤680）：卡内边距收紧、字号微降，导航/提交/选项触控 ≥44px */
        @media (max-width:680px){
          .isc-card{padding:14px;border-radius:14px}
          .isc-head{gap:10px;padding-bottom:10px;margin-bottom:12px}
          .isc-progress{gap:8px}
          .isc-reply{font-size:14px;margin-bottom:10px}
          .isc-options{gap:8px}
          .isc-option{padding:11px 12px;min-height:44px;gap:8px}
          .isc-submit{min-height:44px}
          .isc-actions{margin-top:12px}
          .isc-nav{min-height:44px;padding:8px 14px}
          .isc-footer{margin-top:14px;padding-top:10px}
        }
      `}</style>
    </section>
  )
}
