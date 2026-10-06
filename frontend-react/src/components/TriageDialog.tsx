/**
 * 分诊对话框（迁移自 Vue TriageDialog.vue）
 *
 * 4 步流程：分类 → 疾病 → 辨证（分支+证型） → 症状/主诉确认。
 * 用 shadcn Dialog 替代 el-dialog，逻辑（reset/选择级联/canContinue/submit）1:1 保留。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import MaterialIcon from '@/components/MaterialIcon'
import type { PatientProfile } from '@/api/patient'
import triageDataJson from '@/constants/triageData.json'

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

export type TriageResult = {
  sourceDocument: string
  categoryId: string
  categoryName: string
  diseaseId: string
  diseaseName: string
  department: string
  branchId: string
  branchLabel: string
  syndromeId: string
  syndromeLabel: string
  symptoms: string[]
  chiefComplaint: string
  emergency: boolean
}

const PROGRESS_ITEMS = [
  { step: 1, label: '分类', icon: 'category' },
  { step: 2, label: '疾病', icon: 'clinical_notes' },
  { step: 3, label: '辨证', icon: 'account_tree' },
  { step: 4, label: '确认', icon: 'fact_check' },
]

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  profiles: PatientProfile[]
  initial?: TriageResult | null
  initialProfileId?: number
  mode?: 'create' | 'edit'
  onSubmit: (triage: TriageResult, profileId: number | null) => void
  onSkip?: () => void
}

export default function TriageDialog({
  open, onOpenChange, profiles, initial = null, initialProfileId = 0,
  mode = 'create', onSubmit, onSkip,
}: Props) {
  const [step, setStep] = useState(1)
  const [profileId, setProfileId] = useState(0)
  const [categoryId, setCategoryId] = useState('')
  const [diseaseId, setDiseaseId] = useState('')
  const [branchId, setBranchId] = useState('')
  const [syndromeId, setSyndromeId] = useState('')
  const [symptoms, setSymptoms] = useState<string[]>([])
  const [chiefComplaint, setChiefComplaint] = useState('')

  // 每次 open=true 时根据 initial 重置
  useEffect(() => {
    if (!open) return
    setStep(1)
    setProfileId(initialProfileId || 0)
    setCategoryId(initial?.categoryId || '')
    setDiseaseId(initial?.diseaseId || '')
    setBranchId(initial?.branchId || '')
    setSyndromeId(initial?.syndromeId || '')
    setSymptoms([...(initial?.symptoms || [])])
    setChiefComplaint(initial?.chiefComplaint || '')
  }, [open, initial, initialProfileId])

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 内联 transform 覆盖默认的 -translate-y-1/2：否则 top:5vh 配 translateY(-50%) 会把头部顶出视口。
          hideClose：头部已自带春分谱关闭钮，隐藏 DialogContent 右上角自动关闭钮，避免出现两个“关闭”。 */}
      <DialogContent
        className="triage-dialog-content"
        style={{ maxWidth: 'min(920px, 94vw)', top: '5vh', transform: 'translateX(-50%)' }}
        hideClose
      >
        <DialogHeader>
          <div className="triage-header">
            <div className="triage-heading">
              <span className="triage-heading-icon">
                <MaterialIcon name="stethoscope" size={26} />
              </span>
              <div>
                <DialogTitle>
                  {mode === 'edit' ? '调整分诊信息' : '开始新的慢病问诊'}
                </DialogTitle>
                <p>依据《{triageData.sourceDocument}》逐级完成中医分诊</p>
              </div>
            </div>
            <button
              className="close-button"
              type="button"
              aria-label="关闭分诊"
              onClick={() => onOpenChange(false)}
            >
              <MaterialIcon name="close" size={20} />
            </button>
          </div>
          <DialogDescription className="sr-only">分诊流程对话框</DialogDescription>
          <div className="triage-progress" aria-label="分诊进度">
            {PROGRESS_ITEMS.map((item) => (
              <div
                key={item.step}
                className={step === item.step ? 'active' : step > item.step ? 'done' : ''}
              >
                <MaterialIcon
                  name={step > item.step ? 'check_circle' : item.icon}
                  size={18}
                />
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </DialogHeader>

        {step === 1 && (
          <section className="triage-step">
            <div className="step-intro">
              <span>问诊对象与疾病大类</span>
              <small>先选择患者档案，再选择最接近的疾病分类</small>
            </div>
            <label className="profile-field">
              <span>问诊对象</span>
              <select
                value={profileId}
                onChange={(e) => setProfileId(Number(e.target.value))}
              >
                <option value={0}>不关联患者档案</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || `患者 ${p.id}`}{p.is_default ? '（默认）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="option-list category-grid">
              {triageData.categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={`option-card${categoryId === category.id ? ' selected' : ''}`}
                  onClick={() => chooseCategory(category.id)}
                >
                  <MaterialIcon name="category" size={22} />
                  <span>
                    <strong>{category.name}</strong>
                    <small>{category.diseases.length} 类疾病</small>
                  </span>
                  {categoryId === category.id && <MaterialIcon name="check_circle" size={20} />}
                </button>
              ))}
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="triage-step">
            <div className="step-intro">
              <span>选择具体疾病</span>
              <small>{currentCategory?.name} · 共 {currentCategory?.diseases.length || 0} 项</small>
            </div>
            <div className="option-list disease-grid">
              {currentCategory?.diseases.map((disease) => (
                <button
                  key={disease.id}
                  type="button"
                  className={`disease-card${diseaseId === disease.id ? ' selected' : ''}`}
                  onClick={() => chooseDisease(disease.id)}
                >
                  <span className="disease-icon"><MaterialIcon name="clinical_notes" size={20} /></span>
                  <span>
                    <strong>{disease.name}</strong>
                    <small>{disease.nameEn}</small>
                    <em>{disease.department || '中医专科分诊'}</em>
                  </span>
                  {diseaseId === disease.id && <MaterialIcon name="check_circle" size={20} />}
                </button>
              ))}
            </div>
            {currentDisease?.consensus && (
              <aside className="consensus-note">
                <MaterialIcon name="menu_book" size={18} />
                <p>{currentDisease.consensus}</p>
              </aside>
            )}
          </section>
        )}

        {step === 3 && (
          <section className="triage-step">
            <div className="step-intro">
              <span>辨病机与证型</span>
              <small>{currentDisease?.name} · 选择最符合当前表现的一项</small>
            </div>
            {currentDisease?.branches.length ? (
              <>
                <h3 className="choice-heading">核心分叉</h3>
                <div className="branch-list">
                  {currentDisease.branches.map((branch) => (
                    <button
                      key={branch.id}
                      type="button"
                      className={branchId === branch.id ? 'selected' : ''}
                      onClick={() => chooseBranch(branch.id)}
                    >
                      <span className="branch-code">{branch.id}</span>
                      <span>
                        <strong>{branch.label}</strong>
                        <small>{branch.description}</small>
                      </span>
                      {branchId === branch.id && <MaterialIcon name="check_circle" size={20} />}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {availableSyndromes.length ? (
              <>
                <h3 className="choice-heading">具体证型</h3>
                <div className="syndrome-list">
                  {availableSyndromes.map((syndrome) => (
                    <button
                      key={syndrome.id}
                      type="button"
                      className={`${syndromeId === syndrome.id ? 'selected' : ''}${syndrome.emergency ? ' urgent' : ''}`}
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
                        size={20}
                      />
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {!currentDisease?.branches.length && !availableSyndromes.length && (
              <aside className="consensus-note">
                <MaterialIcon name="info" size={18} />
                <p>文档未设置更细分支，可直接补充主诉后开始问诊，由医生结合舌脉与检查进一步辨证。</p>
              </aside>
            )}
          </section>
        )}

        {step === 4 && (
          <section className="triage-step">
            <div className="step-intro">
              <span>补充症状并确认</span>
              <small>勾选当前确有的表现，避免把模板症状全部带入问诊</small>
            </div>
            {selectedSyndrome?.symptoms.length ? (
              <div className="symptom-section">
                <h3 className="choice-heading">典型表现</h3>
                <div className="symptom-chips">
                  {selectedSyndrome.symptoms.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={symptoms.includes(s) ? 'selected' : ''}
                      onClick={() => toggleSymptom(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <label className="complaint-field">
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
              <aside className="emergency-note">
                <MaterialIcon name="emergency" size={20} />
                <div>
                  <strong>命中急危重症分诊特征</strong>
                  <p>请优先联系急救或立即前往急诊，本系统不能替代现场处置。</p>
                </div>
              </aside>
            )}
            <div className="triage-summary">
              <div><span>疾病分类</span><strong>{currentCategory?.name}</strong></div>
              <div><span>分诊疾病</span><strong>{currentDisease?.name}</strong></div>
              <div><span>病机分支</span><strong>{selectedBranch?.label || '文档未设独立分支'}</strong></div>
              <div><span>初步证型</span><strong>{selectedSyndrome?.label || selectedBranch?.label || '待医师辨证'}</strong></div>
            </div>
            <p className="triage-disclaimer">分诊结果只用于组织问诊信息，不构成诊断或处方依据。</p>
          </section>
        )}

        <div className="triage-footer">
          {mode === 'create' ? (
            <button
              className="text-button"
              type="button"
              onClick={onSkip}
            >
              暂不分诊，直接问诊
            </button>
          ) : <span />}
          <div>
            {step > 1 && (
              <button className="secondary-button" type="button" onClick={() => setStep((s) => s - 1)}>
                <MaterialIcon name="arrow_back" size={18} />上一步
              </button>
            )}
            {step < 4 ? (
              <button
                className="primary-button"
                type="button"
                disabled={!canContinue}
                onClick={() => setStep((s) => s + 1)}
              >
                下一步<MaterialIcon name="arrow_forward" size={18} />
              </button>
            ) : (
              <button className="primary-button start-button" type="button" onClick={submit}>
                <MaterialIcon name="check" size={18} />{mode === 'edit' ? '保存分诊' : '开始问诊'}
              </button>
            )}
          </div>
        </div>
      </DialogContent>

      <style>{`
        .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
        .triage-dialog-content{width:min(920px,94vw);max-height:90vh;overflow:auto;border-radius:var(--border-radius-xl);padding:var(--spacing-xl) var(--spacing-xl) var(--spacing-base)}
        .triage-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
        .triage-heading{display:flex;align-items:center;gap:13px}
        .triage-heading-icon{width:44px;height:44px;border-radius:var(--border-radius-lg);background:var(--color-accentSoft);color:var(--color-primary);display:flex;align-items:center;justify-content:center}
        .triage-header h2,.triage-dialog-content [data-slot="dialog-title"]{margin:0;color:var(--color-textPrimary);font-size:20px}
        .triage-heading p{margin:4px 0 0;color:var(--color-textTertiary);font-size:12px}
        .close-button{width:36px;height:36px;border:0;border-radius:var(--border-radius-md);background:transparent;color:var(--color-textSecondary);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s ease,color .15s ease}
        .close-button:hover{background:var(--color-primarySoft);color:var(--color-textPrimary)}
        .triage-progress{margin-top:18px;display:grid;grid-template-columns:repeat(4,1fr);border-radius:var(--border-radius-lg);background:var(--color-primarySoft);padding:5px}
        .triage-progress>div{height:38px;border-radius:var(--border-radius-base);display:flex;align-items:center;justify-content:center;gap:7px;color:var(--color-textTertiary);font-size:12px}
        .triage-progress>div.active{background:var(--color-surface);color:var(--color-primary);box-shadow:var(--shadow-card)}
        .triage-progress>div.done{color:var(--color-primary)}
        .triage-step{min-height:430px;max-height:58vh;overflow:auto;padding:6px 3px 4px}
        .step-intro{display:flex;align-items:baseline;justify-content:space-between;margin:6px 0 16px}
        .step-intro span{font-weight:700;color:var(--color-textPrimary)}
        .step-intro small{color:var(--color-textTertiary)}
        .profile-field{display:grid;grid-template-columns:90px minmax(0,360px);align-items:center;margin-bottom:16px;font-size:13px;color:var(--color-textSecondary)}
        .profile-field select{height:40px;border:1px solid var(--color-borderPrimary);border-radius:var(--border-radius-md);background:var(--color-surface);padding:0 12px;color:var(--color-textPrimary)}
        .option-list{display:grid;gap:2px}
        .option-card,.disease-card,.branch-list button,.syndrome-list button{border:0;border-radius:var(--border-radius-sm);background:transparent;padding:13px 8px;box-shadow:none!important;cursor:pointer;text-align:left;transition:.16s ease;display:grid;align-items:start;color:var(--color-textPrimary);font-family:inherit}
        .option-card:hover,.disease-card:hover,.branch-list button:hover,.syndrome-list button:hover{background:var(--color-primarySoft)}
        .option-card{grid-template-columns:30px minmax(0,1fr) 20px;gap:9px}
        .option-card.selected,.disease-card.selected,.branch-list button.selected,.syndrome-list button.selected{background:var(--color-accentSoft);box-shadow:inset 0 0 0 1px var(--color-primary)!important}
        .option-card.selected>.material-symbol:last-child,.disease-card.selected>.material-symbol:last-child,.branch-list button.selected>.material-symbol:last-child,.syndrome-list button.selected>.material-symbol:last-child{color:var(--color-primary)}
        .option-card strong,.disease-card strong,.branch-list strong,.syndrome-list strong{display:block;font-size:.95rem;font-weight:750;color:var(--color-textSecondary)}
        .option-card small,.disease-card small,.branch-list small,.syndrome-list small{display:block;font-size:.78rem;color:var(--color-textTertiary);line-height:1.55;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;display:-webkit-box}
        .disease-card{grid-template-columns:30px minmax(0,1fr) 20px;gap:10px}
        .disease-icon{color:var(--color-primary)}
        .disease-card small{margin:3px 0 8px}
        .disease-card em{display:block;font-style:normal;font-size:11px;color:var(--color-textTertiary)}
        .consensus-note,.emergency-note{margin-top:14px;border-radius:var(--border-radius-lg);padding:12px 14px;display:flex;gap:10px;align-items:flex-start}
        .consensus-note{background:var(--color-bgSecondary);color:var(--color-textSecondary)}
        .consensus-note p,.emergency-note p{margin:0;line-height:1.65;font-size:12px}
        .choice-heading{font-size:12px;color:var(--color-textSecondary);margin:13px 0 9px}
        .branch-list,.syndrome-list{display:grid;gap:2px}
        .branch-list button{grid-template-columns:28px minmax(0,1fr) 20px;gap:9px}
        .branch-code{width:24px;height:24px;border-radius:50%;background:var(--color-primarySoft);color:var(--color-textSecondary);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px}
        .syndrome-list button{grid-template-columns:minmax(0,1fr) 20px;gap:8px;padding:12px 13px}
        .syndrome-list button.urgent{background:color-mix(in srgb,var(--color-danger) 6%,var(--color-surface));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-danger) 32%,transparent)!important}
        .syndrome-list button.urgent>.material-symbol,.syndrome-list button.urgent.selected>.material-symbol{color:var(--color-danger)}
        .symptom-chips{display:flex;flex-wrap:wrap;gap:8px}
        .symptom-chips button{border:1px solid var(--color-borderPrimary);border-radius:var(--border-radius-full);background:var(--color-surface);padding:9px 14px;color:var(--color-textSecondary);font-size:.88rem;font-weight:650;cursor:pointer}
        .symptom-chips button.selected{border-color:var(--color-primary);background:var(--color-accentSoft);color:var(--color-primary)}
        .complaint-field{display:block;margin-top:18px;position:relative}
        .complaint-field>span{display:block;color:var(--color-textSecondary);font-size:12px;font-weight:700;margin-bottom:7px}
        .complaint-field textarea{width:100%;box-sizing:border-box;border:1px solid var(--color-borderPrimary);border-radius:var(--border-radius-lg);padding:12px 13px;resize:vertical;outline:none;line-height:1.65;color:var(--color-textPrimary);font-family:inherit}
        .complaint-field textarea:focus{border-color:var(--color-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--color-primary) 14%,transparent)}
        .complaint-field>small{position:absolute;right:10px;bottom:8px;color:var(--color-textTertiary)}
        .emergency-note{background:color-mix(in srgb,var(--color-danger) 7%,var(--color-surface));border:1px solid color-mix(in srgb,var(--color-danger) 32%,transparent);color:var(--color-danger)}
        .emergency-note strong{display:block;margin-bottom:3px}
        .triage-summary{display:grid;grid-template-columns:repeat(2,1fr);gap:0;border-top:1px solid var(--color-borderPrimary);border-bottom:1px solid var(--color-borderPrimary);margin-top:16px}
        .triage-summary>div{border-radius:0;background:transparent;padding:11px 12px}
        .triage-summary>div:nth-child(odd){border-right:1px solid var(--color-borderPrimary)}
        .triage-summary span,.triage-summary strong{display:block}
        .triage-summary span{font-size:10px;color:var(--color-textTertiary)}
        .triage-summary strong{font-size:12px;color:var(--color-textSecondary);margin-top:3px}
        .triage-disclaimer{text-align:center;color:var(--color-textTertiary);font-size:11px;margin:13px 0 0}
        .triage-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}
        .triage-footer>div{display:flex;gap:8px}
        .text-button,.secondary-button,.primary-button{height:40px;border-radius:var(--border-radius-md);padding:0 15px;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;font-family:inherit;transition:background .15s ease,color .15s ease,border-color .15s ease}
        .text-button{border:0;background:transparent;color:var(--color-textTertiary)}
        .text-button:hover{color:var(--color-textPrimary)}
        .secondary-button{border:1px solid var(--color-borderPrimary);background:var(--color-surface);color:var(--color-textSecondary)}
        .secondary-button:hover{background:var(--color-bgSecondary)}
        .primary-button{border:0;background:var(--color-primary);color:var(--color-bgPrimary);font-weight:700}
        .primary-button:hover:not(:disabled){background:var(--color-accentHover,var(--color-primaryDark))}
        .primary-button:disabled{opacity:.45;cursor:not-allowed}
        .start-button{background:var(--color-primary)}
        .start-button:hover:not(:disabled){background:var(--color-accentHover,var(--color-primaryDark))}
        @media(max-width:700px){.triage-progress span{display:none}.triage-step{max-height:63vh}.step-intro{display:block}.profile-field{grid-template-columns:1fr;gap:6px}.triage-summary{grid-template-columns:1fr}.text-button{padding:0 6px}}
        /* 手机档（≤480）：360px 下页脚三个按钮横排放不下（约 420px > 338px 弹宽）→ 纵向堆叠、
           主/次按钮并排撑满；弹层与步骤区已有 overflow:auto（内容多时内滚），此处再放开
           .triage-step 的 min-height:430px，避免小屏（高 ≤640）被最小高度撑出外部滚动 */
        @media(max-width:480px){
          .triage-dialog-content{padding:18px 14px 14px}
          .triage-step{min-height:0}
          .close-button{width:44px;height:44px}
          .profile-field select{height:44px}
          .symptom-chips button{min-height:44px;display:inline-flex;align-items:center}
          .triage-footer{flex-direction:column-reverse;align-items:stretch}
          .triage-footer>div{width:100%}
          .triage-footer>div .secondary-button,.triage-footer>div .primary-button{flex:1}
          .text-button,.secondary-button,.primary-button{height:44px}
          .text-button{padding:0}
        }
      `}</style>
    </Dialog>
  )
}
