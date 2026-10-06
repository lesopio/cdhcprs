/**
 * 关于页（迁移自 Vue About.vue）
 * hero + 工作流 + 共识统计（9/36/229 来自 triageData.stats）+ 能力网格 + 原则 + 法律段落 + BackendStatus
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import MaterialIcon from '@/components/MaterialIcon'
import BackendStatus from '@/components/BackendStatus'
import api from '@/api'
import triageDataJson from '@/constants/triageData.json'

const triageData = triageDataJson as {
  sourceDocument: string
  stats: { categoryCount: number; diseaseCount: number; syndromeCount: number }
}

const WORKFLOW = [
  { icon: 'forum', title: '描述症状', desc: '在对话框里写下不舒服、用药史与近期检查' },
  { icon: 'account_tree', title: '中医分诊', desc: '按九大类三十六病分类，匹配最贴近的证型' },
  { icon: 'auto_awesome', title: '生成建议', desc: 'AI 结合公开资料与档案生成可核验的建议' },
  { icon: 'fact_check', title: '核验来源', desc: '每条结论附带指南、共识或文献来源' },
]

const CAPABILITIES = [
  { icon: 'school', title: '循证分诊', desc: '依据权威共识组织问诊信息，避免凭印象判断' },
  { icon: 'history_edu', title: '连续档案', desc: '档案与历次问诊留存，便于跟踪病情变化' },
  { icon: 'verified', title: '可核验回答', desc: '回答附引用，鼓励到原始资料进一步核对' },
  { icon: 'lock', title: '隐私优先', desc: '档案数据保存在你自己账号下，不会外泄' },
]

const PRINCIPLES = [
  { icon: 'handshake', title: '辅助而非替代', desc: 'AI 仅作健康参考，最终决策权在医生与患者' },
  { icon: 'gavel', title: '尊重证据', desc: '优先采用有共识支持的诊疗路径，不杜撰疗法' },
  { icon: 'visibility', title: '透明可追溯', desc: '所有建议都能回溯到具体来源或推理步骤' },
]

const LEGAL = [
  { icon: 'medical_services', title: '使用范围', body: '本系统面向慢性病的健康信息整理，不适用于急症、外伤、精神危机等需要立即就医的场景。' },
  { icon: 'privacy_tip', title: '数据与隐私', body: '档案与问诊记录保存在账号内，传输加密。请勿在问诊中输入他人敏感信息。' },
  { icon: 'warning', title: '免责声明', body: '生成内容可能存在偏差，不能替代医生面诊、检查与处方；如有不适请及时就医。' },
]

export default function About() {
  const [websiteName, setWebsiteName] = useState('慢性病诊疗方案推荐系统')
  useEffect(() => {
    let cancelled = false
    api.get('/api/public/settings')
      .then(({ data }) => { if (!cancelled && data?.website_name) setWebsiteName(data.website_name) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return (
    <div className="about-page">
      <section className="about-hero">
        <div className="hero-copy">
          <span className="hero-kicker"><MaterialIcon name="spa" size={16} />{websiteName}</span>
          <h1>把慢病咨询整理成清晰的记录与可核验的建议</h1>
          <p>橘泉智养以中医慢病分诊共识为骨架，结合档案与公开资料，帮助你和医生把零散的问诊信息整理成可追踪的健康记录。</p>
          <div className="hero-actions">
            <Link to="/chat" className="primary"><MaterialIcon name="chat" size={18} />开始问诊</Link>
            <Link to="/profile" className="secondary"><MaterialIcon name="folder_shared" size={18} />建立档案</Link>
          </div>
          <small>版本 1.4.0</small>
        </div>

        <div className="workflow-card">
          <header>
            <span><MaterialIcon name="route" size={18} />问诊流程<em>四步</em></span>
          </header>
          <ol>
            {WORKFLOW.map((step) => (
              <li key={step.title}>
                <MaterialIcon name={step.icon} size={20} />
                <strong>{step.title}</strong>
                <small>{step.desc}</small>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="consensus-stats">
        <div className="stat-teal">
          <MaterialIcon name="category" size={26} />
          <strong>{triageData.stats.categoryCount}</strong>
          <span>疾病大类</span>
        </div>
        <div className="stat-pink">
          <MaterialIcon name="clinical_notes" size={26} />
          <strong>{triageData.stats.diseaseCount}</strong>
          <span>具体疾病</span>
        </div>
        <div className="stat-red">
          <MaterialIcon name="account_tree" size={26} />
          <strong>{triageData.stats.syndromeCount}</strong>
          <span>辨证证型</span>
        </div>
      </section>

      <section className="capabilities">
        <header className="section-heading">
          <span><MaterialIcon name="auto_awesome" size={16} />核心能力</span>
          <h2>不是另一个聊天机器人</h2>
          <p>围绕中医慢病诊疗的真实流程设计，每一步都可追溯。</p>
        </header>
        <div className="capability-grid">
          {CAPABILITIES.map((cap, i) => (
            <article key={cap.title} className={`accent-${i % 4}`}>
              <span><MaterialIcon name={cap.icon} size={22} /></span>
              <h3>{cap.title}</h3>
              <p>{cap.desc}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="principles">
        <div className="principle-copy">
          <span><MaterialIcon name="favorite" size={16} />我们的坚持</span>
          <h2>慢病咨询应当谨慎而透明</h2>
          <p>慢病管理是长期工程。我们坚持以下原则，确保工具真正服务于医生与患者，而非替代他们。</p>
        </div>
        <div className="principle-list">
          {PRINCIPLES.map((p) => (
            <div key={p.title}>
              <MaterialIcon name={p.icon} size={22} />
              <strong>{p.title}</strong>
              <small>{p.desc}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="source-note">
        <MaterialIcon name="menu_book" size={22} />
        <div>
          <strong>分诊依据</strong>
          <p>本系统的疾病分类与证型数据来自《{triageData.sourceDocument}》，仅用于组织问诊信息。</p>
        </div>
      </section>

      <section className="legal-section">
        <header>
          <span><MaterialIcon name="gavel" size={16} />使用须知</span>
          <h2>在你开始之前</h2>
          <p>请阅读以下条款，使用本系统即视为已阅读并理解。</p>
        </header>
        <div className="legal-columns">
          {LEGAL.map((l) => (
            <article key={l.title}>
              <h3><MaterialIcon name={l.icon} size={18} />{l.title}</h3>
              <p>{l.body}</p>
            </article>
          ))}
        </div>
      </section>

      <BackendStatus />

      <style>{`
        .about-page{min-height:100%;background:var(--color-bgPrimary);color:var(--color-textPrimary);padding:40px clamp(20px,5vw,80px) 80px;font-family:inherit}
        .about-hero{max-width:1180px;margin:0 auto 32px;display:grid;grid-template-columns:1.1fr .9fr;gap:30px;align-items:center}
        .hero-kicker{display:inline-flex;align-items:center;gap:7px;color:var(--color-accent);font-size:12px;font-weight:700;margin-bottom:14px}
        .hero-kicker .material-symbol{color:var(--color-accent)}
        .hero-copy h1{margin:0;font-size:32px;line-height:1.3;color:var(--color-textPrimary);font-family:var(--font-family-serif)}
        .hero-copy>p{margin:16px 0 22px;color:var(--color-textTertiary);font-size:14px;line-height:1.85;max-width:520px}
        .hero-actions{display:flex;gap:10px}
        .hero-actions a{display:inline-flex;align-items:center;gap:7px;border-radius:10px;padding:11px 18px;font-size:13px;font-weight:700;text-decoration:none;cursor:pointer}
        .hero-actions .primary{background:var(--color-accent);color:var(--color-primary-foreground)}
        .hero-actions .secondary{border:1px solid var(--color-borderPrimary);background:var(--color-surface);color:var(--color-textSecondary)}
        .hero-copy>small{display:block;margin-top:14px;color:var(--color-textTertiary);font-size:11px}
        .workflow-card{background:var(--color-surface);border:1px solid var(--color-borderLight);border-radius:14px;padding:18px 22px}
        .workflow-card header{display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--color-borderLight);margin-bottom:14px;font-size:13px;color:var(--color-textSecondary)}
        .workflow-card header span{display:inline-flex;align-items:center;gap:8px}
        .workflow-card header em{font-style:normal;color:var(--color-accent);font-weight:700}
        .workflow-card ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
        .workflow-card li{display:grid;grid-template-columns:28px 1fr;gap:10px;align-items:start}
        .workflow-card li>.material-symbol{color:var(--color-accent)}
        .workflow-card strong{display:block;font-size:13px;color:var(--color-textPrimary)}
        .workflow-card small{display:block;font-size:11px;color:var(--color-textTertiary);margin-top:3px;line-height:1.6}

        .consensus-stats{max-width:1180px;margin:0 auto 32px;display:flex;border-top:1px solid var(--color-borderLight);border-bottom:1px solid var(--color-borderLight);padding:18px 0}
        .consensus-stats>div{flex:1;padding:0 22px;display:flex;flex-direction:column;align-items:flex-start;border-right:1px solid var(--color-borderLight)}
        .consensus-stats>div:last-child{border-right:0}
        .consensus-stats .stat-teal>.material-symbol{color:var(--color-accent)}
        .consensus-stats .stat-pink>.material-symbol{color:var(--color-warning)}
        .consensus-stats .stat-red>.material-symbol{color:var(--color-danger)}
        .consensus-stats strong{font-size:24px;color:var(--color-textPrimary);margin-top:6px;font-family:var(--font-family-serif)}
        .consensus-stats span{display:block;font-size:11px;color:var(--color-textTertiary);margin-top:3px}

        .capabilities{max-width:1180px;margin:0 auto 36px}
        .section-heading{margin-bottom:22px}
        .section-heading>span,.principle-copy>span{display:inline-flex;align-items:center;gap:7px;color:var(--color-accent);font-size:12px;font-weight:700;margin-bottom:8px}
        .section-heading h2,.principle-copy h2{margin:0;font-size:22px;color:var(--color-textPrimary);font-family:var(--font-family-serif)}
        .section-heading p,.principle-copy p{margin:8px 0 0;color:var(--color-textTertiary);font-size:13px;line-height:1.7}
        .capability-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
        .capability-grid article{border:1px solid var(--color-borderLight);border-radius:12px;padding:18px;background:var(--color-surface)}
        .capability-grid article>span{display:inline-flex;width:42px;height:42px;border-radius:10px;background:var(--color-accentSoft);color:var(--color-accent);align-items:center;justify-content:center;margin-bottom:12px}
        .capability-grid h3{margin:0 0 6px;font-size:14px;color:var(--color-textPrimary)}
        .capability-grid p{margin:0;font-size:12px;color:var(--color-textTertiary);line-height:1.7}

        .principles{max-width:1180px;margin:0 auto 36px;display:grid;grid-template-columns:.8fr 1.2fr;gap:30px;align-items:center}
        .principle-list{display:flex;flex-direction:column;border-top:1px solid var(--color-borderLight)}
        .principle-list>div{display:grid;grid-template-columns:28px 1fr;gap:10px;align-items:start;padding:16px 0;border-bottom:1px solid var(--color-borderLight)}
        .principle-list>div>.material-symbol{color:var(--color-primary)}
        .principle-list strong{display:block;font-size:13px;color:var(--color-textPrimary)}
        .principle-list small{display:block;font-size:12px;color:var(--color-textTertiary);margin-top:3px;line-height:1.6}

        .source-note{max-width:1180px;margin:0 auto 36px;display:flex;align-items:flex-start;gap:14px;padding:18px 22px;background:var(--color-accentSoft);border-radius:14px}
        .source-note>.material-symbol{color:var(--color-accent);margin-top:2px}
        .source-note strong{display:block;font-size:13px;color:var(--color-textPrimary);margin-bottom:3px}
        .source-note p{margin:0;font-size:12px;color:var(--color-textSecondary);line-height:1.7}

        .legal-section{max-width:1180px;margin:0 auto}
        .legal-section>header span{display:inline-flex;align-items:center;gap:7px;color:var(--color-warning);font-size:12px;font-weight:700;margin-bottom:6px}
        .legal-section>header h2{margin:0;font-size:20px;color:var(--color-textPrimary);font-family:var(--font-family-serif)}
        .legal-section>header p{margin:6px 0 18px;color:var(--color-textTertiary);font-size:13px}
        .legal-columns{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
        .legal-columns article{border:1px solid var(--color-borderLight);border-radius:12px;padding:16px;background:var(--color-surface)}
        .legal-columns h3{display:flex;align-items:center;gap:7px;margin:0 0 8px;font-size:13px;color:var(--color-textPrimary)}
        .legal-columns h3 .material-symbol{color:var(--color-warning)}
        .legal-columns p{margin:0;font-size:12px;color:var(--color-textTertiary);line-height:1.75}

        @media(max-width:950px){.about-hero{grid-template-columns:1fr}.capabilities .capability-grid{grid-template-columns:repeat(2,1fr)}.principles{grid-template-columns:1fr}.legal-columns{grid-template-columns:1fr}}
        @media(max-width:600px){.about-page{padding:24px 16px 40px}.capabilities .capability-grid{grid-template-columns:1fr}}
      `}</style>
    </div>
  )
}
