/**
 * 患者档案 + 账号安全（迁移自 Vue Profile.vue）
 *
 * 左侧档案列表 + 右侧档案明细卡 + 账号安全卡（改密码用 react-hook-form + zod）。
 * 档案编辑用 Dialog + 受控表单；删除用 confirmDialog。
 */
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import MaterialIcon from '@/components/MaterialIcon'
import { authAPI } from '@/api/auth'
import { patientAPI, type PatientProfile } from '@/api/patient'
import { confirmDialog, notify } from '@/lib/toast'
import { useUserStore } from '@/stores/user'

function genderText(value?: string): string {
  if (value === 'male') return '男'
  if (value === 'female') return '女'
  return value ? '其他' : '未填写'
}
function formatDate(value?: string): string {
  if (!value) return '未知'
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`
  return new Date(normalized).toLocaleString('zh-CN', { hour12: false })
}
function splitItems(value: string): string[] {
  return value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)
}

interface EditorState {
  name: string; gender: string; age: string; residence: string;
  diseasesText: string; symptomsText: string;
  tcm_syndrome: string; constitution: string; chief_complaint: string;
}
const EMPTY_EDITOR: EditorState = {
  name: '', gender: '', age: '', residence: '', diseasesText: '', symptomsText: '',
  tcm_syndrome: '', constitution: '', chief_complaint: '',
}

const passwordSchema = z.object({
  password: z.string().min(6, '密码至少 6 位'),
  confirm: z.string(),
}).refine((d) => d.password === d.confirm, { message: '两次密码不一致', path: ['confirm'] })

export default function Profile() {
  const user = useUserStore((s) => s.user)
  const isAdmin = useUserStore((s) => s.user?.role === 'admin')
  const [profiles, setProfiles] = useState<PatientProfile[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR)
  const [saving, setSaving] = useState(false)

  const {
    register: registerPw,
    handleSubmit: handleSubmitPw,
    reset: resetPw,
    formState: { errors: pwErrors },
  } = useForm<{ password: string; confirm: string }>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { password: '', confirm: '' },
  })
  const [pwLoading, setPwLoading] = useState(false)

  const selected = profiles.find((p) => p.id === selectedId) || null
  const defaultProfile = profiles.find((p) => p.is_default) || null
  const diseaseRecordCount = profiles.reduce((sum, p) => sum + (p.diseases?.length || 0), 0)

  const loadProfiles = async () => {
    try {
      const { data } = await patientAPI.getProfiles()
      const list = data as PatientProfile[]
      setProfiles(list)
      if (!selectedId || !list.some((p) => p.id === selectedId)) {
        setSelectedId(list.find((p) => p.is_default)?.id || list[0]?.id || null)
      }
    } catch { /* 拦截器已提示 */ }
  }

  useEffect(() => { void loadProfiles() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => {
    setEditingId(null)
    setEditor(EMPTY_EDITOR)
    setEditorOpen(true)
  }
  const openEdit = (profile: PatientProfile) => {
    setEditingId(profile.id)
    setEditor({
      name: profile.name, gender: profile.gender, age: profile.age, residence: profile.residence,
      diseasesText: (profile.diseases || []).join('、'),
      symptomsText: (profile.symptoms || []).join('、'),
      tcm_syndrome: profile.tcm_syndrome, constitution: profile.constitution || '',
      chief_complaint: profile.chief_complaint,
    })
    setEditorOpen(true)
  }

  const saveProfile = async () => {
    if (!user?.id) return
    setSaving(true)
    // 注意：这里刻意不传 family_history / is_family_member / is_default 三个字段。
    // 后端 services/patient_profile.py update_profile 用 model_dump(exclude_none=True)
    // 只更新 payload 里出现的字段 —— 编辑表单没有这三项的输入，若硬塞
    // family_history:[] / is_family_member:false / is_default:false，会把用户已录入的
    // 家族病史清空、把家庭成员/默认档案标记全部重置（数据丢失）。省略即「不覆盖」；
    // 新建时后端 PatientProfileCreate 对这三项本就有同样的默认值，行为不变。
    const payload = {
      name: editor.name, gender: editor.gender, age: editor.age, residence: editor.residence,
      diseases: splitItems(editor.diseasesText), symptoms: splitItems(editor.symptomsText),
      tcm_syndrome: editor.tcm_syndrome, constitution: editor.constitution,
      chief_complaint: editor.chief_complaint,
    }
    try {
      if (editingId) await patientAPI.updateProfile(editingId, payload)
      else await patientAPI.createProfile({ ...payload, user_id: user.id })
      setEditorOpen(false)
      await loadProfiles()
      notify.success('患者档案已保存')
    } finally {
      setSaving(false)
    }
  }

  const removeProfile = async (profile: PatientProfile) => {
    if (!(await confirmDialog(`确定删除「${profile.name || '未命名患者'}」档案吗？`, '删除档案'))) return
    try {
      await patientAPI.deleteProfile(profile.id)
      await loadProfiles()
      notify.success('档案已删除')
    } catch { /* noop */ }
  }
  const setDefault = async (profile: PatientProfile) => {
    try {
      await patientAPI.setDefault(profile.id)
      await loadProfiles()
      notify.success('默认档案已更新')
    } catch { /* noop */ }
  }

  const onChangePassword = handleSubmitPw(async (values) => {
    setPwLoading(true)
    try {
      await authAPI.updatePassword(values.password)
      resetPw({ password: '', confirm: '' })
      notify.success('密码已更新')
    } finally {
      setPwLoading(false)
    }
  })

  return (
    <div className="profile-page">
      <header className="page-heading">
        <div>
          <span className="page-kicker"><MaterialIcon name="folder_shared" size={18} />健康档案工作台</span>
          <h1>档案管理</h1>
          <p>集中维护本人和家庭成员的真实健康资料，问诊时可直接关联。</p>
        </div>
        <button className="primary-button" type="button" onClick={openCreate}>
          <MaterialIcon name="person_add" size={18} />新建档案
        </button>
      </header>

      <section className="profile-stats">
        <div><small>患者档案</small><strong>{profiles.length}</strong></div>
        <div><small>疾病记录</small><strong>{diseaseRecordCount}</strong></div>
        <div><small>默认问诊对象</small><strong>{defaultProfile?.name || '未设置'}</strong></div>
      </section>

      <div className="profile-layout">
        <aside className="profile-list">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={profile.id === selectedId ? 'active' : ''}
              onClick={() => setSelectedId(profile.id)}
            >
              <span className="profile-icon"><MaterialIcon name="person" size={20} /></span>
              <span>
                <strong>{profile.name || '未命名患者'}</strong>
                <small>{genderText(profile.gender)} · {profile.age || '年龄未填'}</small>
              </span>
              {profile.is_default && <em>默认</em>}
            </button>
          ))}
          {profiles.length === 0 && (
            <div className="empty"><MaterialIcon name="folder_off" size={30} />暂无患者档案</div>
          )}
        </aside>

        <main className="profile-content">
          {selected && (
            <section className="record-card">
              <div className="record-title">
                <div>
                  <h2>{selected.name || '未命名患者'}</h2>
                  <p>更新于 {formatDate(selected.updated_at || selected.created_at)}</p>
                </div>
                <div className="record-actions">
                  <button type="button" onClick={() => setDefault(selected)}>
                    <MaterialIcon name="star" size={17} />设为默认
                  </button>
                  <button type="button" onClick={() => openEdit(selected)}>
                    <MaterialIcon name="edit" size={17} />编辑
                  </button>
                  <button type="button" className="danger" onClick={() => removeProfile(selected)}>
                    <MaterialIcon name="delete" size={17} />删除
                  </button>
                </div>
              </div>
              <dl className="record-grid">
                <div><dt>性别与年龄</dt><dd>{genderText(selected.gender)} · {selected.age || '未填写'}</dd></div>
                <div><dt>现居地</dt><dd>{selected.residence || '未填写'}</dd></div>
                <div><dt>疾病史</dt><dd>{(selected.diseases || []).join('、') || '暂无'}</dd></div>
                <div><dt>近期症状</dt><dd>{(selected.symptoms || []).join('、') || '暂无'}</dd></div>
                <div><dt>中医证型</dt><dd>{selected.tcm_syndrome || '未填写'}</dd></div>
                <div><dt>中医体质</dt><dd>{selected.constitution || '未填写'}</dd></div>
                <div><dt>主诉</dt><dd>{selected.chief_complaint || '未填写'}</dd></div>
              </dl>
            </section>
          )}

          <section className="account-card">
            <h2><MaterialIcon name="shield_person" size={20} />账号安全</h2>
            <p>当前账号：{user?.username || '--'} · {isAdmin ? '管理员' : '普通用户'}</p>
            <form className="password-grid" onSubmit={onChangePassword}>
              <label className="pw-field">
                <span>新密码</span>
                <input type="password" {...registerPw('password')} autoComplete="new-password" />
                {pwErrors.password && <small>{pwErrors.password.message}</small>}
              </label>
              <label className="pw-field">
                <span>确认密码</span>
                <input type="password" {...registerPw('confirm')} autoComplete="new-password" />
                {pwErrors.confirm && <small>{pwErrors.confirm.message}</small>}
              </label>
              <button type="submit" className="primary-button" disabled={pwLoading}>
                {pwLoading ? '更新中…' : '更新密码'}
              </button>
            </form>
          </section>
        </main>
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent style={{ maxWidth: 'min(720px, 94vw)' }}>
          <DialogHeader>
            <DialogTitle>{editingId ? '编辑患者档案' : '新建患者档案'}</DialogTitle>
            <DialogDescription>填写档案信息</DialogDescription>
          </DialogHeader>
          <div className="editor-grid">
            <label className="ed-field"><span>姓名</span><input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} /></label>
            <label className="ed-field">
              <span>性别</span>
              <select value={editor.gender} onChange={(e) => setEditor({ ...editor, gender: e.target.value })}>
                <option value="">未选择</option>
                <option value="male">男</option>
                <option value="female">女</option>
                <option value="other">其他</option>
              </select>
            </label>
            <label className="ed-field"><span>年龄</span><input value={editor.age} onChange={(e) => setEditor({ ...editor, age: e.target.value })} /></label>
            <label className="ed-field"><span>现居地</span><input value={editor.residence} onChange={(e) => setEditor({ ...editor, residence: e.target.value })} /></label>
            <label className="ed-field"><span>疾病史（用顿号或逗号分隔）</span><input value={editor.diseasesText} onChange={(e) => setEditor({ ...editor, diseasesText: e.target.value })} /></label>
            <label className="ed-field"><span>近期症状（用顿号或逗号分隔）</span><input value={editor.symptomsText} onChange={(e) => setEditor({ ...editor, symptomsText: e.target.value })} /></label>
            <label className="ed-field"><span>中医证型</span><input value={editor.tcm_syndrome} onChange={(e) => setEditor({ ...editor, tcm_syndrome: e.target.value })} /></label>
            <label className="ed-field"><span>中医体质</span><input value={editor.constitution} placeholder="如：气虚质、痰湿质" onChange={(e) => setEditor({ ...editor, constitution: e.target.value })} /></label>
            <label className="ed-field wide"><span>主诉</span><textarea rows={3} value={editor.chief_complaint} onChange={(e) => setEditor({ ...editor, chief_complaint: e.target.value })} /></label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button type="button" className="secondary-button" onClick={() => setEditorOpen(false)}>取消</button>
            <button type="button" className="primary-button" disabled={saving} onClick={saveProfile}>
              {saving ? '保存中…' : '保存档案'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <style>{`
        .profile-page{height:100%;overflow:auto;background:var(--color-bgPrimary);padding:34px clamp(20px,5vw,70px);color:var(--color-textPrimary)}
        .page-heading{max-width:1180px;margin:0 auto 18px;display:flex;align-items:center;justify-content:space-between;gap:20px}
        .page-kicker{display:inline-flex;align-items:center;gap:6px;color:var(--color-accent);font-size:12px;font-weight:700;margin-bottom:5px}
        .page-heading h1{font-size:28px;margin:0;font-family:var(--font-family-serif)}
        .page-heading p{font-size:13px;color:var(--color-textTertiary);margin:7px 0 0}
        .primary-button{height:42px;border:0;border-radius:10px;background:var(--color-accent);color:var(--color-primary-foreground);padding:0 18px;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:700}
        .primary-button:disabled{opacity:.6;cursor:not-allowed}
        .secondary-button{height:42px;border:1px solid var(--color-borderPrimary);border-radius:10px;background:var(--color-surface);color:var(--color-textSecondary);padding:0 18px;cursor:pointer;font-family:inherit;font-size:13px}

        .profile-stats{max-width:1180px;margin:0 auto 22px;display:flex;border-top:1px solid var(--color-borderLight);border-bottom:1px solid var(--color-borderLight);padding:16px 0}
        .profile-stats>div{flex:1;padding:0 22px;display:flex;flex-direction:column;align-items:flex-start;border-right:1px solid var(--color-borderLight)}
        .profile-stats>div:first-child{padding-left:0}
        .profile-stats>div:last-child{border-right:0}
        .profile-stats small{color:var(--color-textTertiary);font-size:11px}
        .profile-stats strong{font-size:19px;color:var(--color-textPrimary);margin-top:4px}

        .profile-layout{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:250px 1fr;gap:30px}
        .profile-list{display:flex;flex-direction:column;border-right:1px solid var(--color-borderLight);padding:0 22px 0 0}
        .profile-list>button{width:100%;border:0;border-bottom:1px solid var(--color-surfaceMuted);background:transparent;border-radius:8px;padding:11px;display:grid;grid-template-columns:38px 1fr auto;gap:9px;align-items:center;text-align:left;cursor:pointer;font-family:inherit}
        .profile-list>button.active{background:var(--color-accentSoft);box-shadow:inset 3px 0 0 var(--color-primary)}
        .profile-icon{width:38px;height:38px;border-radius:50%;background:var(--color-accentSoft);color:var(--color-accent);display:flex;align-items:center;justify-content:center}
        .profile-list strong{display:block;font-size:14px;color:var(--color-textPrimary)}
        .profile-list small{display:block;font-size:11px;color:var(--color-textTertiary);margin-top:3px}
        .profile-list em{font-size:10px;font-style:normal;color:var(--color-warning);background:var(--color-primarySoft);padding:3px 6px;border-radius:999px}
        .empty{text-align:center;padding:30px 10px;color:var(--color-textTertiary);font-size:12px}

        .profile-content{display:flex;flex-direction:column;gap:0}
        .record-card{padding:6px 0 28px}
        .record-title{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;border-bottom:1px solid var(--color-borderLight);padding-bottom:18px}
        .record-title h2{font-size:20px;margin:0;font-family:var(--font-family-serif);color:var(--color-textPrimary)}
        .record-title p{font-size:11px;color:var(--color-textTertiary);margin:5px 0 0}
        .record-actions{display:flex;gap:5px}
        .record-actions button{border:1px solid var(--color-borderLight);background:var(--color-surface);border-radius:8px;height:34px;padding:0 10px;color:var(--color-textSecondary);display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;font-family:inherit}
        .record-actions button:hover{border-color:var(--color-accentLight);color:var(--color-accent)}
        .record-actions button.danger{color:var(--color-danger)}
        .record-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px 28px;margin:22px 0 0}
        .record-grid dt{font-size:11px;color:var(--color-textTertiary);margin-bottom:5px}
        .record-grid dd{margin:0;font-size:14px;line-height:1.6;color:var(--color-textPrimary)}

        .account-card{border-top:1px solid var(--color-borderLight);padding-top:28px}
        .account-card h2{display:flex;align-items:center;gap:8px;font-size:18px;margin:0;font-family:var(--font-family-serif);color:var(--color-textPrimary)}
        .account-card h2 .material-symbol{color:var(--color-accent)}
        .account-card>p{font-size:12px;color:var(--color-textTertiary);margin:6px 0 18px}
        .password-grid{display:grid;grid-template-columns:1fr 1fr auto;gap:14px;align-items:end}
        .pw-field{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--color-textSecondary)}
        .pw-field input{height:38px;border:1px solid var(--color-borderPrimary);border-radius:8px;padding:0 12px;font-family:inherit;font-size:13px;color:var(--color-textPrimary);outline:none}
        .pw-field input:focus{border-color:var(--color-accent);box-shadow:0 0 0 2px rgba(0,0,0,.06)}
        .pw-field small{color:var(--color-danger);font-size:11px}

        .editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}
        .ed-field{display:flex;flex-direction:column;gap:5px;margin-bottom:14px;font-size:12px;color:var(--color-textSecondary)}
        .ed-field.wide{grid-column:1/-1}
        .ed-field input,.ed-field select,.ed-field textarea{height:38px;border:1px solid var(--color-borderPrimary);border-radius:8px;padding:0 12px;font-family:inherit;font-size:13px;color:var(--color-textPrimary);outline:none}
        .ed-field textarea{height:auto;padding:9px 12px;resize:vertical;line-height:1.6}
        .ed-field input:focus,.ed-field select:focus,.ed-field textarea:focus{border-color:var(--color-accent);box-shadow:0 0 0 2px rgba(0,0,0,.06)}

        @media(max-width:760px){
          .profile-page{padding:20px 12px}
          .profile-stats{display:grid;grid-template-columns:repeat(3,1fr)}
          .profile-stats>div{padding:0 12px}
          .profile-layout{grid-template-columns:1fr;gap:22px}
          .profile-list{border-right:0;border-bottom:1px solid var(--color-borderLight);padding:0 0 14px}
          .record-title{display:block}
          .record-actions{margin-top:14px}
          .record-grid,.editor-grid,.password-grid{grid-template-columns:1fr}
          .editor-grid .ed-field.wide{grid-column:auto}
        }
        /* 手机档（≤480）：主要按钮与输入框触控 ≥44px（桌面 760 以上档不受影响） */
        @media(max-width:480px){
          .primary-button,.secondary-button{height:44px}
          .record-actions button{height:44px;padding:0 12px}
          .pw-field input{height:44px}
          .ed-field input,.ed-field select{height:44px}
          .profile-list>button{padding:12px 10px}
        }
      `}</style>
    </div>
  )
}
