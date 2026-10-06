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

  uploadAttachment: (conversationId: number, file: File, analysisFile?: Blob) => {
    const body = new FormData()
    body.append('file', file)
    if (analysisFile) body.append('analysis_file', analysisFile, file.name)
    return api.post(`/api/chat/conversations/${conversationId}/attachments`, body)
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
