/**
 * 长辈模式 API —— 配套后端后缀 /api/senior。
 * 两个纯生成端点（不建会话）：question = 生成下一问，report = 汇总 markdown 报告。
 * LLM 生成耗时可能超过 axios 默认 30s；两方法现可附图片（VL 分析）+ 后端可能做
 * 网络搜索，整体链路更长，放宽到 180s。
 */
import api, { API_BASE_URL } from './client'
import triageData from '@/constants/triageData.json'

export interface SeniorHistoryItem {
  question: string
  answer: string
}

export interface SeniorQuestionResult {
  question: string
  options: string[]
  multi: boolean
  tip: string
}

/** 后端 /api/senior/question 请求体 */
export interface SeniorQuestionPayload {
  chief_complaint: string
  history: SeniorHistoryItem[]
  triage_context: string
  /** 医学图片 data URL（data:image/...;base64,...），≤vl_max_images 张、各 ≤vl_max_image_mb MB，仅本轮参考不落库 */
  images?: string[]
  /** 关联的长辈问诊会话 id（第一问完成后后端用它生成会话标题） */
  session_id?: number
}

/** 后端 /api/senior/report 请求体 */
export interface SeniorReportPayload {
  chief_complaint: string
  history: SeniorHistoryItem[]
  /** 同 images（question）；随报告一并交给 VL 与报告上下文 */
  images?: string[]
}

/** 分诊依据摘要上限（与后端约定：紧凑摘要 ≤4000 字） */
const TRIAGE_CONTEXT_LIMIT = 4000

interface SyndromeLike {
  label?: string
}

interface DiseaseLike {
  name?: string
  department?: string
  syndromes?: SyndromeLike[]
}

interface CategoryLike {
  name?: string
  diseases?: DiseaseLike[]
}

/**
 * 把 triageData.json（分类 → 疾病 → 证型）压成分级缩进的纯文本摘要。
 * 形如：
 *   【心血管疾病】
 *   - 冠心病/缺血性心脏病（心脑病症（中医内科））：心气虚损证、心阴亏损证…
 */
export function buildTriageContext(): string {
  const categories = ((triageData as { categories?: CategoryLike[] }).categories) || []
  const lines: string[] = []
  for (const category of categories) {
    if (!category?.name) continue
    lines.push(`【${category.name}】`)
    for (const disease of category.diseases || []) {
      if (!disease?.name) continue
      const department = (disease.department || '').replace(/^科室(入口)?[:：]\s*/, '')
      const syndromes = (disease.syndromes || [])
        .map((s) => (s?.label || '').trim())
        .filter(Boolean)
      const parts = [department ? `（${department}）` : '', syndromes.length ? syndromes.join('、') : '']
        .filter(Boolean)
        .join('：')
      lines.push(`- ${disease.name}${parts ? parts : ''}`)
    }
  }
  const text = lines.join('\n')
  return text.length > TRIAGE_CONTEXT_LIMIT ? text.slice(0, TRIAGE_CONTEXT_LIMIT) : text
}

export const seniorAPI = {
  /** 创建长辈问诊会话（consultation_mode='senior'，与普通问诊历史分离） */
  createSeniorSession: (chiefComplaint: string) =>
    api.post<{ id: number; title: string }>('/api/senior/sessions', { chief_complaint: chiefComplaint }),

  /** 向长辈会话写入一条消息（user=主诉/答案，assistant=题目/报告） */
  saveSeniorMessage: (sessionId: number, role: 'user' | 'assistant', content: string) =>
    api.post<{ id: number }>(`/api/senior/sessions/${sessionId}/messages`, { role, content }),

  /** 生成下一问（依据主诉 + 历史问答 + 分诊依据，可附医学图片） */
  askSeniorQuestion: (payload: SeniorQuestionPayload) =>
    api.post<SeniorQuestionResult>('/api/senior/question', payload, { timeout: 180000 }),

  /** 汇总生成 markdown 健康报告（可附医学图片；正文含 [编号] 来源标记与参考来源附录） */
  askSeniorReport: (payload: SeniorReportPayload) =>
    api.post<{ report: string }>('/api/senior/report', payload, { timeout: 180000 }),

  /** 流式生成下一问（SSE）：原生 fetch + 手动 token 头，由调用方消费 SSE 流 */
  streamSeniorQuestion: (payload: SeniorQuestionPayload, signal?: AbortSignal) =>
    fetch(buildSeniorUrl('/api/senior/question/stream'), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('token') ?? ''}`,
      },
      body: JSON.stringify(payload),
    }),

  /** 流式生成健康报告（SSE）：同上 */
  streamSeniorReport: (payload: SeniorReportPayload, signal?: AbortSignal) =>
    fetch(buildSeniorUrl('/api/senior/report/stream'), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('token') ?? ''}`,
      },
      body: JSON.stringify(payload),
    }),
}

function buildSeniorUrl(path: string): string {
  return `${API_BASE_URL}${path}`
}
