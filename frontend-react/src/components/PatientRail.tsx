/**
 * 患者档案抽屉内容（提取自 Vue Chat.vue 的 el-drawer .patient-rail）
 *
 * 显示在 Chat 页右侧 Sheet 里：档案选择 + 当前档案明细卡。
 * 抽屉外壳（Sheet/Drawer）由调用方提供；这里只渲染主体内容。
 */
import MaterialIcon from '@/components/MaterialIcon'
import type { PatientProfile } from '@/api/patient'

interface Props {
  profiles: PatientProfile[]
  selectedProfileId: number
  onSelect: (id: number) => void
  onEdit?: () => void
}

function genderText(value?: string): string {
  if (value === 'male' || value === '男') return '男'
  if (value === 'female' || value === '女') return '女'
  return '性别未填'
}

export default function PatientRail({ profiles, selectedProfileId, onSelect, onEdit }: Props) {
  const profile = profiles.find((p) => p.id === selectedProfileId)

  return (
    <aside className="patient-rail-content">
      <div className="patient-panel-head">
        <div>
          <h2>患者档案</h2>
          <p>当前问诊将写入此档案</p>
        </div>
        {onEdit && (
          <button className="icon-button" type="button" onClick={onEdit} aria-label="编辑档案">
            <MaterialIcon name="edit" size={18} />
          </button>
        )}
      </div>

      <label className="profile-selector">
        <span>选择档案</span>
        <select
          value={selectedProfileId}
          onChange={(e) => onSelect(Number(e.target.value))}
        >
          {profiles.length === 0 && <option value={0}>暂无档案</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || `患者 ${p.id}`}{p.is_default ? '（默认）' : ''}
            </option>
          ))}
        </select>
      </label>

      {profile ? (
        <div className="patient-card patient-identity">
          <div className="patient-avatar">
            {(profile.name || '?').slice(0, 1)}
          </div>
          <div>
            <strong>{profile.name || `患者 ${profile.id}`}</strong>
            <span>{genderText(profile.gender)} · {profile.age || '年龄未填'}</span>
            <em>{profile.tcm_syndrome || '中医证型待补充'}</em>
          </div>
        </div>
      ) : (
        <div className="profile-empty">
          <MaterialIcon name="person_off" size={28} />
          <h3>暂未选择档案</h3>
          <p>到「患者档案」页新建一份档案，再回到这里关联。</p>
        </div>
      )}

      {profile && (
        <>
          {profile.chief_complaint && (
            <section className="profile-section">
              <h3><MaterialIcon name="forum" size={16} /> 主诉</h3>
              <p>{profile.chief_complaint}</p>
            </section>
          )}
          {profile.diseases?.length > 0 && (
            <section className="profile-section">
              <h3><MaterialIcon name="medical_information" size={16} /> 既往诊断</h3>
              <div className="tag-list">
                {profile.diseases.map((d) => (
                  <span key={d} className="muted-tag">{d}</span>
                ))}
              </div>
            </section>
          )}
          {profile.symptoms?.length > 0 && (
            <section className="profile-section">
              <h3><MaterialIcon name="monitor_heart" size={16} /> 主要症状</h3>
              <div className="tag-list">
                {profile.symptoms.map((s) => (
                  <span key={s} className="muted-tag">{s}</span>
                ))}
              </div>
            </section>
          )}
          {profile.constitution && (
            <section className="profile-section">
              <h3><MaterialIcon name="spa" size={16} /> 体质</h3>
              <p>{profile.constitution}</p>
            </section>
          )}
          {profile.family_history?.length > 0 && (
            <section className="profile-section">
              <h3><MaterialIcon name="groups" size={16} /> 家族史</h3>
              <div className="tag-list">
                {profile.family_history.map((h, i) => (
                  <span key={i} className="muted-tag">{h.relation} · {h.disease}</span>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <style>{`
        .patient-rail-content{display:flex;flex-direction:column;gap:14px;padding:14px 16px;height:100%;overflow:auto}
        .patient-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
        .patient-panel-head h2{margin:0;color:var(--color-textPrimary);font-size:16px;font-family:var(--font-family-serif)}
        .patient-panel-head p{margin:3px 0 0;color:var(--color-textTertiary);font-size:11px}
        .icon-button{width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--color-textSecondary);cursor:pointer;display:grid;place-items:center}
        .icon-button:hover{background:var(--color-primarySoft)}
        .profile-selector{display:flex;flex-direction:column;gap:6px}
        .profile-selector>span{font-size:11px;color:var(--color-textTertiary)}
        .profile-selector select{height:38px;border:1px solid var(--color-borderPrimary);border-radius:9px;padding:0 10px;background:var(--color-surface);color:var(--color-textPrimary);font-family:inherit}
        .patient-card,.profile-section{padding:12px 14px;border:1px solid var(--color-borderLight);border-radius:12px;background:var(--color-surface)}
        .patient-identity{display:flex;gap:12px;align-items:center}
        .patient-avatar{width:42px;height:42px;border-radius:50%;background:var(--qinggua);color:var(--color-white);display:grid;place-items:center;font-size:16px;font-weight:700;flex:0 0 42px}
        .patient-identity strong{display:block;color:var(--color-textPrimary);font-size:14px}
        .patient-identity span{display:block;color:var(--color-textTertiary);font-size:11px;margin-top:2px}
        .patient-identity em{display:block;font-style:normal;font-size:11px;color:var(--color-accent);margin-top:4px}
        .profile-section h3{display:flex;align-items:center;gap:7px;margin:0 0 8px;font-size:12px;color:var(--color-textSecondary);font-weight:700}
        .profile-section p{margin:0;color:var(--color-textSecondary);font-size:12px;line-height:1.7}
        .tag-list{display:flex;flex-wrap:wrap;gap:6px}
        .muted-tag{font-size:11px;border-radius:999px;padding:3px 10px;background:var(--color-surfaceMuted);color:var(--color-textTertiary)}
        .profile-empty{text-align:center;padding:30px 16px;color:var(--color-textTertiary)}
        .profile-empty h3{margin:10px 0 4px;font-size:13px;color:var(--color-textSecondary)}
        .profile-empty p{margin:0;font-size:11px;line-height:1.7}
      `}</style>
    </aside>
  )
}
