import api from './client'

/** 每日配额单人 override：每项 -1=不限、null=跟随全局；整体 null=清除 override */
export interface QuotaOverride {
  tokens?: number | null
  images?: number | null
  web_searches?: number | null
}

/** 今日用量（user_daily_usage 当日累计） */
export interface DailyUsageSummary {
  tokens: number
  images: number
  web_searches: number
}

/** 生效配额（null=不限：管理员或显式 -1） */
export interface EffectiveQuota {
  tokens: number | null
  images: number | null
  web_searches: number | null
}

export interface AdminUser {
  id: number
  username: string
  role: string
  is_banned: boolean
  created_at: string
  /** 每日配额单人 override（null=无 override，完全跟随全局） */
  quota_override?: QuotaOverride | null
  /** 今日已用量（token/图片/网络搜索） */
  today_usage?: DailyUsageSummary
  /** 生效配额（null=不限） */
  effective_quota?: EffectiveQuota
}

export interface ConversationSummary {
  id: number
  title: string
  user_id: number
  is_active: boolean
  created_at: string
}

export interface ConversationMessage {
  id: number
  conversation_id: number
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface AdminSettingsResponse {
  website_name: string
  website_logo: string
  system_prompt: string
  llm_provider: string
  llm_base_url: string
  llm_api_key: string
  llm_api_key_configured: boolean
  llm_model_id: string
  llm_model_name: string
  large_font_scale: number
  suggested_questions_enabled: string
  suggested_questions_provider: string
  suggested_questions_base_url: string
  suggested_questions_api_key: string
  suggested_questions_model_id: string
  suggested_questions_system_prompt: string
  suggested_questions_count: string
  suggested_questions_max_rounds: string
  suggested_questions_template_questions: string
  web_search_enabled: string
  web_search_base_url: string
  web_search_api_key: string
  web_search_api_key_configured: boolean
  knowledge_base_enabled: string
  knowledge_base_url: string
  knowledge_base_api_key: string
  knowledge_base_api_key_configured: boolean
  knowledge_base_top_k: string
  extra_large_font_scale: number
  asr_enabled: string; asr_base_url: string; asr_endpoint: string; asr_api_key: string; asr_api_key_configured: boolean; asr_model: string; asr_language: string; asr_max_seconds: string
  tts_enabled: string; tts_base_url: string; tts_endpoint: string; tts_api_key: string; tts_api_key_configured: boolean; tts_model: string; tts_voice: string; tts_response_format: string
  vl_enabled: string; vl_base_url: string; vl_endpoint: string; vl_api_key: string; vl_api_key_configured: boolean; vl_model: string; vl_system_prompt: string; vl_max_images: string; vl_max_image_mb: string
  rerank_enabled: string; rerank_base_url: string; rerank_endpoint: string; rerank_api_key: string; rerank_api_key_configured: boolean; rerank_model: string; rerank_top_n: string
  medical_storage_root: string
  /** 登录滑块验证码开关："true"/"false"（与后端 system_settings 同键存储） */
  captcha_enabled: string
}

export interface AdminSettingsUpdatePayload {
  website_name?: string
  website_logo?: string
  system_prompt?: string
  llm_provider?: string
  llm_base_url?: string
  llm_api_key?: string
  llm_model_id?: string
  llm_model_name?: string
  large_font_scale?: number
  suggested_questions_enabled?: string
  suggested_questions_provider?: string
  suggested_questions_base_url?: string
  suggested_questions_api_key?: string
  suggested_questions_model_id?: string
  suggested_questions_system_prompt?: string
  suggested_questions_count?: string
  suggested_questions_max_rounds?: string
  suggested_questions_template_questions?: string
  web_search_enabled?: string
  web_search_base_url?: string
  web_search_api_key?: string
  knowledge_base_enabled?: string
  knowledge_base_url?: string
  knowledge_base_api_key?: string
  knowledge_base_top_k?: string
  extra_large_font_scale?: number
  asr_enabled?: string; asr_base_url?: string; asr_endpoint?: string; asr_api_key?: string; asr_model?: string; asr_language?: string; asr_max_seconds?: string
  tts_enabled?: string; tts_base_url?: string; tts_endpoint?: string; tts_api_key?: string; tts_model?: string; tts_voice?: string; tts_response_format?: string
  vl_enabled?: string; vl_base_url?: string; vl_endpoint?: string; vl_api_key?: string; vl_model?: string; vl_system_prompt?: string; vl_max_images?: string; vl_max_image_mb?: string
  rerank_enabled?: string; rerank_base_url?: string; rerank_endpoint?: string; rerank_api_key?: string; rerank_model?: string; rerank_top_n?: string
  medical_storage_root?: string
  /** 登录滑块验证码开关："true"/"false" */
  captcha_enabled?: string
}

export interface TestConnectionPayload {
  llm_provider: string
  llm_api_key: string
  llm_model_id?: string
  llm_model_name?: string
  llm_base_url?: string
  /** 编辑已存配置且未重输密钥时传该配置 id：后端回退用该配置自己存的密钥测试 */
  config_id?: number
  /** 用 LLM Key 测：api_key 传空 + 本开关，后端借用当前启用 LLM 配置的密钥执行测试 */
  borrow_llm_key?: boolean
}

export interface TestConnectionResult {
  success: boolean
  message: string
}

export interface LLMModelOption {
  id: string
  name?: string | null
  owned_by?: string | null
}

export interface ModelListResponse {
  models: LLMModelOption[]
}

export interface LogoUploadResponse {
  logo_url: string
}

/** 模型多配置：能力分类 */
export type ModelConfigCategory = 'llm' | 'search' | 'kb' | 'asr' | 'tts' | 'vl' | 'rerank'

/** 模型多配置条目（api_key 永不回显，仅 api_key_configured 布尔） */
export interface ModelConfigItem {
  id: number
  category: ModelConfigCategory
  name: string
  provider: string
  base_url: string
  endpoint: string
  model_id: string
  model_name: string
  extra: Record<string, string>
  enabled: boolean
  api_key_configured: boolean
  created_at?: string | null
  updated_at?: string | null
}

/** 模型多配置新建/更新载荷（api_key 空串/缺省=不改，传新值=覆盖） */
export interface ModelConfigPayload {
  name: string
  category?: ModelConfigCategory
  provider?: string
  base_url?: string
  endpoint?: string
  model_id?: string
  model_name?: string
  api_key?: string
  extra?: Record<string, string>
}

/** 各测试接口通用字段：借用启用 LLM 密钥开关 */
export interface BorrowKeyOption {
  /** 勾选「用 LLM Key 测」：api_key 传空 + 本开关，后端借用当前启用 LLM 配置的密钥 */
  borrow_llm_key?: boolean
}

export const adminAPI = {
  createUser: (data: { username: string; password: string }) =>
    api.post<AdminUser>('/api/admin/users', data),
  getUsers: () => api.get<AdminUser[]>('/api/admin/users'),
  updateUser: (userId: number, data: { is_banned?: boolean; quota_override?: QuotaOverride | null }) =>
    api.put<AdminUser>(`/api/admin/users/${userId}`, data),
  deleteUser: (userId: number) => api.delete(`/api/admin/users/${userId}`),

  getAllConversations: () => api.get<ConversationSummary[]>('/api/admin/conversations'),
  deleteConversation: (conversationId: number) =>
    api.delete(`/api/admin/conversations/${conversationId}`),
  getConversationMessages: (conversationId: number) =>
    api.get<ConversationMessage[]>(`/api/admin/conversations/${conversationId}/messages`),

  getSettings: () => api.get<AdminSettingsResponse>('/api/admin/settings'),
  updateSettings: (data: AdminSettingsUpdatePayload) =>
    api.put<AdminSettingsResponse>('/api/admin/settings', data),

  testConnection: (data: TestConnectionPayload) =>
    api.post<TestConnectionResult>('/api/admin/settings/test-connection', data),
  fetchModels: (data: { llm_provider: string; llm_api_key: string; llm_base_url?: string }) =>
    api.post<ModelListResponse>('/api/admin/settings/models', data),

  testWebSearch: (data: { base_url: string; api_key?: string; top_k?: number; model?: string; config_id?: number } & BorrowKeyOption) =>
    api.post<TestConnectionResult>('/api/admin/settings/test-web-search', data),
  testKnowledgeBase: (data: { base_url: string; api_key?: string; top_k?: number; config_id?: number } & BorrowKeyOption) =>
    api.post<TestConnectionResult>('/api/admin/settings/test-knowledge-base', data),
  testIntegration: (
    kind: 'asr' | 'tts' | 'vl' | 'rerank' | 'storage',
    data: { base_url: string; endpoint?: string; api_key?: string; model?: string; config_id?: number } & BorrowKeyOption,
  ) => api.post<TestConnectionResult>(`/api/admin/settings/test-${kind}`, data),
  testEmbeddings: (data: { base_url: string; api_key?: string; model: string } & BorrowKeyOption) =>
    api.post<TestConnectionResult>('/api/admin/settings/test-embeddings', data),

  uploadLogo: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post<LogoUploadResponse>('/api/admin/settings/upload-logo', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },

  // ===== 模型多配置（每能力多条，同类别仅一条启用） =====
  getModelConfigs: (category: ModelConfigCategory) =>
    api.get<{ items: ModelConfigItem[] }>('/api/admin/model-configs', { params: { category } }),
  createModelConfig: (data: ModelConfigPayload) =>
    api.post<ModelConfigItem>('/api/admin/model-configs', data),
  updateModelConfig: (id: number, data: Partial<ModelConfigPayload>) =>
    api.put<ModelConfigItem>(`/api/admin/model-configs/${id}`, data),
  deleteModelConfig: (id: number) => api.delete<{ detail: string }>(`/api/admin/model-configs/${id}`),
  enableModelConfig: (id: number) => api.post<ModelConfigItem>(`/api/admin/model-configs/${id}/enable`),
}
