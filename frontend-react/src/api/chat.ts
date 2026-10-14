import api, { API_BASE_URL } from './client'

const buildUrl = (path: string) => `${API_BASE_URL}${path}`

/** 对应 Vue 版 api/chat.ts —— 1:1 移植；sendMessage 保持原生 fetch（SSE 由调用方消费） */
export const chatAPI = {
  createConversation: (
    title: string,
    patientProfileId?: number | null,
    triage?: Record<string, unknown> | null,
    consultationMode: 'free' | 'guided' | 'intake' = 'free',
  ) => api.post('/api/chat/conversations', {
    title,
    patient_profile_id: patientProfileId || null,
    triage: triage || null,
    consultation_mode: consultationMode,
  }),

  getConversations: () => api.get('/api/chat/conversations'),
  getConversation: (id: number) => api.get(`/api/chat/conversations/${id}`),
  getMessages: (conversationId: number) =>
    api.get(`/api/chat/conversations/${conversationId}/messages`),

  updateConversationTitle: (id: number, title: string) =>
    api.put(`/api/chat/conversations/${id}`, { title }),

  updateConversationContext: (
    id: number,
    patientProfileId: number | null,
    triage?: Record<string, unknown> | null,
  ) => {
    const payload: Record<string, unknown> = { patient_profile_id: patientProfileId }
    if (triage !== undefined) payload.triage = triage
    return api.put(`/api/chat/conversations/${id}`, payload)
  },

  sendMessage: (
    conversationId: number,
    content: string,
    profileId?: number,
    attachmentIds: number[] = [],
    signal?: AbortSignal,
  ) => fetch(buildUrl(`/api/chat/conversations/${conversationId}/messages`), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token') ?? ''}`,
    },
    body: JSON.stringify({
      content,
      profile_id: profileId,
      attachment_ids: attachmentIds,
    }),
  }),

  deleteConversation: (id: number) => api.delete(`/api/chat/conversations/${id}`),

  getSuggestedQuestions: (conversationId: number) =>
    api.get(`/api/chat/conversations/${conversationId}/suggested-questions`),

  autoRename: (conversationId: number) =>
    api.post(`/api/chat/conversations/${conversationId}/rename`),

  summarize: (conversationId: number) =>
    api.post(`/api/chat/conversations/${conversationId}/summary`),

  updateFeedback: (messageId: number, feedback: 'helpful' | 'unhelpful' | null) =>
    api.put(`/api/chat/messages/${messageId}/feedback`, { feedback }),

  // 只传调用方缩好的图（Blob）：公网（CF 隧道）上行实测 ~72KB/s，原图 4.5MB 会拖到超时；
  // 视觉模型读 analysis_path || storage_path，存缩图即可。Blob 无文件名，必须显式给。
  uploadAttachment: (conversationId: number, image: Blob, filename: string) => {
    const body = new FormData()
    body.append('file', image, filename)
    return api.post(`/api/chat/conversations/${conversationId}/attachments`, body, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    })
  },

  deleteAttachment: (id: number) => api.delete(`/api/attachments/${id}`),

  transcribe: (file: Blob) => {
    const body = new FormData()
    body.append('file', file, 'recording.webm')
    // 实例默认 Content-Type 是 application/json，FormData 必须显式覆盖为 multipart
    //（否则后端按 JSON 解析请求体 → 422 file 字段缺失）
    return api.post('/api/media/asr', body, { headers: { 'Content-Type': 'multipart/form-data' } })
  },

  ttsUrl: (messageId: number) => buildUrl(`/api/media/tts/messages/${messageId}`),
}
