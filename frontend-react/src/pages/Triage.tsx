/**
 * 手动分诊独立页（/triage）
 *
 * 用户要求：把分诊从对话流内嵌提取为独立页面。本页承载 TriageFlow（步进式分诊卡），
 * 提交后跳转 /chat 并以 ?q&mode=guided 触发新建分诊会话（沿用 Chat 的路由 watcher）；
 * 跳过则回 /chat 走自由问诊。
 *
 * 视觉沿用 Chat 欢迎墙的中性纸面底 + 白底卡，顶部一行标题与返回入口。
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TriageFlow from '@/components/TriageFlow'
import type { TriageResult } from '@/components/TriageDialog'
import { patientAPI, type PatientProfile } from '@/api/patient'
import { chatAPI } from '@/api/chat'
import { notify } from '@/lib/toast'
import MaterialIcon from '@/components/MaterialIcon'

export default function Triage() {
  const navigate = useNavigate()
  const [profiles, setProfiles] = useState<PatientProfile[]>([])
  const [initialProfileId, setInitialProfileId] = useState(0)

  useEffect(() => {
    void patientAPI.getProfiles().then(({ data }) => {
      const list = (data as PatientProfile[]) || []
      setProfiles(list)
      const stored = Number(localStorage.getItem('selectedPatientProfile') || 0)
      if (stored && list.some((p) => p.id === stored)) setInitialProfileId(stored)
    }).catch(() => { /* 未登录档案接口 401 已由拦截器处理 */ })
  }, [])

  /** 分诊提交：建 guided 会话（分诊上下文已存入 conversation），跳转到该会话继续问诊。
   *  主诉作为首条消息由 Chat 页面的 SSE 管线发送（避免在独立页裸 fetch SSE 流悬挂） */
  const handleSubmit = async (triage: TriageResult, profileId: number | null) => {
    try {
      const { data: conv } = await chatAPI.createConversation(
        triage.diseaseName || '分诊问诊',
        profileId,
        triage as unknown as Record<string, unknown>,
        'guided',
      )
      // 选中档案持久化（与 Chat 同口径）
      if (profileId) localStorage.setItem('selectedPatientProfile', String(profileId))
      // 带 q=主诉 跳转到该会话；Chat 的路由 watcher 在已有 c 的情况下不会新建会话，
      // 但我们在此通过独立 query（guided-send）触发 Chat 发送首条主诉
      const q = triage.chiefComplaint ? encodeURIComponent(triage.chiefComplaint) : ''
      navigate(q ? `/chat?c=${conv.id}&q=${q}&mode=guided-send` : `/chat?c=${conv.id}`)
    } catch {
      notify.error('创建分诊会话失败，请重试')
    }
  }

  /** 跳过：回自由问诊 */
  const handleSkip = () => navigate('/chat?new=1')

  return (
    <div className="triage-page">
      <div className="triage-page-head">
        <button type="button" className="triage-back" onClick={() => navigate('/chat')}>
          <MaterialIcon name="arrow_back" size={20} />
          <span>返回</span>
        </button>
        <h1 className="triage-page-title">手动分诊</h1>
      </div>
      <div className="triage-page-body">
        <TriageFlow
          profiles={profiles}
          initialProfileId={initialProfileId}
          onSubmit={handleSubmit}
          onSkip={handleSkip}
        />
      </div>
      <style>{`
        /* AppShell 的 .main-content 是 overflow:hidden 的 flex 列容器；
           本页必须自带滚动（flex:1 + overflow-y:auto），否则步骤卡超出一屏后滚轮无处滚 */
        .triage-page {
          flex: 1;
          min-height: 0;
          max-width: 760px;
          width: 100%;
          margin: 0 auto;
          padding: 28px 20px 60px;
          overflow-y: auto;
        }
        .triage-page-head {
          display: flex;
          align-items: center;
          gap: 14px;
          margin-bottom: 22px;
        }
        .triage-back {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: none;
          border: none;
          cursor: pointer;
          color: var(--muted-2, #6b6b6b);
          font-size: 14px;
          padding: 6px 8px;
          border-radius: 8px;
        }
        .triage-back:hover { background: var(--paper-2, #f5f5f5); color: var(--color-text, #1B1B1B); }
        .triage-page-title {
          font-size: 22px;
          font-weight: 700;
          margin: 0;
          color: var(--color-text, #1B1B1B);
        }
        .triage-page-body { padding-top: 4px; }
      `}</style>
    </div>
  )
}
