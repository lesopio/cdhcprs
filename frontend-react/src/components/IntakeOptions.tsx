/**
 * AI 主动问诊的选择题气泡（迁移自 Vue IntakeOptions.vue）
 *
 * 行为：
 * - 单选场景（任一选项 multi=false）：点一项立即回传
 * - 多选场景（全部 multi=true）：勾选 + 提交按钮回传
 */
import { useEffect, useState } from 'react'
import MaterialIcon from '@/components/MaterialIcon'
import type { IntakeOption } from '@/lib/chat-types'

interface Props {
  reply: string
  options: IntakeOption[]
  senior?: boolean
  initialSelected?: string[]
  onSubmit: (selections: string[]) => void
}

export default function IntakeOptions({
  reply,
  options,
  senior,
  initialSelected = [],
  onSubmit,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected))
  const [submittedSelections, setSubmittedSelections] = useState<string[]>(initialSelected)

  // 新一轮追问（options 引用变化）→ 清空
  useEffect(() => {
    setSelected(new Set())
    setSubmittedSelections([])
  }, [options])

  const anyMulti = options.some((o) => o.multi)
  const selectedLabels = Array.from(selected)

  const toggleOption = (option: IntakeOption) => {
    const label = option.label
    if (!anyMulti) {
      setSelected(new Set([label]))
      setSubmittedSelections([label])
      onSubmit([label])
      return
    }
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(label) ? next.delete(label) : next.add(label)
      return next
    })
  }

  const submitSelection = () => {
    if (!selectedLabels.length) return
    setSubmittedSelections([...selectedLabels])
    onSubmit(selectedLabels)
  }

  return (
    <div className={`intake-options${senior ? ' senior' : ''}`}>
      {reply && <p className="intake-reply">{reply}</p>}
      {options.length > 0 && (
        <div className="intake-instructions">
          <MaterialIcon name="touch_app" size={18} />
          <span>
            {anyMulti ? '点选符合情况的选项（可多选），完成后点提交' : '点选最符合的一项继续'}
          </span>
        </div>
      )}
      {options.length > 0 && (
        <div className="options-grid">
          {options.map((option) => {
            const sel = selected.has(option.label)
            return (
              <button
                key={option.label}
                type="button"
                className={`option-card${sel ? ' selected' : ''}`}
                onClick={() => toggleOption(option)}
              >
                <span className="option-text">{option.label}</span>
                <MaterialIcon name={sel ? 'check_circle' : 'radio_button_unchecked'} size={20} />
              </button>
            )
          })}
        </div>
      )}
      {submittedSelections.length > 0 && (
        <div className="selected-chips">
          {submittedSelections.map((chip) => (
            <span key={chip} className="selected-chip">
              {chip}
            </span>
          ))}
        </div>
      )}
      {options.length > 0 && anyMulti && (
        <div className="intake-actions">
          <button
            type="button"
            className="submit-btn"
            disabled={selectedLabels.length === 0}
            onClick={submitSelection}
          >
            <MaterialIcon name="arrow_forward" size={19} />提交并继续
          </button>
        </div>
      )}
      <style>{`
        .intake-options{border:1px solid var(--color-borderPrimary);border-radius:16px;background:var(--color-accentSoft);padding:18px 20px;box-shadow:var(--shadow-float)}
        .intake-reply{margin:0 0 14px;font-size:15px;line-height:1.7;color:var(--color-textPrimary)}
        .intake-instructions{display:flex;align-items:center;gap:7px;margin-bottom:12px;font-size:12px;color:var(--color-accent)}
        .options-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
        .option-card{border:1px solid var(--color-borderPrimary);border-radius:12px;background:var(--color-surface);padding:12px 14px;display:flex;align-items:center;gap:9px;cursor:pointer;text-align:left;color:var(--color-textPrimary);transition:border-color 160ms ease,background 160ms ease,box-shadow 160ms ease}
        .option-card:hover{border-color:var(--color-accent);background:var(--color-accentSoft)}
        .option-card.selected{border-color:var(--color-accent);background:var(--color-accentSoft);box-shadow:0 0 0 2px rgba(0,0,0,.06)}
        .option-text{flex:1;min-width:0;font-size:14px;line-height:1.5}
        .intake-actions{margin-top:14px;display:flex;justify-content:flex-end}
        .submit-btn{border:0;border-radius:10px;background:var(--color-accent);color:var(--color-bgPrimary);padding:10px 18px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-weight:700;transition:background 160ms ease}
        .submit-btn:hover:not(:disabled){background:var(--color-accentHover)}
        .submit-btn:disabled{background:var(--color-borderPrimary);cursor:not-allowed}
        .selected-chips{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px}
        .selected-chip{font-size:12px;border-radius:999px;padding:4px 10px;background:var(--color-primarySoft);color:var(--color-primary)}
        .intake-options.senior .intake-reply{font-size:19px;line-height:1.8}
        .intake-options.senior .options-grid{grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
        .intake-options.senior .option-card{padding:18px 18px;min-height:64px;border-radius:14px;border-width:2px}
        .intake-options.senior .option-text{font-size:18px}
        .intake-options.senior .intake-instructions{font-size:14px}
        .intake-options.senior .submit-btn{font-size:17px;padding:14px 24px}
        /* 手机窄屏基础档（≤680）：收内边距与字号，选项/提交按钮触控 ≥44px；senior 档字号更高优先级不受影响 */
        @media (max-width:680px){
          .intake-options{padding:14px;border-radius:14px}
          .intake-reply{font-size:14px;margin-bottom:10px}
          .intake-instructions{margin-bottom:10px}
          .options-grid{gap:8px}
          .option-card{padding:11px 12px;min-height:44px;gap:8px}
          .submit-btn{min-height:44px;padding:10px 18px}
          .intake-actions{margin-top:12px}
          .selected-chips{margin-top:10px}
        }
      `}</style>
    </div>
  )
}
