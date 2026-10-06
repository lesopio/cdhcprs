/**
 * 步进式分诊流程卡（todo A2）
 *
 * 「分诊问诊」不再弹 4 步 TriageDialog，而是把同一套分诊状态机作为白底消息卡片
 * 直接铺在 Chat 的 .thread 消息流里：分类 → 疾病 → 辨证（分支+证型） → 症状确认。
 *
 * - 状态机 1:1 复刻 TriageDialog：canContinue 条件、choose* 的级联重置、submit 组装；
 * - 已完成步骤折叠为一行摘要，点「修改」跳回该步，并按同一套级联规则清空其下游全部选择；
 * - 视觉按 docs/ui-spec-v3-monochrome.md §3（2026-09 单色化）：白底 16px 圆角轻卡片 + hairline
 *   #E5E5E5 描边 + float 阴影；选项选中态 #EDEDED 填充 + 近黑对勾；急危朱红淡染（唯一功能红）；
 *   主按钮近黑 #1B1B1B（hover #3D3D3A）。仍竖向堆叠在消息流里，不做遮罩不居中；
 * - gsap 入场：每揭示一个新步骤卡做 fade+上移，步骤折叠做高度过渡；
 *   prefers-reduced-motion 命中时跳过全部动画；动画统一走 gsap.context，卸载时 revert。
 *
 * 数据结构（categories → diseases → branches/syndromes）与 TriageDialog 顶部的本地类型
 * 同形（对方未导出，这里按同形镜像声明）；TriageResult 直接从 TriageDialog 再导出。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { gsap } from 'gsap'
import MaterialIcon from '@/components/MaterialIcon'
import type { PatientProfile } from '@/api/patient'
import triageDataJson from '@/constants/triageData.json'

// TriageResult 与 TriageDialog 同源，只再导出 + import type 使用，不重复声明
export type { TriageResult } from './TriageDialog'
import type { TriageResult } from './TriageDialog'

type TriageBranch = { id: string; label: string; description: string }
type TriageSyndrome = {
  id: string; branch: string; label: string; description: string;
  symptoms: string[]; rationale: string; emergency: boolean;
}
type TriageDisease = {
  id: string; name: string; nameEn: string; department: string;
  consensus: string; context: string;
  branches: TriageBranch[]; syndromes: TriageSyndrome[];
}
type TriageCategory = { id: string; name: string; diseases: TriageDisease[] }
type TriageDataset = { sourceDocument: string; categories: TriageCategory[] }

const triageData = triageDataJson as unknown as TriageDataset

/** 进度条与折叠摘要共用的步骤元信息（图标同 TriageDialog） */
const PROGRESS_ITEMS = [
  { step: 1, label: '分类', icon: 'category' },
  { step: 2, label: '疾病', icon: 'clinical_notes' },
  { step: 3, label: '辨证', icon: 'account_tree' },
  { step: 4, label: '确认', icon: 'fact_check' },
] as const

interface Props {
  profiles: PatientProfile[]
  initialProfileId?: number
  onSubmit: (triage: TriageResult, profileId: number | null) => void
  onSkip: () => void
}

export default function TriageFlow({ profiles, initialProfileId = 0, onSubmit, onSkip }: Props) {
  const [step, setStep] = useState(1)
  const [profileId, setProfileId] = useState(initialProfileId || 0)
  const [categoryId, setCategoryId] = useState('')
  const [diseaseId, setDiseaseId] = useState('')
  const [branchId, setBranchId] = useState('')
  const [syndromeId, setSyndromeId] = useState('')
  const [symptoms, setSymptoms] = useState<string[]>([])
  const [chiefComplaint, setChiefComplaint] = useState('')

  const rootRef = useRef<HTMLDivElement | null>(null)
  // 各步骤卡 DOM（下标 0 为头部进度卡，1-4 对应步骤）；折叠高度过渡要按步骤号取元素
  const cardRefs = useRef<Array<HTMLDivElement | null>>([])
  // 每次提交后记录的各卡高度：展开态高度必须在「下一步」变更前拿到才能做折叠过渡
  const cardHeightRef = useRef<Record<number, number>>({})
  const prevStepRef = useRef(1)
  // 用户是否手动改过问诊对象：避免 initialProfileId 迟到覆盖用户显式选择的「不关联」
  const profileTouchedRef = useRef(false)

  // Chat 的档案列表是挂载后异步拉的：initialProfileId 迟到时补一次默认值（用户已手选则不覆盖）
  useEffect(() => {
    if (!profileTouchedRef.current && initialProfileId) setProfileId(initialProfileId)
  }, [initialProfileId])

  // ---- 以下派生状态与 TriageDialog 1:1 ----
  const currentCategory = useMemo(
    () => triageData.categories.find((c) => c.id === categoryId),
    [categoryId],
  )
  const currentDisease = useMemo(
    () => currentCategory?.diseases.find((d) => d.id === diseaseId),
    [currentCategory, diseaseId],
  )
  const selectedBranch = useMemo(
    () => currentDisease?.branches.find((b) => b.id === branchId),
    [currentDisease, branchId],
  )
  const availableSyndromes = useMemo(() => {
    const all = currentDisease?.syndromes || []
    if (!branchId) return currentDisease?.branches.length ? [] : all
    const matched = all.filter((s) => s.branch === branchId)
    return matched.length ? matched : all
  }, [currentDisease, branchId])
  const selectedSyndrome = useMemo(
    () =>
      availableSyndromes.find((s) => s.id === syndromeId) ||
      currentDisease?.syndromes.find((s) => s.id === syndromeId),
    [availableSyndromes, syndromeId, currentDisease],
  )
  const isEmergency = Boolean(selectedSyndrome?.emergency)
  const canContinue = useMemo(() => {
    if (step === 1) return Boolean(categoryId)
    if (step === 2) return Boolean(diseaseId)
    if (step === 3) {
      if (currentDisease?.branches.length && !branchId) return false
      return !availableSyndromes.length || Boolean(syndromeId)
    }
    return true
  }, [step, categoryId, diseaseId, branchId, syndromeId, currentDisease, availableSyndromes])

  // ---- 选择级联：与 TriageDialog 的 choose* 完全一致 ----
  const chooseCategory = (id: string) => {
    setCategoryId(id); setDiseaseId(''); setBranchId(''); setSyndromeId(''); setSymptoms([])
  }
  const chooseDisease = (id: string) => {
    setDiseaseId(id); setBranchId(''); setSyndromeId(''); setSymptoms([])
  }
  const chooseBranch = (id: string) => {
    setBranchId(id); setSyndromeId(''); setSymptoms([])
  }
  const chooseSyndrome = (id: string) => {
    setSyndromeId(id); setSymptoms([])
  }
  const toggleSymptom = (s: string) => {
    setSymptoms((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
  }

  /** 跳回第 target 步：按 TriageDialog 的级联规则清空其下游全部选择（主诉保留，同 choose* 行为） */
  const editStep = (target: number) => {
    if (target <= 1) setDiseaseId('')
    if (target <= 2) setBranchId('')
    if (target <= 3) { setSyndromeId(''); setSymptoms([]) }
    setStep(target)
  }

  const profileName = profileId
    ? profiles.find((p) => p.id === profileId)?.name || `患者 ${profileId}`
    : ''

  /** 折叠摘要文案：把已完成步骤压成一行（含关键选择结果） */
  const stepSummary = (s: number): string => {
    if (s === 1) {
      const cat = triageData.categories.find((c) => c.id === categoryId)
      return [cat?.name || '未选择分类', profileId ? `对象：${profileName}` : '未关联档案'].join(' · ')
    }
    if (s === 2) return currentDisease?.name || '未选择疾病'
    if (s === 3) {
      return [
        selectedBranch?.label || (currentDisease?.branches.length ? '未选分支' : '文档未设独立分支'),
        selectedSyndrome?.label || selectedBranch?.label || '待医师辨证',
      ].join(' · ')
    }
    return [
      symptoms.length ? `已勾选 ${symptoms.length} 项表现` : '未勾选表现',
      chiefComplaint.trim() ? '主诉已填' : '主诉未填',
    ].join(' · ')
  }

  /** 组装并提交分诊结果（与 TriageDialog.submit 相同） */
  const submit = () => {
    const category = currentCategory
    const disease = currentDisease
    if (!category || !disease) return
    onSubmit(
      {
        sourceDocument: triageData.sourceDocument,
        categoryId: category.id,
        categoryName: category.name,
        diseaseId: disease.id,
        diseaseName: disease.name,
        department: disease.department,
        branchId,
        branchLabel: selectedBranch?.label || '',
        syndromeId,
        syndromeLabel: selectedSyndrome?.label || selectedBranch?.label || '',
        symptoms: [...symptoms],
        chiefComplaint: chiefComplaint.trim(),
        emergency: isEmergency,
      },
      profileId || null,
    )
  }

  // ---- 动画：注意三个 effect 的声明顺序 ----
  // (1) 挂载入场：整组卡片依次 fade+上移（命中 prefers-reduced-motion 时跳过全部动画）
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const ctx = gsap.context(() => {
      if (reduced) return
      gsap.from('.tflow-card, .tflow-skip', {
        opacity: 0, y: 16, duration: 0.45, ease: 'power2.out', stagger: 0.08,
        clearProps: 'opacity,transform',
      })
    }, rootRef)
    return () => ctx.revert()
  }, [])

  // (2) 步骤切换：新揭示的步骤卡 fade+上移；刚折叠的卡做高度过渡（展开态高度取自 heights 快照）。
  //     必须声明在 (3) 之前：同一提交内先读旧高度快照，再由 (3) 覆盖为新高度。
  useEffect(() => {
    const prev = prevStepRef.current
    prevStepRef.current = step
    if (prev === step) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const ctx = gsap.context(() => {
      if (reduced) return
      const expanded = cardRefs.current[step]
      if (expanded) {
        gsap.from(expanded, {
          opacity: 0, y: 18, duration: 0.45, ease: 'power2.out',
          clearProps: 'opacity,transform',
        })
      }
      // 跳回更早步骤时旧卡直接卸载（ref 为 null），只有「下一步折叠」才有高度过渡可做
      const collapsed = cardRefs.current[prev]
      if (collapsed) {
        const fromH = cardHeightRef.current[prev] || 0
        const toH = collapsed.offsetHeight
        if (fromH > toH + 2) {
          gsap.fromTo(
            collapsed,
            { height: fromH, overflow: 'hidden' },
            { height: toH, duration: 0.38, ease: 'power2.inOut', clearProps: 'height,overflow' },
          )
        }
      }
    }, rootRef)
    return () => ctx.revert()
  }, [step])

  // (3) 高度快照：每次提交后记录各卡当前高度，供下一次「折叠」取展开态高度用。
  //     折叠过渡进行中的卡带有内联 height（动画中间值），跳过以免快照被污染。
  useEffect(() => {
    for (let s = 0; s <= 4; s += 1) {
      const el = cardRefs.current[s]
      if (el && !el.style.height) cardHeightRef.current[s] = el.offsetHeight
    }
  })

  return (
    <div className="triage-flow" ref={rootRef}>
      {/* 头部卡：标题 + 4 步进度条 */}
      <div className="tflow-card" ref={(el) => { cardRefs.current[0] = el }}>
        <div className="tflow-head">
          <span className="tflow-head-icon">
            <MaterialIcon name="stethoscope" size={24} />
          </span>
          <div>
            <h2 className="tflow-title">开始新的慢病问诊</h2>
            <p className="tflow-subtitle">依据《{triageData.sourceDocument}》逐级完成中医分诊</p>
          </div>
        </div>
        <div className="tflow-progress" aria-label="分诊进度">
          {PROGRESS_ITEMS.map((item) => (
            <div
              key={item.step}
              className={step === item.step ? 'active' : step > item.step ? 'done' : ''}
            >
              <MaterialIcon
                name={step > item.step ? 'check_circle' : item.icon}
                size={17}
              />
              <span className="tflow-progress-label">{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {PROGRESS_ITEMS.map(({ step: s, label, icon }) => {
        if (s > step) return null // 未到达的步骤不渲染，配合入场动画逐级「揭示」
        if (s < step) {
          // 已完成步骤：折叠为一行摘要 + 「修改」跳回（清空下游选择）
          return (
            <div
              key={s}
              className="tflow-card tflow-collapsed"
              ref={(el) => { cardRefs.current[s] = el }}
            >
              <span className="tflow-summary-icon">
                <MaterialIcon name={icon} size={17} />
              </span>
              <span className="tflow-summary-label">{label}</span>
              <span className="tflow-summary-text">{stepSummary(s)}</span>
              {s === 3 && isEmergency && (
                <MaterialIcon name="emergency" size={17} className="tflow-summary-warn" />
              )}
              <button type="button" className="tflow-edit" onClick={() => editStep(s)}>
                <MaterialIcon name="edit" size={14} />
                修改
              </button>
            </div>
          )
        }
        // 当前步骤：展开显示选项
        return (
          <div
            key={s}
            className="tflow-card tflow-expanded"
            ref={(el) => { cardRefs.current[s] = el }}
          >
            {s === 1 && (
              <>
                <div className="tflow-step-intro">
                  <span>问诊对象与疾病大类</span>
                  <small>先选择患者档案，再选择最接近的疾病分类</small>
                </div>
                <label className="tflow-profile-field">
                  <span>问诊对象</span>
                  <select
                    value={profileId}
                    onChange={(e) => {
                      profileTouchedRef.current = true
                      setProfileId(Number(e.target.value))
                    }}
                  >
                    <option value={0}>不关联患者档案</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || `患者 ${p.id}`}{p.is_default ? '（默认）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="tflow-option-list">
                  {triageData.categories.map((category) => (
                    <button
                      key={category.id}
                      type="button"
                      className={`tflow-option${categoryId === category.id ? ' selected' : ''}`}
                      onClick={() => chooseCategory(category.id)}
                    >
                      <MaterialIcon name="category" size={21} />
                      <span>
                        <strong>{category.name}</strong>
                        <small>{category.diseases.length} 类疾病</small>
                      </span>
                      {categoryId === category.id && <MaterialIcon name="check_circle" size={19} />}
                    </button>
                  ))}
                </div>
              </>
            )}

            {s === 2 && (
              <>
                <div className="tflow-step-intro">
                  <span>选择具体疾病</span>
                  <small>{currentCategory?.name} · 共 {currentCategory?.diseases.length || 0} 项</small>
                </div>
                <div className="tflow-option-list">
                  {currentCategory?.diseases.map((disease) => (
                    <button
                      key={disease.id}
                      type="button"
                      className={`tflow-disease${diseaseId === disease.id ? ' selected' : ''}`}
                      onClick={() => chooseDisease(disease.id)}
                    >
                      <span className="tflow-disease-icon">
                        <MaterialIcon name="clinical_notes" size={19} />
                      </span>
                      <span>
                        <strong>{disease.name}</strong>
                        <small>{disease.nameEn}</small>
                        <em>{disease.department || '中医专科分诊'}</em>
                      </span>
                      {diseaseId === disease.id && <MaterialIcon name="check_circle" size={19} />}
                    </button>
                  ))}
                </div>
                {currentDisease?.consensus && (
                  <aside className="tflow-note">
                    <MaterialIcon name="menu_book" size={17} />
                    <p>{currentDisease.consensus}</p>
                  </aside>
                )}
              </>
            )}

            {s === 3 && (
              <>
                <div className="tflow-step-intro">
                  <span>辨病机与证型</span>
                  <small>{currentDisease?.name} · 选择最符合当前表现的一项</small>
                </div>
                {currentDisease?.branches.length ? (
                  <>
                    <h3 className="tflow-choice-heading">核心分叉</h3>
                    <div className="tflow-option-list">
                      {currentDisease.branches.map((branch) => (
                        <button
                          key={branch.id}
                          type="button"
                          className={`tflow-branch${branchId === branch.id ? ' selected' : ''}`}
                          onClick={() => chooseBranch(branch.id)}
                        >
                          <span className="tflow-branch-code">{branch.id}</span>
                          <span>
                            <strong>{branch.label}</strong>
                            <small>{branch.description}</small>
                          </span>
                          {branchId === branch.id && <MaterialIcon name="check_circle" size={19} />}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
                {/* 有分支且未选分支时 availableSyndromes 为空 → 不显示证型（同 TriageDialog） */}
                {availableSyndromes.length ? (
                  <>
                    <h3 className="tflow-choice-heading">具体证型</h3>
                    <div className="tflow-option-list">
                      {availableSyndromes.map((syndrome) => (
                        <button
                          key={syndrome.id}
                          type="button"
                          className={`tflow-syndrome${syndromeId === syndrome.id ? ' selected' : ''}${syndrome.emergency ? ' urgent' : ''}`}
                          onClick={() => chooseSyndrome(syndrome.id)}
                        >
                          <span>
                            <strong>{syndrome.label}</strong>
                            <small>{syndrome.description}</small>
                          </span>
                          <MaterialIcon
                            name={
                              syndrome.emergency
                                ? 'emergency'
                                : syndromeId === syndrome.id
                                ? 'check_circle'
                                : 'chevron_right'
                            }
                            size={19}
                          />
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
                {!currentDisease?.branches.length && !availableSyndromes.length && (
                  <aside className="tflow-note">
                    <MaterialIcon name="info" size={17} />
                    <p>文档未设置更细分支，可直接补充主诉后开始问诊，由医生结合舌脉与检查进一步辨证。</p>
                  </aside>
                )}
              </>
            )}

            {s === 4 && (
              <>
                <div className="tflow-step-intro">
                  <span>补充症状并确认</span>
                  <small>勾选当前确有的表现，避免把模板症状全部带入问诊</small>
                </div>
                {selectedSyndrome?.symptoms.length ? (
                  <div className="tflow-symptom-section">
                    <h3 className="tflow-choice-heading">典型表现</h3>
                    <div className="tflow-chips">
                      {selectedSyndrome.symptoms.map((symptom) => (
                        <button
                          key={symptom}
                          type="button"
                          className={symptoms.includes(symptom) ? 'selected' : ''}
                          onClick={() => toggleSymptom(symptom)}
                        >
                          {symptom}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <label className="tflow-complaint">
                  <span>本次主诉</span>
                  <textarea
                    rows={4}
                    maxLength={500}
                    value={chiefComplaint}
                    onChange={(e) => setChiefComplaint(e.target.value)}
                    placeholder="请描述最困扰的症状、持续时间、近期检查指标和正在使用的药物……"
                  />
                  <small>{chiefComplaint.length}/500</small>
                </label>
                {isEmergency && (
                  <aside className="tflow-emergency">
                    <MaterialIcon name="emergency" size={19} />
                    <div>
                      <strong>命中急危重症分诊特征</strong>
                      <p>请优先联系急救或立即前往急诊，本系统不能替代现场处置。</p>
                    </div>
                  </aside>
                )}
                <div className="tflow-summary">
                  <div><span>疾病分类</span><strong>{currentCategory?.name}</strong></div>
                  <div><span>分诊疾病</span><strong>{currentDisease?.name}</strong></div>
                  <div><span>病机分支</span><strong>{selectedBranch?.label || '文档未设独立分支'}</strong></div>
                  <div><span>初步证型</span><strong>{selectedSyndrome?.label || selectedBranch?.label || '待医师辨证'}</strong></div>
                </div>
                <p className="tflow-disclaimer">分诊结果只用于组织问诊信息，不构成诊断或处方依据。</p>
              </>
            )}

            <div className="tflow-actions">
              {s > 1 && (
                <button
                  type="button"
                  className="tflow-btn tflow-btn-secondary"
                  onClick={() => setStep(s - 1)}
                >
                  <MaterialIcon name="arrow_back" size={16} />
                  上一步
                </button>
              )}
              {s < 4 ? (
                <button
                  type="button"
                  className="tflow-btn tflow-btn-primary"
                  disabled={!canContinue}
                  onClick={() => setStep(s + 1)}
                >
                  下一步
                  <MaterialIcon name="arrow_forward" size={16} />
                </button>
              ) : (
                <button
                  type="button"
                  className="tflow-btn tflow-btn-primary tflow-btn-start"
                  onClick={submit}
                >
                  <MaterialIcon name="check" size={16} />
                  开始问诊
                </button>
              )}
            </div>
          </div>
        )
      })}

      {/* 固定的跳过入口：任何步骤都可直接放弃分诊 */}
      <button type="button" className="tflow-skip" onClick={onSkip}>
        <MaterialIcon name="skip_next" size={16} />
        暂不分诊，直接问诊
      </button>

      <style>{`
        .triage-flow{
          display:flex;flex-direction:column;gap:12px;font-size:.875rem;color:var(--color-textPrimary);
          /* 语义槽组件级别名（v4 多主题）：全部 var() 回指 tokens.css 全局语义层，
             四主题（graphite/paper/spring/night）切换即跟随；彩色仅急危红（var(--color-danger)）功能位 */
          --tflow-ink:var(--color-primary);
          --tflow-ink-hover:var(--color-accentHover);
          --tflow-selected:var(--color-accentSoft);
          --tflow-hover:var(--color-primarySoft);
          --tflow-panel:var(--color-bgSecondary);
          --tflow-hairline:var(--color-borderPrimary);
          --tflow-shadow-float:var(--shadow-float);
          --tflow-ease:cubic-bezier(0.4,0,0.2,1);
        }
        /* 轻卡片：白底 16px 圆角 + hairline 描边 + float 阴影（规格 §3 弹层/分诊卡） */
        .tflow-card{background:var(--color-surface,#fff);border:1px solid var(--tflow-hairline);border-radius:16px;padding:16px 18px;box-shadow:var(--tflow-shadow-float)}

        /* 头部卡：标题 + 4 步进度条 */
        .tflow-head{display:flex;align-items:center;gap:12px}
        .tflow-head-icon{width:42px;height:42px;border-radius:12px;background:var(--tflow-panel);color:var(--tflow-ink);display:flex;align-items:center;justify-content:center;flex:0 0 auto}
        .tflow-title{margin:0;font-size:1.125rem;font-weight:600;color:var(--color-textPrimary);font-family:var(--font-family-serif)}
        .tflow-subtitle{margin:3px 0 0;font-size:.75rem;color:var(--color-textTertiary)}
        .tflow-progress{margin-top:14px;display:grid;grid-template-columns:repeat(4,1fr);border-radius:12px;background:var(--tflow-panel);padding:5px}
        .tflow-progress>div{min-height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--color-textTertiary);font-size:.72rem}
        .tflow-progress>div.active{background:var(--color-surface,#fff);color:var(--tflow-ink);box-shadow:inset 0 0 0 1px var(--tflow-hairline)}
        .tflow-progress>div.done{color:var(--tflow-ink)}

        /* 已完成步骤：一行摘要 + 修改按钮 */
        .tflow-collapsed{display:flex;align-items:center;gap:10px;padding:12px 16px}
        .tflow-summary-icon{width:30px;height:30px;border-radius:9px;background:var(--tflow-panel);color:var(--color-textSecondary);display:flex;align-items:center;justify-content:center;flex:0 0 auto}
        .tflow-summary-label{flex:0 0 auto;font-size:.75rem;font-weight:600;color:var(--color-textSecondary)}
        .tflow-summary-text{flex:1;min-width:0;font-size:.8125rem;color:var(--color-textTertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .tflow-summary-warn{flex:0 0 auto;color:var(--color-danger,#C0392B)}
        .tflow-edit{flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 11px;border:1px solid var(--tflow-hairline);border-radius:9999px;background:var(--color-surface,#fff);color:var(--color-textSecondary);font-size:.75rem;cursor:pointer;font-family:inherit;transition:background .15s var(--tflow-ease),color .15s var(--tflow-ease)}
        .tflow-edit:hover{background:var(--tflow-hover);color:var(--tflow-ink)}

        /* 展开步骤卡内容（全部加 tflow- 前缀避免与 TriageDialog 全局样式冲突） */
        .tflow-step-intro{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:2px 0 14px}
        .tflow-step-intro>span{font-size:.9375rem;font-weight:600;color:var(--color-textPrimary)}
        .tflow-step-intro>small{font-size:.75rem;color:var(--color-textTertiary);text-align:right}
        .tflow-profile-field{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px;font-size:.8125rem;color:var(--color-textSecondary)}
        .tflow-profile-field>span{font-weight:600}
        .tflow-profile-field select{min-height:38px;border:1px solid var(--tflow-hairline);border-radius:10px;background:var(--color-surface,#fff);padding:0 12px;color:var(--color-textPrimary);font-family:inherit;font-size:.8125rem;outline:none}
        .tflow-profile-field select:focus{border-color:var(--color-accent);box-shadow:0 0 0 3px var(--color-primarySoft)}
        .tflow-option-list{display:grid}
        .tflow-option,.tflow-disease,.tflow-branch,.tflow-syndrome{border:0;border-bottom:1px solid var(--tflow-hairline);border-radius:0;background:transparent;padding:12px 8px;cursor:pointer;text-align:left;transition:background .16s var(--tflow-ease);display:grid;align-items:start;color:var(--color-textPrimary);font-family:inherit}
        .tflow-option:last-child,.tflow-disease:last-child,.tflow-branch:last-child,.tflow-syndrome:last-child{border-bottom:0}
        .tflow-option{grid-template-columns:30px minmax(0,1fr) 20px;gap:9px}
        /* 选中态：#EDEDED 填充 + 近黑对勾（规格 §3，无彩色描边） */
        .tflow-option.selected,.tflow-disease.selected,.tflow-branch.selected,.tflow-syndrome.selected{background:var(--tflow-selected);border-radius:10px;border-bottom-color:transparent}
        .tflow-option.selected>.material-symbol:last-child,.tflow-disease.selected>.material-symbol,.tflow-branch.selected>.material-symbol,.tflow-syndrome.selected>.material-symbol{color:var(--tflow-ink)}
        .tflow-disease.selected .tflow-disease-icon{color:var(--tflow-ink)}
        .tflow-option strong,.tflow-disease strong,.tflow-branch strong,.tflow-syndrome strong{display:block;font-size:.95rem;font-weight:600;color:var(--color-textPrimary)}
        .tflow-option small,.tflow-disease small,.tflow-branch small,.tflow-syndrome small{display:block;font-size:.78rem;color:var(--color-textTertiary);line-height:1.55}
        .tflow-disease{grid-template-columns:30px minmax(0,1fr) 20px;gap:10px}
        .tflow-disease-icon{color:var(--color-textSecondary)}
        .tflow-disease small{margin:3px 0 6px}
        .tflow-disease em{display:block;font-style:normal;font-size:.72rem;color:var(--color-textTertiary)}
        .tflow-choice-heading{margin:13px 0 9px;font-size:.75rem;font-weight:600;color:var(--color-textSecondary)}
        .tflow-branch{grid-template-columns:28px minmax(0,1fr) 20px;gap:9px}
        .tflow-branch-code{width:24px;height:24px;border-radius:50%;background:var(--tflow-panel);color:var(--color-textSecondary);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.72rem}
        .tflow-syndrome{grid-template-columns:minmax(0,1fr) 20px;gap:8px;padding:12px 13px}
        /* 急危：朱红淡染（规格 §3 唯一保留的功能红位） */
        .tflow-syndrome.urgent{border-color:color-mix(in srgb,var(--color-danger,#C0392B) 32%,transparent);background:color-mix(in srgb,var(--color-danger,#C0392B) 6%,var(--color-surface,#fff))}
        .tflow-syndrome.urgent>.material-symbol{color:var(--color-danger,#C0392B)}
        .tflow-note,.tflow-emergency{margin-top:14px;border-radius:12px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start}
        .tflow-note{background:var(--tflow-panel);color:var(--color-textSecondary)}
        .tflow-note>.material-symbol{color:var(--color-textSecondary)}
        .tflow-note>.material-symbol,.tflow-emergency>.material-symbol{flex:0 0 auto}
        .tflow-note p,.tflow-emergency p{margin:0;line-height:1.65;font-size:.78rem}
        .tflow-emergency{background:var(--color-surface,#fff);border:1px solid color-mix(in srgb,var(--color-danger,#C0392B) 32%,transparent);color:var(--color-danger,#C0392B)}
        .tflow-emergency strong{display:block;margin-bottom:3px;font-size:.8125rem}

        /* 第 4 步：症状 chips / 主诉 / 汇总格 */
        .tflow-chips{display:flex;flex-wrap:wrap;gap:8px}
        .tflow-chips button{border:1px solid var(--tflow-hairline);border-radius:9999px;background:var(--color-surface,#fff);padding:8px 14px;color:var(--color-textSecondary);font-size:.85rem;font-weight:600;cursor:pointer;font-family:inherit;transition:border-color .15s var(--tflow-ease),background .15s var(--tflow-ease),color .15s var(--tflow-ease)}
        .tflow-chips button.selected{border-color:var(--tflow-ink);background:var(--tflow-selected);color:var(--tflow-ink)}
        .tflow-complaint{display:block;margin-top:16px;position:relative}
        .tflow-complaint>span{display:block;color:var(--color-textSecondary);font-size:.75rem;font-weight:600;margin-bottom:7px}
        .tflow-complaint textarea{width:100%;box-sizing:border-box;border:1px solid var(--tflow-hairline);border-radius:12px;padding:12px 13px 24px;resize:vertical;outline:none;line-height:1.65;color:var(--color-textPrimary);font-family:inherit;font-size:.875rem;background:var(--color-surface,#fff)}
        .tflow-complaint textarea:focus{border-color:var(--color-accent);box-shadow:0 0 0 3px var(--color-primarySoft)}
        .tflow-complaint>small{position:absolute;right:10px;bottom:8px;color:var(--color-textTertiary);font-size:.72rem}
        .tflow-summary{display:grid;grid-template-columns:repeat(2,1fr);border-top:1px solid var(--tflow-hairline);border-bottom:1px solid var(--tflow-hairline);margin-top:16px}
        .tflow-summary>div{padding:10px 12px}
        .tflow-summary>div:nth-child(odd){border-right:1px solid var(--tflow-hairline)}
        .tflow-summary span,.tflow-summary strong{display:block}
        .tflow-summary span{font-size:.7rem;color:var(--color-textTertiary)}
        .tflow-summary strong{font-size:.78rem;font-weight:600;color:var(--color-textSecondary);margin-top:3px}
        .tflow-disclaimer{text-align:center;color:var(--color-textTertiary);font-size:.7rem;margin:13px 0 0}

        /* 底部操作与固定跳过入口：主按钮近黑（hover #3D3D3A），次按钮透明底 hairline 描边 */
        .tflow-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--tflow-hairline)}
        .tflow-btn{height:38px;border-radius:12px;padding:0 15px;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;font-family:inherit;font-size:.8125rem;transition:background .15s var(--tflow-ease),border-color .15s var(--tflow-ease),color .15s var(--tflow-ease)}
        .tflow-btn-secondary{border:1px solid var(--tflow-hairline);background:transparent;color:var(--color-textSecondary)}
        .tflow-btn-secondary:hover{background:var(--tflow-hover);border-color:var(--tflow-hairline);color:var(--tflow-ink)}
        .tflow-btn-primary{border:0;background:var(--tflow-ink);color:var(--color-bgPrimary);font-weight:600}
        .tflow-btn-primary:hover:not(:disabled){background:var(--tflow-ink-hover)}
        .tflow-btn-primary:disabled{opacity:.45;cursor:not-allowed}
        .tflow-btn-start{background:var(--tflow-ink)}
        .tflow-skip{align-self:flex-start;display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--color-textTertiary);font-size:.8125rem;cursor:pointer;padding:4px 6px;font-family:inherit;transition:color .15s var(--tflow-ease)}
        .tflow-skip:hover{color:var(--tflow-ink)}

        @media(max-width:700px){
          .tflow-progress-label{display:none}
          .tflow-card{padding:14px}
          .tflow-collapsed{padding:11px 13px}
          .tflow-step-intro{display:block}
          .tflow-step-intro>small{display:block;margin-top:3px;text-align:left}
          .tflow-summary{grid-template-columns:1fr}
          .tflow-summary>div:nth-child(odd){border-right:0}
        }
        /* 手机档（≤480）：主操作按钮/症状 chips 触控 ≥44px；「修改」小药丸外观不变、
           用 ::after 扩大热区到 44px；跳过链接加 padding 撑到 44px */
        @media(max-width:480px){
          .tflow-btn{height:44px}
          .tflow-chips button{min-height:44px;display:inline-flex;align-items:center}
          .tflow-skip{padding:10px 6px}
          .tflow-edit{position:relative}
          .tflow-edit::after{content:'';position:absolute;inset:-7px}
        }
        @media(prefers-reduced-motion:reduce){
          .tflow-option,.tflow-disease,.tflow-branch,.tflow-syndrome,.tflow-chips button,.tflow-btn,.tflow-edit,.tflow-skip{transition:none}
        }
      `}</style>
    </div>
  )
}
