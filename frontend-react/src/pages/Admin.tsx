/**
 * 管理后台（迁移自 Vue Admin.vue）
 *
 * 三个 tab：users / conversations / settings（由 URL ?tab= 驱动）。
 * - users / conversations 用 @tanstack/react-table（替代 el-table）
 * - settings 是巨型 react-hook-form 表单，按段落分组渲染
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  flexRender, getCoreRowModel, useReactTable, type ColumnDef,
} from '@tanstack/react-table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import {
  Tabs, TabsList, TabsTrigger, TabsContent,
} from '@/components/ui/tabs'
import MaterialIcon from '@/components/MaterialIcon'
import MarkdownRenderer from '@/components/MarkdownRenderer'
import BackendStatus from '@/components/BackendStatus'
import {
  adminAPI,
  type AdminUser, type ConversationSummary, type ConversationMessage,
  type AdminSettingsResponse, type AdminSettingsUpdatePayload,
  type LLMModelOption, type ModelConfigItem,
} from '@/api/admin'
import api from '@/api'
import { confirmDialog, notify } from '@/lib/toast'

/** 全站档案行（/api/admin/profiles） */
interface AdminProfile {
  id: number
  user_id: number
  name: string
  gender: string
  age: string
  phone?: string
  residence?: string
  is_family_member: boolean
  is_default: boolean
  created_at?: string
}

type TabKey = 'profiles' | 'users' | 'conversations' | 'settings' | 'models'

const LLM_PROVIDERS = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'responses', label: 'DeepSeek Responses' },
  { value: 'qwen', label: 'Qwen 通义千问' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openaiful', label: 'OpenAI 满血' },
  { value: 'dify', label: 'Dify' },
]
const SUGGESTED_PROVIDERS = LLM_PROVIDERS.filter((p) => p.value !== 'responses')
const PROVIDER_DEFAULT_BASE: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
}
const NEEDS_BASE_URL = ['openaiful', 'dify', 'responses']

type ModelCat = 'llm' | 'search' | 'kb' | 'asr' | 'tts' | 'vl' | 'rerank'

/** 各能力 Endpoint 默认值（新增配置时预填） */
const DEFAULT_ENDPOINTS: Record<ModelCat, string> = {
  llm: '', search: '', kb: '',
  asr: '/v1/audio/transcriptions', tts: '/v1/audio/speech', vl: '/v1/responses', rerank: '/v1/rerank',
}

const QIANWEN_BASE_URL = 'https://maas.qianwenaiapi.com/compatible-mode/v1'

/** 「添加预置」定义：点击即按预填参数创建一条配置（api_key 留空），llm 分类无预置 */
interface ModelPreset { name: string; model: string; base_url: string; endpoint?: string }
const MODEL_PRESETS: Partial<Record<ModelCat, ModelPreset[]>> = {
  search: [{ name: 'Tavily 快速搜索（秒级）', model: '', base_url: 'https://api.tavily.com' }, { name: 'Qwen3.8-Flash 联网搜索（DashScope）', model: 'qwen3.8-flash', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }],
  kb: [{ name: 'Qwen3.7 Embedding', model: 'qwen3.7-text-embedding-flash', base_url: QIANWEN_BASE_URL }],
  asr: [{ name: 'Qwen3-Omni 转写（DashScope，实测可用）', model: 'qwen3-omni-flash', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', endpoint: '/chat/completions' }],
  tts: [{ name: 'Qwen3 TTS（DashScope 原生，实测可用）', model: 'qwen3-tts-flash', base_url: 'https://dashscope.aliyuncs.com', endpoint: '/api/v1/services/aigc/multimodal-generation/generation' }],
  vl: [{ name: 'Qwen3.8-Flash 视觉', model: 'qwen3.8-flash', base_url: QIANWEN_BASE_URL, endpoint: '/responses' }],
  rerank: [{ name: 'Qwen 重排（gte-rerank-v2·DashScope）', model: 'gte-rerank-v2', base_url: 'https://dashscope.aliyuncs.com/api/v1', endpoint: '/services/rerank/text-rerank/text-rerank' }],
}

/** 三级表单草稿：绑定选中配置对象（extra_json 专属字段平铺），不再写全局 settings 字段 */
interface ConfigDraft {
  name: string
  provider: string
  base_url: string
  endpoint: string
  api_key: string
  model_id: string
  model_name: string
  knowledge_base_top_k: string
  asr_language: string
  asr_max_seconds: string
  tts_voice: string
  tts_response_format: string
  vl_system_prompt: string
  vl_max_images: string
  vl_max_image_mb: string
  rerank_top_n: string
}

const emptyConfigDraft = (cat: ModelCat): ConfigDraft => ({
  name: '',
  provider: MODEL_PROVIDERS[cat][0]?.value || '',
  base_url: '',
  endpoint: DEFAULT_ENDPOINTS[cat],
  api_key: '',
  model_id: '',
  model_name: '',
  knowledge_base_top_k: '5',
  asr_language: 'zh',
  asr_max_seconds: '60',
  tts_voice: '',
  tts_response_format: 'mp3',
  vl_system_prompt: '',
  vl_max_images: '4',
  vl_max_image_mb: '10',
  rerank_top_n: '5',
})

/** 后端配置对象 → 表单草稿（extra_json 专属字段平铺） */
const draftFromConfig = (c: ModelConfigItem): ConfigDraft => ({
  name: c.name,
  provider: c.provider,
  base_url: c.base_url,
  endpoint: c.endpoint,
  api_key: '',
  model_id: c.model_id,
  model_name: c.model_name,
  knowledge_base_top_k: String(c.extra.knowledge_base_top_k ?? '5'),
  asr_language: String(c.extra.asr_language ?? 'zh'),
  asr_max_seconds: String(c.extra.asr_max_seconds ?? '60'),
  tts_voice: String(c.extra.tts_voice ?? ''),
  tts_response_format: String(c.extra.tts_response_format ?? 'mp3'),
  vl_system_prompt: String(c.extra.vl_system_prompt ?? ''),
  vl_max_images: String(c.extra.vl_max_images ?? '4'),
  vl_max_image_mb: String(c.extra.vl_max_image_mb ?? '10'),
  rerank_top_n: String(c.extra.rerank_top_n ?? '5'),
})

/** 模型设置页：一级能力分类 */
const MODEL_CATEGORIES: Array<{ key: ModelCat; label: string; icon: string }> = [
  { key: 'llm', label: '大语言模型 LLM', icon: 'smart_toy' },
  { key: 'search', label: 'DeepSeek 网络搜索', icon: 'travel_explore' },
  { key: 'kb', label: '知识库检索', icon: 'menu_book' },
  { key: 'asr', label: '语音识别 ASR', icon: 'mic' },
  { key: 'tts', label: '回答朗读 TTS', icon: 'volume_up' },
  { key: 'vl', label: '医学图片分析 VL', icon: 'image_search' },
  { key: 'rerank', label: '知识库证据重排', icon: 'sort' },
]

/** 二级提供商（同类只开一个）：LLM 用供应商单选，其余能力各一个兼容提供方 */
const MODEL_PROVIDERS: Record<ModelCat, Array<{ value: string; label: string }>> = {
  llm: LLM_PROVIDERS.map((p) => ({ value: p.value, label: p.label })),
  search: [{ value: 'tavily', label: 'Tavily（快速·秒级）' }, { value: 'responses', label: 'Responses 兼容（qwen 联网）' }],
  kb: [{ value: 'custom', label: '自定义检索服务' }],
  asr: [{ value: 'openai', label: 'OpenAI 兼容' }],
  tts: [{ value: 'openai', label: 'OpenAI 兼容' }],
  vl: [{ value: 'openai', label: 'OpenAI 兼容' }],
  rerank: [{ value: 'openai', label: 'OpenAI 兼容' }],
}

function formatDateTime(value?: string): string {
  if (!value) return '--'
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`
  const d = new Date(normalized)
  return isNaN(d.getTime()) ? '--' : d.toLocaleString('zh-CN', { hour12: false })
}

export default function Admin() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = (searchParams.get('tab') as TabKey) || 'profiles'
  const setTab = (t: TabKey) => setSearchParams({ tab: t }, { replace: true })

  const [users, setUsers] = useState<AdminUser[]>([])
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [profiles, setProfiles] = useState<AdminProfile[]>([])
  // 模型设置页：当前一级分类（默认大语言模型）+ 多配置管理
  const [modelCat, setModelCat] = useState<ModelCat>('llm')
  const [modelConfigs, setModelConfigs] = useState<ModelConfigItem[]>([])
  const [configsLoading, setConfigsLoading] = useState(false)
  const [selectedConfigId, setSelectedConfigId] = useState<number | null>(null)
  const [configDraft, setConfigDraft] = useState<ConfigDraft>(() => emptyConfigDraft('llm'))
  const [configSaving, setConfigSaving] = useState(false)
  const [configEnabling, setConfigEnabling] = useState(false)
  const [createConfigOpen, setCreateConfigOpen] = useState(false)
  const [newConfigName, setNewConfigName] = useState('')
  const [createConfigSubmitting, setCreateConfigSubmitting] = useState(false)
  const [presetCreating, setPresetCreating] = useState('')
  // 「用 LLM Key 测」：勾选时测试请求 api_key 传空 + borrow_llm_key=true，借用当前启用 LLM 配置的密钥
  const [borrowLlmKey, setBorrowLlmKey] = useState(true)

  // 会话消息查看
  const [messagesOpen, setMessagesOpen] = useState(false)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [selectedConvTitle, setSelectedConvTitle] = useState('')
  const [convMessages, setConvMessages] = useState<ConversationMessage[]>([])

  // 新增用户（管理员创建普通用户；密码策略与后端 core/security.py 一致）
  const [createUserOpen, setCreateUserOpen] = useState(false)
  const [createUserSubmitting, setCreateUserSubmitting] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('')

  // 用户每日额度编辑（用户管理 tab）：三输入框，留空=跟随全局、-1=不限、正整数=单人上限
  const [quotaEditorOpen, setQuotaEditorOpen] = useState(false)
  const [quotaSaving, setQuotaSaving] = useState(false)
  const [quotaUser, setQuotaUser] = useState<AdminUser | null>(null)
  const [quotaTokens, setQuotaTokens] = useState('')
  const [quotaImages, setQuotaImages] = useState('')
  const [quotaWebSearches, setQuotaWebSearches] = useState('')

  /** 输入框文本 → override 值：空=跟随全局(null)、-1=不限、正整数=上限；非法返回 'invalid' */
  const quotaInputToValue = (raw: string): number | null | 'invalid' => {
    const text = raw.trim()
    if (!text) return null
    if (text === '-1') return -1
    return /^\d+$/.test(text) ? Number(text) : 'invalid'
  }
  /** override 值 → 输入框文本（null/未设置 → 空） */
  const quotaValueToInput = (value: number | null | undefined): string =>
    value == null ? '' : String(value)

  const openQuotaEditor = (u: AdminUser) => {
    setQuotaUser(u)
    setQuotaTokens(quotaValueToInput(u.quota_override?.tokens))
    setQuotaImages(quotaValueToInput(u.quota_override?.images))
    setQuotaWebSearches(quotaValueToInput(u.quota_override?.web_searches))
    setQuotaEditorOpen(true)
  }

  const handleSaveQuota = async () => {
    if (!quotaUser) return
    const tokens = quotaInputToValue(quotaTokens)
    const images = quotaInputToValue(quotaImages)
    const webSearches = quotaInputToValue(quotaWebSearches)
    if (tokens === 'invalid' || images === 'invalid' || webSearches === 'invalid') {
      notify.warning('额度只能填正整数、-1（不限）或留空（跟随全局）')
      return
    }
    const allFollowGlobal = tokens == null && images == null && webSearches == null
    setQuotaSaving(true)
    try {
      await adminAPI.updateUser(quotaUser.id, {
        // 全部留空 → 传 null 清除 override（完全跟随全局默认）
        quota_override: allFollowGlobal ? null : { tokens, images, web_searches: webSearches },
      })
      await loadUsers()
      notify.success(`用户「${quotaUser.username}」每日额度已保存`)
      setQuotaEditorOpen(false)
    } catch { /* 拦截器已 toast 后端 detail */ } finally {
      setQuotaSaving(false)
    }
  }

  // 设置表单
  const [settings, setSettings] = useState<AdminSettingsResponse | null>(null)
  const [modelOptions, setModelOptions] = useState<LLMModelOption[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [testing, setTesting] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [saving, setSaving] = useState(false)
  const logoInputRef = useRef<HTMLInputElement | null>(null)

  const loadUsers = async () => {
    try { const { data } = await adminAPI.getUsers(); setUsers(data as AdminUser[]) } catch { /* noop */ }
  }
  const loadProfiles = async () => {
    try { const { data } = await api.get('/api/admin/profiles'); setProfiles(data as AdminProfile[]) } catch { /* noop */ }
  }
  const loadConversations = async () => {
    try { const { data } = await adminAPI.getAllConversations(); setConversations(data as ConversationSummary[]) } catch { /* noop */ }
  }
  const loadSettings = async () => {
    try {
      const { data } = await adminAPI.getSettings()
      setSettings(data)
      if (data.llm_model_id) setModelOptions([{ id: data.llm_model_id, name: data.llm_model_name }])
    } catch { /* noop */ }
  }

  useEffect(() => {
    void Promise.all([loadUsers(), loadProfiles(), loadConversations(), loadSettings()])
  }, [])

  // 全站档案表列（归属用户名由 users 列表映射）
  const profileColumns = useMemo<ColumnDef<AdminProfile>[]>(() => [
    { accessorKey: 'id', header: () => 'ID', size: 70 },
    { accessorKey: 'name', header: () => '患者姓名' },
    {
      id: 'owner', header: () => '归属用户',
      cell: ({ row }) => users.find((u) => u.id === row.original.user_id)?.username ?? `用户 ${row.original.user_id}`,
    },
    { accessorKey: 'gender', header: () => '性别', cell: ({ row }) => ({ male: '男', female: '女', other: '其他' } as Record<string, string>)[row.original.gender] || row.original.gender || '--' },
    { accessorKey: 'age', header: () => '年龄' },
    { accessorKey: 'phone', header: () => '联系电话', cell: ({ row }) => row.original.phone || '--' },
    { accessorKey: 'residence', header: () => '居住地区', cell: ({ row }) => row.original.residence || '--' },
    {
      id: 'kind', header: () => '类型',
      cell: ({ row }) => (
        <span className={`tag ${row.original.is_family_member ? 'tag-primary' : 'tag-success'}`}>
          {row.original.is_family_member ? '家庭成员' : '本人档案'}
        </span>
      ),
    },
    { accessorKey: 'created_at', header: () => '创建时间', cell: ({ row }) => formatDateTime(row.original.created_at) },
  ], [users])

  // Users 表的列
  const userColumns = useMemo<ColumnDef<AdminUser>[]>(() => [
    { accessorKey: 'id', header: () => 'ID', size: 70 },
    { accessorKey: 'username', header: () => '用户名' },
    {
      accessorKey: 'role', header: () => '角色',
      cell: ({ row }) => (
        <span className={`tag ${row.original.role === 'admin' ? 'tag-danger' : 'tag-primary'}`}>
          {row.original.role === 'admin' ? '管理员' : '用户'}
        </span>
      ),
    },
    {
      id: 'status', header: () => '状态',
      cell: ({ row }) => (
        <span className={`tag ${row.original.is_banned ? 'tag-danger' : 'tag-success'}`}>
          {row.original.is_banned ? '已封禁' : '正常'}
        </span>
      ),
    },
    {
      // 今日用量（token/图片/网络搜索，token 以「万」简写如 12.3w/50w；配额 null=不限）
      id: 'usage', header: () => '今日用量',
      cell: ({ row }) => {
        const u = row.original
        if (u.role === 'admin') return <span className="tag tag-muted">不限</span>
        const usage = u.today_usage
        const quota = u.effective_quota
        if (!usage || !quota) return '--'
        const fmt = (n: number) => (n >= 10000 ? `${+(n / 10000).toFixed(1)}w` : `${n}`)
        const quotaText = (v: number | null) => (v == null ? '不限' : fmt(v))
        return (
          <div className="usage-cell">
            <span>token {fmt(usage.tokens)}/{quotaText(quota.tokens)}</span>
            <span>图 {usage.images}/{quotaText(quota.images)}</span>
            <span>搜 {usage.web_searches}/{quotaText(quota.web_searches)}</span>
          </div>
        )
      },
    },
    { accessorKey: 'created_at', header: () => '注册时间', cell: ({ row }) => formatDateTime(row.original.created_at) },
    {
      id: 'actions', header: () => '操作', size: 220,
      cell: ({ row }) => {
        const u = row.original
        return (
          <div className="row-actions">
            {u.role !== 'admin' && (
              <button type="button" className="mini-btn" onClick={() => openQuotaEditor(u)}>额度</button>
            )}
            {!u.is_banned ? (
              <button type="button" className="mini-btn warning" onClick={async () => {
                if (!(await confirmDialog(`确定封禁用户「${u.username}」吗？封禁后该用户将无法登录。`, '封禁用户'))) return
                try { await adminAPI.updateUser(u.id, { is_banned: true }); await loadUsers(); notify.success('用户已封禁') } catch { /* noop */ }
              }}>封禁</button>
            ) : (
              <button type="button" className="mini-btn success" onClick={async () => {
                if (!(await confirmDialog(`确定解封用户「${u.username}」吗？解封后该用户可正常登录。`, '解封用户'))) return
                try { await adminAPI.updateUser(u.id, { is_banned: false }); await loadUsers(); notify.success('用户已解封') } catch { /* noop */ }
              }}>解封</button>
            )}
            <button type="button" className="mini-btn danger" onClick={async () => {
              if (!(await confirmDialog(`确定删除用户「${u.username}」吗？此操作不可恢复。`, '删除用户'))) return
              try { await adminAPI.deleteUser(u.id); await loadUsers(); notify.success('用户已删除') } catch { /* noop */ }
            }}>删除</button>
          </div>
        )
      },
    },
  ], [])
  const userTable = useReactTable({ data: users, columns: userColumns, getCoreRowModel: getCoreRowModel() })

  // Conversations 表的列
  const convColumns = useMemo<ColumnDef<ConversationSummary>[]>(() => [
    { accessorKey: 'id', header: () => 'ID', size: 70 },
    { accessorKey: 'title', header: () => '会话标题' },
    { accessorKey: 'user_id', header: () => '用户 ID', size: 110 },
    {
      id: 'status', header: () => '状态',
      cell: ({ row }) => (
        <span className={`tag ${row.original.is_active ? 'tag-success' : 'tag-muted'}`}>
          {row.original.is_active ? '正常' : '已停用'}
        </span>
      ),
    },
    { accessorKey: 'created_at', header: () => '创建时间', cell: ({ row }) => formatDateTime(row.original.created_at) },
    {
      id: 'actions', header: () => '操作', size: 200,
      cell: ({ row }) => {
        const c = row.original
        return (
          <div className="row-actions">
            <button type="button" className="mini-btn" onClick={() => openMessages(c)}>查看</button>
            <button type="button" className="mini-btn danger" onClick={async () => {
              if (!(await confirmDialog(`确定删除会话「${c.title || '未命名'}」吗？`, '删除会话'))) return
              try { await adminAPI.deleteConversation(c.id); await loadConversations(); notify.success('会话已删除') } catch { /* noop */ }
            }}>删除</button>
          </div>
        )
      },
    },
  ], [])
  const profileTable = useReactTable({ data: profiles, columns: profileColumns, getCoreRowModel: getCoreRowModel() })
  const convTable = useReactTable({ data: conversations, columns: convColumns, getCoreRowModel: getCoreRowModel() })

  const openMessages = async (conv: ConversationSummary) => {
    setSelectedConvTitle(conv.title || '未命名会话')
    setMessagesOpen(true)
    setMessagesLoading(true)
    setConvMessages([])
    try {
      const { data } = await adminAPI.getConversationMessages(conv.id)
      setConvMessages(data as ConversationMessage[])
    } catch { /* noop */ } finally { setMessagesLoading(false) }
  }

  // ===== 新增用户：前端校验与后端 core/security.py password_strength_error 同口径 =====
  const validateNewUser = (): string | null => {
    const username = newUsername.trim()
    if (username.length < 3 || username.length > 50) return '用户名长度需为 3-50 个字符'
    if (newPassword.length < 12) return '密码至少需要 12 个字符'
    if (!(/[a-z]/.test(newPassword) && /[A-Z]/.test(newPassword) && /\d/.test(newPassword) && /[^A-Za-z0-9]/.test(newPassword))) {
      return '密码必须同时包含大写字母、小写字母、数字和特殊符号'
    }
    if (newPassword !== newPasswordConfirm) return '两次输入的密码不一致'
    return null
  }
  const openCreateUser = () => {
    setNewUsername(''); setNewPassword(''); setNewPasswordConfirm('')
    setCreateUserOpen(true)
  }
  const handleCreateUser = async () => {
    const invalid = validateNewUser()
    if (invalid) { notify.warning(invalid); return }
    setCreateUserSubmitting(true)
    try {
      await adminAPI.createUser({ username: newUsername.trim(), password: newPassword })
      await loadUsers()
      notify.success(`用户「${newUsername.trim()}」已创建`)
      setCreateUserOpen(false)
    } catch { /* 拦截器已 toast 后端 detail（如「用户名已存在」） */ } finally {
      setCreateUserSubmitting(false)
    }
  }

  // ===== 设置表单字段更新辅助 =====
  const setField = <K extends keyof AdminSettingsResponse>(key: K, value: AdminSettingsResponse[K]) => {
    setSettings((prev) => prev ? { ...prev, [key]: value } : prev)
  }
  // ===== 模型多配置：加载 / 选中 / 新增 / 删除 / 保存 / 启用 =====
  const selectedConfig = modelConfigs.find((c) => c.id === selectedConfigId) || null
  const applyConfigSelection = (items: ModelConfigItem[], preferId?: number | null) => {
    const next = (preferId != null ? items.find((c) => c.id === preferId) : null)
      || items.find((c) => c.enabled)
      || items[0]
      || null
    setSelectedConfigId(next ? next.id : null)
    setConfigDraft(next ? draftFromConfig(next) : emptyConfigDraft(modelCat))
  }
  const loadModelConfigs = async (cat: ModelCat, preferId?: number | null) => {
    setConfigsLoading(true)
    try {
      const { data } = await adminAPI.getModelConfigs(cat)
      const items = (data as { items: ModelConfigItem[] }).items || []
      setModelConfigs(items)
      applyConfigSelection(items, preferId)
      setModelOptions([])
    } catch { /* 拦截器已 toast */ } finally { setConfigsLoading(false) }
  }
  useEffect(() => { void loadModelConfigs(modelCat) }, [modelCat])
  const selectModelConfig = (c: ModelConfigItem) => {
    setSelectedConfigId(c.id)
    setConfigDraft(draftFromConfig(c))
    setModelOptions([])
  }
  const setDraftField = (key: keyof ConfigDraft, value: string) => {
    setConfigDraft((prev) => ({ ...prev, [key]: value }))
  }
  const handleDraftProviderChange = (provider: string) => {
    setConfigDraft((prev) => ({ ...prev, provider, base_url: PROVIDER_DEFAULT_BASE[provider] ?? prev.base_url }))
  }
  const openCreateConfig = () => { setNewConfigName(''); setCreateConfigOpen(true) }
  const handleCreateConfig = async () => {
    const name = newConfigName.trim()
    if (!name) { notify.warning('请填写配置名称'); return }
    setCreateConfigSubmitting(true)
    try {
      const { data } = await adminAPI.createModelConfig({
        category: modelCat, name, provider: MODEL_PROVIDERS[modelCat][0]?.value || '',
      })
      const saved = data as ModelConfigItem
      setCreateConfigOpen(false)
      await loadModelConfigs(modelCat, saved.id)
      notify.success(`配置「${saved.name}」已创建，请完善参数后保存`)
    } catch { /* 拦截器已 toast */ } finally { setCreateConfigSubmitting(false) }
  }
  // 添加预置：按预填 name/model/base_url/endpoint 直接创建（api_key 留空），成功后刷新并选中新配置
  const handleCreatePresetConfig = async (preset: ModelPreset) => {
    if (presetCreating) return
    setPresetCreating(preset.name)
    try {
      const { data } = await adminAPI.createModelConfig({
        category: modelCat,
        name: preset.name,
        provider: MODEL_PROVIDERS[modelCat][0]?.value || '',
        base_url: preset.base_url,
        endpoint: preset.endpoint || '',
        model_id: preset.model,
        model_name: preset.model,
      })
      const saved = data as ModelConfigItem
      await loadModelConfigs(modelCat, saved.id)
      notify.success(`预置「${saved.name}」已创建，请填写 API Key 后保存启用`)
    } catch { /* 拦截器已 toast */ } finally { setPresetCreating('') }
  }
  const buildExtraFromDraft = (): Record<string, string> => {
    const extra: Record<string, string> = {}
    if (modelCat === 'kb') extra.knowledge_base_top_k = String(configDraft.knowledge_base_top_k || '5')
    if (modelCat === 'asr') {
      extra.asr_language = configDraft.asr_language
      extra.asr_max_seconds = String(configDraft.asr_max_seconds || '60')
    }
    if (modelCat === 'tts') {
      extra.tts_voice = configDraft.tts_voice
      extra.tts_response_format = configDraft.tts_response_format
    }
    if (modelCat === 'vl') {
      extra.vl_system_prompt = configDraft.vl_system_prompt
      extra.vl_max_images = String(configDraft.vl_max_images || '4')
      extra.vl_max_image_mb = String(configDraft.vl_max_image_mb || '10')
    }
    if (modelCat === 'rerank') extra.rerank_top_n = String(configDraft.rerank_top_n || '5')
    return extra
  }
  const handleSaveConfig = async () => {
    if (!configDraft.name.trim()) { notify.warning('请填写配置名称'); return }
    if (modelCat === 'llm' && !configDraft.model_id && !configDraft.model_name) {
      notify.warning('请选择或填写模型')
      return
    }
    setConfigSaving(true)
    const payload = {
      name: configDraft.name.trim(),
      provider: configDraft.provider,
      base_url: configDraft.base_url,
      endpoint: configDraft.endpoint,
      model_id: configDraft.model_id,
      model_name: configDraft.model_name,
      extra: buildExtraFromDraft(),
    }
    try {
      if (selectedConfigId != null) {
        // api_key 空串 = 不改，传新值 = 覆盖（后端口径）
        await adminAPI.updateModelConfig(selectedConfigId, { ...payload, api_key: configDraft.api_key })
        await loadModelConfigs(modelCat, selectedConfigId)
        notify.success('配置已保存')
      } else {
        const { data } = await adminAPI.createModelConfig({
          ...payload, category: modelCat, api_key: configDraft.api_key || undefined,
        })
        const saved = data as ModelConfigItem
        await loadModelConfigs(modelCat, saved.id)
        notify.success('配置已创建')
      }
    } catch { /* 拦截器已 toast */ } finally { setConfigSaving(false) }
  }
  const handleEnableConfig = async () => {
    if (selectedConfigId == null) { notify.warning('请先保存配置再启用'); return }
    setConfigEnabling(true)
    try {
      const { data } = await adminAPI.enableModelConfig(selectedConfigId)
      const saved = data as ModelConfigItem
      await loadModelConfigs(modelCat, saved.id)
      notify.success(`已启用「${saved.name}」，参数已同步至运行时`)
    } catch { /* 拦截器已 toast */ } finally { setConfigEnabling(false) }
  }
  const handleDeleteConfig = async (c: ModelConfigItem) => {
    const tip = c.enabled
      ? `确定删除配置「${c.name}」吗？该配置当前已启用，删除后此能力将回到关闭状态。`
      : `确定删除配置「${c.name}」吗？此操作不可恢复。`
    if (!(await confirmDialog(tip, '删除配置'))) return
    try {
      await adminAPI.deleteModelConfig(c.id)
      notify.success('配置已删除')
      await loadModelConfigs(modelCat)
    } catch { /* 拦截器已 toast */ }
  }
  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { notify.error('Logo 文件不能超过 2MB'); return }
    setUploadingLogo(true)
    try {
      const { data } = await adminAPI.uploadLogo(file)
      setField('website_logo', (data as { logo_url: string }).logo_url)
      notify.success('Logo 已上传')
    } finally { setUploadingLogo(false) }
  }

  // ===== 多配置表单的获取模型 / 测试连接（用表单当前值，走现有 adminAPI test/model 接口） =====
  const draftHasKey = !!configDraft.api_key || !!selectedConfig?.api_key_configured
  // 获取模型需要真实密钥：密钥不回显，必须在本表单重输后才能拉取
  const canFetchConfigModels = !!configDraft.api_key && !!configDraft.provider &&
    (!NEEDS_BASE_URL.includes(configDraft.provider) || !!configDraft.base_url)
  // 勾选「用 LLM Key 测」时表单可不留密钥：后端借用当前启用 LLM 配置的密钥
  const canTestConfigConnection = (draftHasKey || borrowLlmKey) && (modelCat !== 'llm' || !!(configDraft.model_id || configDraft.model_name))
  // 测试按钮旁的借用开关（默认勾选；各能力测试行共用一份 UI）
  const borrowKeyCheck = (
    <label className="borrow-key-check" title="勾选后测试请求不传表单密钥，借用当前启用 LLM 配置的 API Key 执行测试">
      <input type="checkbox" checked={borrowLlmKey} onChange={(e) => setBorrowLlmKey(e.target.checked)} />
      用 LLM Key 测
    </label>
  )

  const handleConfigFetchModels = async () => {
    if (!canFetchConfigModels) return
    setFetchingModels(true)
    try {
      const { data } = await adminAPI.fetchModels({
        llm_provider: configDraft.provider, llm_api_key: configDraft.api_key,
        llm_base_url: configDraft.base_url || undefined,
      })
      const list = (data as { models: LLMModelOption[] }).models || []
      setModelOptions(list)
      if (list.length && !list.some((m) => m.id === configDraft.model_id)) {
        setDraftField('model_id', list[0].id)
        setDraftField('model_name', list[0].name || list[0].id)
      }
      notify.success(`获取到 ${list.length} 个模型`)
    } catch { /* 拦截器已 toast */ } finally { setFetchingModels(false) }
  }
  const handleConfigTestConnection = async () => {
    if (!canTestConfigConnection) return
    setTesting(true)
    try {
      const { data } = await adminAPI.testConnection({
        llm_provider: configDraft.provider,
        // 勾选「用 LLM Key 测」：api_key 传空 + borrow_llm_key=true，后端借用启用 LLM 配置的密钥；
        // 未勾选时密钥不回显，未重输则传空 + config_id，后端回退用该配置自己存的密钥测试
        llm_api_key: borrowLlmKey ? '' : (configDraft.api_key || ''),
        llm_model_id: configDraft.model_id || undefined,
        llm_model_name: configDraft.model_name || undefined,
        llm_base_url: configDraft.base_url || undefined,
        config_id: selectedConfigId ?? undefined,
        borrow_llm_key: borrowLlmKey || undefined,
      })
      const r = data as { success: boolean; message: string }
      r.success ? notify.success(r.message) : notify.error(r.message)
    } catch { /* 拦截器已 toast */ } finally { setTesting(false) }
  }
  const handleConfigTestWebSearch = async () => {
    if (!configDraft.base_url) { notify.warning('请先填写 Base URL'); return }
    try {
      const { data } = await adminAPI.testWebSearch({
        base_url: configDraft.base_url,
        api_key: borrowLlmKey ? undefined : (configDraft.api_key || undefined),
        model: configDraft.model_id || undefined,
        config_id: selectedConfigId ?? undefined,
        borrow_llm_key: borrowLlmKey || undefined,
      })
      const r = data as { success: boolean; message: string }
      r.success ? notify.success(r.message) : notify.error(r.message)
    } catch { /* noop */ }
  }
  const handleConfigTestKB = async () => {
    if (!configDraft.base_url) { notify.warning('请先填写检索 URL'); return }
    try {
      const { data } = await adminAPI.testKnowledgeBase({
        base_url: configDraft.base_url,
        api_key: borrowLlmKey ? undefined : (configDraft.api_key || undefined),
        top_k: Number(configDraft.knowledge_base_top_k) || 5,
        config_id: selectedConfigId ?? undefined,
        borrow_llm_key: borrowLlmKey || undefined,
      })
      const r = data as { success: boolean; message: string }
      r.success ? notify.success(r.message) : notify.error(r.message)
    } catch { /* noop */ }
  }
  // 向量化连通性：OpenAI 兼容 /embeddings（kb 预置 qwen3.7-text-embedding-flash；实际检索仍由知识库服务提供）
  const handleConfigTestEmbeddings = async () => {
    if (!configDraft.base_url) { notify.warning('请先填写 Base URL'); return }
    if (!configDraft.model_id) { notify.warning('请先填写模型 ID'); return }
    try {
      const { data } = await adminAPI.testEmbeddings({
        base_url: configDraft.base_url,
        api_key: borrowLlmKey ? undefined : (configDraft.api_key || undefined),
        model: configDraft.model_id,
        borrow_llm_key: borrowLlmKey || undefined,
      })
      const r = data as { success: boolean; message: string }
      r.success ? notify.success(r.message) : notify.error(r.message)
    } catch { /* noop */ }
  }
  const handleConfigTestIntegration = async (key: 'asr' | 'tts' | 'vl' | 'rerank') => {
    try {
      const { data } = await adminAPI.testIntegration(key, {
        base_url: configDraft.base_url, endpoint: configDraft.endpoint || undefined,
        api_key: borrowLlmKey ? undefined : (configDraft.api_key || undefined), model: configDraft.model_id || undefined,
        config_id: selectedConfigId ?? undefined,
        borrow_llm_key: borrowLlmKey || undefined,
      })
      const r = data as { success: boolean; message: string }
      r.success ? notify.success(r.message) : notify.error(r.message)
    } catch { /* noop */ }
  }
  const handleTestStorage = async () => {
    if (!settings?.medical_storage_root) { notify.warning('请先填写私有目录'); return }
    try {
      const { data } = await adminAPI.testIntegration('storage', { base_url: settings.medical_storage_root })
      const r = data as { success: boolean; message: string }
      r.success ? notify.success(r.message) : notify.error(r.message)
    } catch { /* noop */ }
  }

  // ===== 系统设置 · 外部知识源区块：独立指南库服务（端口 8900）的三项配置 + 服务检测 =====
  // 配置键不走 /api/admin/settings（AdminSettingsUpdate 为封闭 schema），
  // 由后端 /api/admin/external-kb/* 专口读写；保存仍随下方「保存设置」一并提交。
  interface ExternalKbSettings { enabled: string; url: string; top_k: number }
  interface ExternalKbStats {
    reachable: boolean
    documents?: number | null
    blocks?: number | null
    caj_skipped?: number | null
    indexed_at?: string | null
    error?: string
  }
  const [externalKb, setExternalKb] = useState<ExternalKbSettings>({ enabled: 'false', url: '', top_k: 4 })
  const [externalKbStats, setExternalKbStats] = useState<ExternalKbStats | null>(null)
  const [checkingExternalKb, setCheckingExternalKb] = useState(false)

  const applyExternalKbPayload = (data: Partial<ExternalKbSettings>) => {
    setExternalKb({
      enabled: data.enabled === 'true' ? 'true' : 'false',
      url: String(data.url || ''),
      top_k: Number(data.top_k) || 4,
    })
  }
  useEffect(() => {
    let cancelled = false
    api.get('/api/admin/external-kb/settings').then(({ data }) => {
      if (!cancelled) applyExternalKbPayload((data ?? {}) as Partial<ExternalKbSettings>)
    }).catch(() => { /* noop：保持缺省 false / 占位地址 / 4 条 */ })
    return () => { cancelled = true }
  }, [])
  // 检测服务：走后端代理转发独立服务 /stats（8s 超时），url 传表单当前值（未保存也可检测）
  const handleCheckExternalKb = async () => {
    setCheckingExternalKb(true)
    try {
      const { data } = await api.get('/api/admin/external-kb/stats', { params: { url: externalKb.url.trim() || undefined } })
      setExternalKbStats(data as ExternalKbStats)
    } catch { /* noop */ } finally { setCheckingExternalKb(false) }
  }
  const persistExternalKb = async () => {
    try {
      const { data } = await api.put('/api/admin/external-kb/settings', {
        enabled: externalKb.enabled,
        url: externalKb.url.trim(),
        top_k: Number(externalKb.top_k) || 4,
      })
      applyExternalKbPayload((data ?? {}) as Partial<ExternalKbSettings>)
    } catch { /* 拦截器已 toast 后端 detail */ }
  }

  const submitSettings = async () => {
    if (!settings) return
    if (!settings.llm_model_id && !settings.llm_model_name) {
      notify.warning('请选择或填写模型')
      return
    }
    setSaving(true)
    const payload: AdminSettingsUpdatePayload = {
      website_name: settings.website_name,
      website_logo: settings.website_logo,
      system_prompt: settings.system_prompt,
      llm_provider: settings.llm_provider,
      llm_base_url: settings.llm_base_url,
      llm_api_key: settings.llm_api_key,
      llm_model_id: settings.llm_model_id,
      llm_model_name: settings.llm_model_name,
      large_font_scale: settings.large_font_scale,
      extra_large_font_scale: settings.extra_large_font_scale,
      web_search_enabled: settings.web_search_enabled,
      web_search_base_url: settings.web_search_base_url,
      web_search_api_key: settings.web_search_api_key,
      knowledge_base_enabled: settings.knowledge_base_enabled,
      knowledge_base_url: settings.knowledge_base_url,
      knowledge_base_api_key: settings.knowledge_base_api_key,
      knowledge_base_top_k: String(settings.knowledge_base_top_k || '5'),
      asr_enabled: settings.asr_enabled, asr_base_url: settings.asr_base_url, asr_endpoint: settings.asr_endpoint,
      asr_api_key: settings.asr_api_key, asr_model: settings.asr_model, asr_language: settings.asr_language,
      asr_max_seconds: String(settings.asr_max_seconds || '60'),
      tts_enabled: settings.tts_enabled, tts_base_url: settings.tts_base_url, tts_endpoint: settings.tts_endpoint,
      tts_api_key: settings.tts_api_key, tts_model: settings.tts_model, tts_voice: settings.tts_voice, tts_response_format: settings.tts_response_format,
      vl_enabled: settings.vl_enabled, vl_base_url: settings.vl_base_url, vl_endpoint: settings.vl_endpoint,
      vl_api_key: settings.vl_api_key, vl_model: settings.vl_model, vl_system_prompt: settings.vl_system_prompt,
      vl_max_images: String(settings.vl_max_images || '4'), vl_max_image_mb: String(settings.vl_max_image_mb || '10'),
      rerank_enabled: settings.rerank_enabled, rerank_base_url: settings.rerank_base_url, rerank_endpoint: settings.rerank_endpoint,
      rerank_api_key: settings.rerank_api_key, rerank_model: settings.rerank_model, rerank_top_n: String(settings.rerank_top_n || '5'),
      medical_storage_root: settings.medical_storage_root,
      captcha_enabled: settings.captcha_enabled,
      suggested_questions_enabled: settings.suggested_questions_enabled,
      suggested_questions_provider: settings.suggested_questions_provider,
      suggested_questions_base_url: settings.suggested_questions_base_url,
      suggested_questions_api_key: settings.suggested_questions_api_key,
      suggested_questions_model_id: settings.suggested_questions_model_id,
      suggested_questions_system_prompt: settings.suggested_questions_system_prompt,
      suggested_questions_count: String(settings.suggested_questions_count || '3'),
      suggested_questions_max_rounds: String(settings.suggested_questions_max_rounds || '5'),
      suggested_questions_template_questions: settings.suggested_questions_template_questions,
    }
    try {
      const { data } = await adminAPI.updateSettings(payload)
      setSettings(data)
      notify.success('设置已保存')
    } finally { setSaving(false) }
  }

  // 「保存设置」按钮入口：现有 submitSettings 之外，随保存一并持久化外部知识源三项配置
  const submitSettingsWithExternalKb = async () => {
    await submitSettings()
    await persistExternalKb()
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div>
          <span className="page-kicker"><MaterialIcon name="admin_panel_settings" size={18} />管理平台</span>
          <h1>管理平台</h1>
        </div>
        <button type="button" className="mini-btn" onClick={() => navigate('/chat')}>
          <MaterialIcon name="arrow_back" size={16} />返回应用
        </button>
      </header>

        <Tabs value={tab} onValueChange={(v: string) => setTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="profiles"><MaterialIcon name="folder_shared" size={16} />全站档案管理</TabsTrigger>
          <TabsTrigger value="users"><MaterialIcon name="group" size={16} />用户管理</TabsTrigger>
          <TabsTrigger value="conversations"><MaterialIcon name="forum" size={16} />会话管理</TabsTrigger>
          <TabsTrigger value="settings"><MaterialIcon name="settings" size={16} />系统设置</TabsTrigger>
          <TabsTrigger value="models"><MaterialIcon name="smart_toy" size={16} />模型设置</TabsTrigger>
        </TabsList>

        {/* ===== 全站档案管理 ===== */}
        <TabsContent value="profiles">
          <section className="panel">
            <div className="panel-head">
              <h2>全站患者档案</h2>
              <button type="button" className="mini-btn" onClick={loadProfiles}>
                <MaterialIcon name="refresh" size={16} />刷新
              </button>
            </div>
            <div className="table-scroll table-profiles">
            <table className="data-table">
              <thead>
                {profileTable.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => (
                      <th key={h.id} style={{ width: h.getSize() !== 150 ? h.getSize() : undefined }}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {profileTable.getRowModel().rows.map((row) => (
                  <tr key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {profiles.length === 0 && <div className="empty-tip">暂无档案数据</div>}
          </section>
        </TabsContent>

        {/* ===== 用户管理 ===== */}
        <TabsContent value="users">
          <section className="panel">
            <div className="panel-head">
              <h2>用户列表</h2>
              <div className="row-actions">
                <button type="button" className="mini-btn" onClick={openCreateUser}>
                  <MaterialIcon name="person_add" size={16} />新增用户
                </button>
                <button type="button" className="mini-btn" onClick={loadUsers}>
                  <MaterialIcon name="refresh" size={16} />刷新
                </button>
              </div>
            </div>
            <div className="table-scroll table-users">
            <table className="data-table">
              <thead>
                {userTable.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => (
                      <th key={h.id} style={{ width: h.getSize() !== 150 ? h.getSize() : undefined }}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {userTable.getRowModel().rows.length === 0 ? (
                  <tr><td colSpan={userColumns.length} className="empty-row">暂无数据</td></tr>
                ) : (
                  userTable.getRowModel().rows.map((row) => (
                    <tr key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
          </section>
        </TabsContent>

        {/* ===== 会话管理 ===== */}
        <TabsContent value="conversations">
          <section className="panel">
            <div className="panel-head">
              <h2>全部会话</h2>
              <button type="button" className="mini-btn" onClick={loadConversations}>
                <MaterialIcon name="refresh" size={16} />刷新
              </button>
            </div>
            <div className="table-scroll table-convs">
            <table className="data-table">
              <thead>
                {convTable.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => (
                      <th key={h.id} style={{ width: h.getSize() !== 150 ? h.getSize() : undefined }}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {convTable.getRowModel().rows.length === 0 ? (
                  <tr><td colSpan={convColumns.length} className="empty-row">暂无数据</td></tr>
                ) : (
                  convTable.getRowModel().rows.map((row) => (
                    <tr key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
          </section>
        </TabsContent>

        {/* ===== 模型设置（一级分类 / 二级配置列表 / 三级配置表单；每能力多条配置，同类别只开一个） ===== */}
        <TabsContent value="models">
          <section className="panel models-panel">
            <div className="models-layout">
              {/* 一级：能力分类 */}
              <nav className="models-cats">
                {MODEL_CATEGORIES.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={`models-cat${modelCat === c.key ? ' on' : ''}`}
                    onClick={() => setModelCat(c.key)}
                  >
                    <MaterialIcon name={c.icon} size={18} />
                    {c.label}
                  </button>
                ))}
              </nav>

              {/* 二级：配置列表（配置名+启用状态点，点击选中；hover 删除；顶部新增） */}
              <div className="models-configs">
                <div className="models-configs-head">
                  <span>配置列表</span>
                  <button type="button" className="mini-btn" onClick={openCreateConfig}>
                    <MaterialIcon name="add" size={16} />新增配置
                  </button>
                </div>
                {(MODEL_PRESETS[modelCat] || []).length > 0 && (
                  <div className="models-presets">
                    <span className="models-presets-label">添加预置</span>
                    {(MODEL_PRESETS[modelCat] || []).map((p) => (
                      <button
                        key={p.name}
                        type="button"
                        className="mini-btn models-preset-btn"
                        disabled={!!presetCreating}
                        title={`按预置参数创建「${p.name}」（${p.model}），创建后填写 API Key 即可`}
                        onClick={() => void handleCreatePresetConfig(p)}
                      >
                        <MaterialIcon name="auto_awesome" size={14} />
                        {presetCreating === p.name ? '创建中…' : p.name}
                      </button>
                    ))}
                  </div>
                )}
                <div className="models-config-list">
                  {configsLoading && <div className="empty-tip">加载中…</div>}
                  {!configsLoading && modelConfigs.length === 0 && (
                    <div className="empty-tip">暂无配置，点击「新增配置」创建</div>
                  )}
                  {modelConfigs.map((c) => (
                    <div
                      key={c.id}
                      role="button"
                      tabIndex={0}
                      className={`models-config-item${selectedConfigId === c.id ? ' on' : ''}`}
                      onClick={() => selectModelConfig(c)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectModelConfig(c) }}
                    >
                      <span className={`models-dot${c.enabled ? ' on' : ''}`} />
                      <span className="models-config-name" title={c.name}>{c.name}</span>
                      {c.enabled && <span className="models-config-live">使用中</span>}
                      <button
                        type="button"
                        className="models-config-del"
                        title="删除配置"
                        aria-label={`删除配置 ${c.name}`}
                        onClick={(e) => { e.stopPropagation(); void handleDeleteConfig(c) }}
                      >
                        <MaterialIcon name="delete" size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* 三级：配置表单（绑定选中配置对象；保存走 POST/PUT，启用走 enable 接口） */}
              <div className="models-config">
                <div className="models-config-head">
                  <MaterialIcon name={MODEL_CATEGORIES.find((c) => c.key === modelCat)?.icon || 'smart_toy'} size={20} />
                  <strong>{selectedConfig ? selectedConfig.name : '新配置'}</strong>
                  <span className={`tag ${selectedConfig?.enabled ? 'tag-success' : 'tag-muted'}`}>
                    {selectedConfig?.enabled ? '使用中' : selectedConfig ? '未启用' : '未保存'}
                  </span>
                  <button
                    type="button"
                    className="mini-btn models-enable-btn"
                    disabled={selectedConfigId == null || configEnabling}
                    onClick={handleEnableConfig}
                  >
                    <MaterialIcon name="power_settings_new" size={16} />
                    {configEnabling ? '启用中…' : '启用此配置'}
                  </button>
                </div>
                <div className="form-grid">
                  <label className="form-field">
                    <span>配置名称 *</span>
                    <input value={configDraft.name} placeholder="如「DeepSeek 主力」" onChange={(e) => setDraftField('name', e.target.value)} />
                  </label>
                  <label className="form-field">
                    <span>提供商</span>
                    {modelCat === 'llm' ? (
                      <select value={configDraft.provider} onChange={(e) => handleDraftProviderChange(e.target.value)}>
                        {LLM_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    ) : (
                      <select value={configDraft.provider || MODEL_PROVIDERS[modelCat][0]?.value || ''} onChange={(e) => setDraftField('provider', e.target.value)}>
                        {MODEL_PROVIDERS[modelCat].map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    )}
                  </label>
                  <label className="form-field">
                    <span>Base URL{modelCat === 'llm' && NEEDS_BASE_URL.includes(configDraft.provider) ? ' *' : ''}</span>
                    <input value={configDraft.base_url} placeholder={modelCat === 'llm' ? '例如 https://api.deepseek.com/v1' : ''} onChange={(e) => setDraftField('base_url', e.target.value)} />
                  </label>
                  {(modelCat === 'asr' || modelCat === 'tts' || modelCat === 'vl' || modelCat === 'rerank') && (
                    <label className="form-field">
                      <span>Endpoint</span>
                      <input value={configDraft.endpoint} placeholder={DEFAULT_ENDPOINTS[modelCat]} onChange={(e) => setDraftField('endpoint', e.target.value)} />
                    </label>
                  )}
                  <label className="form-field">
                    <span>API Key{selectedConfig?.api_key_configured ? '' : ' *'}</span>
                    <input
                      type="password"
                      value={configDraft.api_key}
                      placeholder={selectedConfig?.api_key_configured ? '已配置（输入新值覆盖）' : ''}
                      autoComplete="new-password"
                      onChange={(e) => setDraftField('api_key', e.target.value)}
                    />
                  </label>
                  {modelCat === 'llm' && (
                    <div className="form-field">
                      <span>&nbsp;</span>
                      <div className="btn-row">
                        <button
                          type="button" className="mini-btn"
                          disabled={!canFetchConfigModels || fetchingModels}
                          title={!configDraft.api_key ? '密钥不回显，在本表单重输 API Key 后可获取模型列表' : undefined}
                          onClick={handleConfigFetchModels}
                        >
                          <MaterialIcon name="cloud_download" size={16} />{fetchingModels ? '获取中…' : '获取模型'}
                        </button>
                        <button type="button" className="mini-btn" disabled={!canTestConfigConnection || testing} onClick={handleConfigTestConnection}>
                          <MaterialIcon name="network_check" size={16} />测试连接
                        </button>
                        {borrowKeyCheck}
                      </div>
                    </div>
                  )}
                  <label className="form-field">
                    <span>模型 ID</span>
                    {modelCat === 'llm' ? (
                      <select value={configDraft.model_id} onChange={(e) => {
                        const m = modelOptions.find((o) => o.id === e.target.value)
                        setDraftField('model_id', e.target.value)
                        setDraftField('model_name', m?.name || e.target.value)
                      }}>
                        {!modelOptions.some((m) => m.id === configDraft.model_id) && configDraft.model_id && (
                          <option value={configDraft.model_id}>{configDraft.model_name || configDraft.model_id}</option>
                        )}
                        {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                      </select>
                    ) : (
                      <input value={configDraft.model_id} onChange={(e) => setDraftField('model_id', e.target.value)} />
                    )}
                  </label>
                  <label className="form-field">
                    <span>模型名称</span>
                    <input value={configDraft.model_name} onChange={(e) => setDraftField('model_name', e.target.value)} />
                  </label>
                  {modelCat === 'search' && (
                    <div className="form-field">
                      <span>&nbsp;</span>
                      <div className="btn-row">
                        <button type="button" className="mini-btn" onClick={handleConfigTestWebSearch}>
                          <MaterialIcon name="network_check" size={16} />测试网络搜索
                        </button>
                        {borrowKeyCheck}
                      </div>
                    </div>
                  )}
                  {modelCat === 'kb' && (
                    <>
                      <label className="form-field">
                        <span>返回条数</span>
                        <input type="number" min={1} max={20} value={configDraft.knowledge_base_top_k} onChange={(e) => setDraftField('knowledge_base_top_k', e.target.value)} />
                      </label>
                      <div className="form-field">
                        <span>&nbsp;</span>
                        <div className="btn-row">
                          <button type="button" className="mini-btn" onClick={handleConfigTestKB}>
                            <MaterialIcon name="network_check" size={16} />测试知识库
                          </button>
                          <button type="button" className="mini-btn" onClick={handleConfigTestEmbeddings}>
                            <MaterialIcon name="network_check" size={16} />测试向量化
                          </button>
                          {borrowKeyCheck}
                        </div>
                      </div>
                      <p className="form-hint form-hint-wide">
                        向量化模型用 qwen3.7-text-embedding-flash 测试连通；实际检索仍由知识库服务 URL 提供。
                      </p>
                    </>
                  )}
                  {modelCat === 'asr' && (
                    <>
                      <label className="form-field">
                        <span>语言</span>
                        <input value={configDraft.asr_language} onChange={(e) => setDraftField('asr_language', e.target.value)} />
                      </label>
                      <label className="form-field">
                        <span>最长录音秒数</span>
                        <input type="number" min={5} max={300} value={configDraft.asr_max_seconds} onChange={(e) => setDraftField('asr_max_seconds', e.target.value)} />
                      </label>
                    </>
                  )}
                  {modelCat === 'tts' && (
                    <>
                      <label className="form-field">
                        <span>声音</span>
                        <input value={configDraft.tts_voice} onChange={(e) => setDraftField('tts_voice', e.target.value)} />
                      </label>
                      <label className="form-field">
                        <span>音频格式</span>
                        <select value={configDraft.tts_response_format} onChange={(e) => setDraftField('tts_response_format', e.target.value)}>
                          <option value="mp3">MP3</option><option value="wav">WAV</option><option value="opus">Opus</option>
                        </select>
                      </label>
                    </>
                  )}
                  {modelCat === 'vl' && (
                    <>
                      <label className="form-field wide">
                        <span>系统提示词</span>
                        <textarea rows={3} value={configDraft.vl_system_prompt} onChange={(e) => setDraftField('vl_system_prompt', e.target.value)} />
                      </label>
                      <label className="form-field">
                        <span>每条最多图片</span>
                        <input type="number" min={1} max={8} value={configDraft.vl_max_images} onChange={(e) => setDraftField('vl_max_images', e.target.value)} />
                      </label>
                      <label className="form-field">
                        <span>单图 MB</span>
                        <input type="number" min={1} max={50} value={configDraft.vl_max_image_mb} onChange={(e) => setDraftField('vl_max_image_mb', e.target.value)} />
                      </label>
                    </>
                  )}
                  {modelCat === 'rerank' && (
                    <label className="form-field">
                      <span>保留条数</span>
                      <input type="number" min={1} max={20} value={configDraft.rerank_top_n} onChange={(e) => setDraftField('rerank_top_n', e.target.value)} />
                    </label>
                  )}
                  {(modelCat === 'asr' || modelCat === 'tts' || modelCat === 'vl' || modelCat === 'rerank') && (
                    <div className="form-field">
                      <span>&nbsp;</span>
                      <div className="btn-row">
                        <button type="button" className="mini-btn" onClick={() => handleConfigTestIntegration(modelCat)}>
                          <MaterialIcon name="network_check" size={16} />测试连接
                        </button>
                        {borrowKeyCheck}
                      </div>
                    </div>
                  )}
                </div>

                <div className="save-bar">
                  <p className="models-save-hint">保存后可「启用此配置」：同类别仅一条生效，启用时参数同步到运行时</p>
                  <button type="button" className="primary-btn" disabled={configSaving} onClick={handleSaveConfig}>
                    <MaterialIcon name="save" size={18} />{configSaving ? '保存中…' : (selectedConfigId == null ? '创建配置' : '保存配置')}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="settings">
          {settings ? (
            <section className="panel settings-panel">
              {/* A. 基础设置 */}
              <h2 className="section-divider">基础设置</h2>
              <div className="form-grid">
                <label className="form-field">
                  <span>站点名称 *</span>
                  <input value={settings.website_name} onChange={(e) => setField('website_name', e.target.value)} />
                </label>
                <label className="form-field">
                  <span>站点 Logo</span>
                  <div className="logo-row">
                    {settings.website_logo && <img src={settings.website_logo} alt="logo" className="logo-preview" />}
                    <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/jpg,image/gif,image/svg+xml,image/webp" className="visually-hidden" onChange={handleLogoChange} />
                    <button type="button" className="mini-btn" disabled={uploadingLogo} onClick={() => logoInputRef.current?.click()}>
                      <MaterialIcon name="upload" size={16} />{uploadingLogo ? '上传中…' : '上传 Logo'}
                    </button>
                  </div>
                </label>
                <label className="form-field wide">
                  <span>系统提示词 *</span>
                  <textarea rows={4} value={settings.system_prompt} onChange={(e) => setField('system_prompt', e.target.value)} />
                </label>
                <label className="form-field">
                  <span>大字放大倍率</span>
                  <input type="number" min={1.2} max={3.0} step={0.1} value={settings.large_font_scale}
                    onChange={(e) => setField('large_font_scale', Number(e.target.value))} />
                </label>
                <label className="form-field">
                  <span>超大字放大倍率</span>
                  <input type="number" min={1.5} max={3.0} step={0.05} value={settings.extra_large_font_scale}
                    onChange={(e) => setField('extra_large_font_scale', Number(e.target.value))} />
                </label>
                <label className="form-field">
                  <span>登录滑块验证码</span>
                  {/* 开启后登录页必须先通过滑块验证才能提交（后端 /api/auth/token 同步强校验） */}
                  <select value={settings.captcha_enabled} onChange={(e) => setField('captcha_enabled', e.target.value)}>
                    <option value="false">关闭</option><option value="true">开启</option>
                  </select>
                </label>
              </div>

              {/* F. 医学图片存储 */}
              <h2 className="section-divider">医学图片私有存储</h2>
              <div className="form-grid">
                <label className="form-field"><span>私有目录</span>
                  <input value={settings.medical_storage_root} onChange={(e) => setField('medical_storage_root', e.target.value)} placeholder="D:\\medical-private-storage" />
                </label>
                <div className="form-field">
                  <span>&nbsp;</span>
                  <button type="button" className="mini-btn" onClick={handleTestStorage}><MaterialIcon name="folder_open" size={16} />测试目录</button>
                </div>
              </div>

              {/* F2. 外部知识源：独立指南库服务（与知识库检索并列的证据来源） */}
              <h2 className="section-divider">权威医学库（外部知识源）</h2>
              <div className="form-grid">
                <label className="form-field">
                  <span>启用权威医学库</span>
                  <select value={externalKb.enabled} onChange={(e) => setExternalKb((prev) => ({ ...prev, enabled: e.target.value }))}>
                    <option value="false">关闭</option><option value="true">开启</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>服务地址</span>
                  <input value={externalKb.url} placeholder="http://127.0.0.1:8900"
                    onChange={(e) => setExternalKb((prev) => ({ ...prev, url: e.target.value }))} />
                </label>
                <label className="form-field">
                  <span>检索条数</span>
                  <input type="number" min={1} max={10} value={externalKb.top_k}
                    onChange={(e) => setExternalKb((prev) => ({ ...prev, top_k: Number(e.target.value) || 1 }))} />
                </label>
                <div className="form-field">
                  <span>&nbsp;</span>
                  <div className="btn-row">
                    <button type="button" className="mini-btn" disabled={checkingExternalKb} onClick={handleCheckExternalKb}>
                      <MaterialIcon name="network_check" size={16} />{checkingExternalKb ? '检测中…' : '检测服务'}
                    </button>
                  </div>
                </div>
              </div>
              <p className="form-hint">
                {externalKbStats
                  ? (externalKbStats.reachable
                    ? `服务可达：文档 ${externalKbStats.documents ?? '--'} 篇 · 索引块 ${externalKbStats.blocks ?? '--'} · CAJ 跳过 ${externalKbStats.caj_skipped ?? '--'} · 索引时间 ${externalKbStats.indexed_at || '--'}`
                    : `服务不可达：${externalKbStats.error || '请确认独立服务已启动'}（用独立服务目录的 start.cmd 启动，默认端口 8900）`)
                  : '数据源目录 本地语料目录（126 PDF + 109 CAJ，CAJ 待转换）；独立服务需先启动（start.cmd，端口 8900）。修改后点下方「保存设置」生效。'}
              </p>

              {/* G. 推荐问题 */}
              <h2 className="section-divider">推荐问题配置 / 猜你想问</h2>
              <div className="form-grid">
                <label className="form-field">
                  <span>启用推荐问题</span>
                  <select value={settings.suggested_questions_enabled} onChange={(e) => setField('suggested_questions_enabled', e.target.value)}>
                    <option value="false">关闭</option><option value="true">开启</option>
                  </select>
                </label>
              </div>
              {settings.suggested_questions_enabled === 'true' && (
                <div className="form-grid">
                  <label className="form-field"><span>推荐数量</span>
                    <input type="number" min={1} max={10} value={settings.suggested_questions_count} onChange={(e) => setField('suggested_questions_count', e.target.value)} />
                  </label>
                  <label className="form-field"><span>最大轮数</span>
                    <input type="number" min={1} max={20} value={settings.suggested_questions_max_rounds} onChange={(e) => setField('suggested_questions_max_rounds', e.target.value)} />
                  </label>
                  <label className="form-field"><span>LLM 供应商</span>
                    <select value={settings.suggested_questions_provider} onChange={(e) => setField('suggested_questions_provider', e.target.value)}>
                      <option value="">使用主配置</option>
                      {SUGGESTED_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </label>
                  <label className="form-field"><span>Base URL</span>
                    <input value={settings.suggested_questions_base_url} onChange={(e) => setField('suggested_questions_base_url', e.target.value)} />
                  </label>
                  <label className="form-field"><span>API Key</span>
                    <input type="password" value={settings.suggested_questions_api_key} onChange={(e) => setField('suggested_questions_api_key', e.target.value)} />
                  </label>
                  <label className="form-field"><span>模型 ID</span>
                    <input value={settings.suggested_questions_model_id} onChange={(e) => setField('suggested_questions_model_id', e.target.value)} />
                  </label>
                  <label className="form-field wide"><span>系统提示词</span>
                    <textarea rows={6} value={settings.suggested_questions_system_prompt} onChange={(e) => setField('suggested_questions_system_prompt', e.target.value)} />
                  </label>
                  <label className="form-field wide"><span>模板问题（降级方案，JSON 数组）</span>
                    <textarea rows={4} value={settings.suggested_questions_template_questions} onChange={(e) => setField('suggested_questions_template_questions', e.target.value)} />
                  </label>
                </div>
              )}

              <div className="save-bar">
                <button type="button" className="primary-btn" disabled={saving} onClick={submitSettingsWithExternalKb}>
                  <MaterialIcon name="save" size={18} />{saving ? '保存中…' : '保存设置'}
                </button>
              </div>
            </section>
          ) : (
            <section className="panel"><div className="empty-row">设置加载中…</div></section>
          )}
        </TabsContent>
      </Tabs>

      {/* 会话消息查看对话框 */}
      <Dialog open={messagesOpen} onOpenChange={setMessagesOpen}>
        <DialogContent style={{ maxWidth: 'min(720px, 94vw)' }}>
          <DialogHeader>
            <DialogTitle>会话消息 · {selectedConvTitle}</DialogTitle>
            <DialogDescription>查看此会话的全部消息</DialogDescription>
          </DialogHeader>
          {messagesLoading ? (
            <div className="dialog-loading-inline">加载中…</div>
          ) : convMessages.length === 0 ? (
            <div className="empty-row">暂无消息</div>
          ) : (
            <ol className="msg-timeline">
              {convMessages.map((m) => (
                <li key={m.id} className={`msg-item ${m.role}`}>
                  <div className="msg-dot"><MaterialIcon name={m.role === 'assistant' ? 'smart_toy' : 'person'} size={16} /></div>
                  <div className="msg-body">
                    <div className="msg-meta">
                      <strong>{m.role === 'assistant' ? '橘泉智养助手' : '用户'}</strong>
                      <span>{formatDateTime(m.created_at)}</span>
                    </div>
                    {m.role === 'assistant'
                      ? <MarkdownRenderer content={m.content} />
                      : <p className="plain-text">{m.content}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>

      {/* 新增模型配置对话框 */}
      <Dialog open={createConfigOpen} onOpenChange={setCreateConfigOpen}>
        <DialogContent style={{ maxWidth: 'min(420px, 94vw)' }}>
          <DialogHeader>
            <DialogTitle>新增{MODEL_CATEGORIES.find((c) => c.key === modelCat)?.label || ''}配置</DialogTitle>
            <DialogDescription>为当前能力新增一条模型配置，创建后完善参数并保存</DialogDescription>
          </DialogHeader>
          <label className="form-field">
            <span>配置名称 *</span>
            <input value={newConfigName} placeholder="如「DeepSeek 主力」" autoComplete="off"
              onChange={(e) => setNewConfigName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateConfig() }} />
          </label>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="mini-btn" disabled={createConfigSubmitting} onClick={() => setCreateConfigOpen(false)}>取消</button>
            <button type="button" className="primary-btn" disabled={createConfigSubmitting} onClick={handleCreateConfig}>
              <MaterialIcon name="add" size={18} />{createConfigSubmitting ? '创建中…' : '创建配置'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 新增用户对话框 */}
      <Dialog open={createUserOpen} onOpenChange={setCreateUserOpen}>
        <DialogContent style={{ maxWidth: 'min(460px, 94vw)' }}>
          <DialogHeader>
            <DialogTitle>新增用户</DialogTitle>
            <DialogDescription>由管理员创建普通用户账号</DialogDescription>
          </DialogHeader>
          <label className="form-field">
            <span>用户名 *</span>
            <input value={newUsername} autoComplete="off" placeholder="3-50 个字符"
              onChange={(e) => setNewUsername(e.target.value)} />
          </label>
          <label className="form-field">
            <span>密码 *</span>
            <input type="password" value={newPassword} autoComplete="new-password" placeholder="至少 12 位"
              onChange={(e) => setNewPassword(e.target.value)} />
          </label>
          <label className="form-field">
            <span>确认密码 *</span>
            <input type="password" value={newPasswordConfirm} autoComplete="new-password"
              onChange={(e) => setNewPasswordConfirm(e.target.value)} />
          </label>
          <p className="form-hint">密码至少 12 位，需同时包含大写字母、小写字母、数字和特殊符号</p>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="mini-btn" disabled={createUserSubmitting} onClick={() => setCreateUserOpen(false)}>取消</button>
            <button type="button" className="primary-btn" disabled={createUserSubmitting} onClick={handleCreateUser}>
              <MaterialIcon name="person_add" size={18} />{createUserSubmitting ? '创建中…' : '创建用户'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 用户每日额度对话框（用户管理 tab） */}
      <Dialog open={quotaEditorOpen} onOpenChange={setQuotaEditorOpen}>
        <DialogContent style={{ maxWidth: 'min(460px, 94vw)' }}>
          <DialogHeader>
            <DialogTitle>每日额度</DialogTitle>
            <DialogDescription>
              {quotaUser ? `为用户「${quotaUser.username}」设置单人每日额度覆盖` : '单人每日额度覆盖'}
            </DialogDescription>
          </DialogHeader>
          {quotaUser?.today_usage && (
            <p className="form-hint">
              今日已用：token {quotaUser.today_usage.tokens} · 图片 {quotaUser.today_usage.images} · 网络搜索 {quotaUser.today_usage.web_searches}
            </p>
          )}
          <label className="form-field">
            <span>Token / 天</span>
            <input value={quotaTokens} inputMode="numeric" autoComplete="off" placeholder="留空=跟随全局"
              onChange={(e) => setQuotaTokens(e.target.value)} />
          </label>
          <label className="form-field">
            <span>图片 / 天</span>
            <input value={quotaImages} inputMode="numeric" autoComplete="off" placeholder="留空=跟随全局"
              onChange={(e) => setQuotaImages(e.target.value)} />
          </label>
          <label className="form-field">
            <span>网络搜索 / 天</span>
            <input value={quotaWebSearches} inputMode="numeric" autoComplete="off" placeholder="留空=跟随全局"
              onChange={(e) => setQuotaWebSearches(e.target.value)} />
          </label>
          <p className="form-hint">留空 = 跟随全局默认；填 -1 = 不限；填正整数 = 单人每日上限。三项都留空即恢复跟随全局。</p>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="mini-btn" disabled={quotaSaving} onClick={() => setQuotaEditorOpen(false)}>取消</button>
            <button type="button" className="primary-btn" disabled={quotaSaving} onClick={handleSaveQuota}>
              <MaterialIcon name="save" size={18} />{quotaSaving ? '保存中…' : '保存'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <BackendStatus />

      <style>{`
        .admin-page{height:100%;overflow:auto;background:var(--color-surfaceMuted,#f7f8f7);padding:30px clamp(20px,5vw,70px);color:var(--color-textPrimary)}
        .admin-header{max-width:1280px;margin:0 auto 18px;display:flex;align-items:center;justify-content:space-between}
        .page-kicker{display:inline-flex;align-items:center;gap:7px;color:var(--color-accent);font-size:12px;font-weight:700}
        .admin-header h1{margin:6px 0 0;font-size:24px;font-family:var(--font-family-serif)}
        .panel{background:var(--color-surface);border:1px solid var(--color-borderLight);border-radius:14px;padding:20px 24px;margin-top:14px}
        .panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
        .panel-head h2{margin:0;font-size:16px;font-family:var(--font-family-serif)}
        .data-table{width:100%;border-collapse:collapse;font-size:13px}
        .data-table th{padding:10px 12px;text-align:left;color:var(--color-textTertiary);font-size:11px;font-weight:700;border-bottom:1px solid var(--color-borderLight);background:var(--color-bgSecondary)}
        .data-table td{padding:10px 12px;border-bottom:1px solid var(--color-borderLight);color:var(--color-textPrimary);vertical-align:middle}
        .data-table tr:hover td{background:rgba(0,0,0,.02)}
        .empty-row{padding:30px;text-align:center;color:var(--color-textTertiary)}
        .tag{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;line-height:1.7}
        .tag-primary{background:var(--color-accentSoft);color:var(--color-accent)}
        .tag-success{background:color-mix(in srgb,var(--color-success) 14%,transparent);color:var(--color-success)}
        .tag-warning{background:var(--color-surfaceMuted);color:var(--color-warning)}
        .tag-danger{background:rgba(200,60,60,.12);color:var(--color-danger,#c83c3c)}
        .tag-muted{background:var(--color-surfaceMuted);color:var(--color-textTertiary)}
        .row-actions{display:flex;gap:6px}
        .usage-cell{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--color-textSecondary);line-height:1.5;white-space:nowrap}
        .mini-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--color-borderLight);background:var(--color-surface);color:var(--color-textSecondary);border-radius:7px;height:30px;padding:0 10px;font-size:12px;cursor:pointer;font-family:inherit}
        .mini-btn:hover{border-color:var(--color-accent);color:var(--color-accent)}
        .mini-btn:disabled{opacity:.5;cursor:not-allowed}
        .mini-btn.warning{color:var(--color-warning)}
        .mini-btn.danger{color:var(--color-danger,#c83c3c)}
        .mini-btn.success{color:var(--color-success)}

        .settings-panel{display:flex;flex-direction:column;gap:0}
        .section-divider{margin:24px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--color-borderLight);font-size:15px;font-family:var(--font-family-serif);color:var(--color-textPrimary)}
        .section-divider:first-child{margin-top:0}
        .form-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:0 18px}
        .form-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px;font-size:12px;color:var(--color-textSecondary)}
        .form-field.wide{grid-column:1/-1}
        .form-field>span{font-weight:700;color:var(--color-textSecondary)}
        .form-field input,.form-field select,.form-field textarea{height:38px;border:1px solid var(--color-borderPrimary);border-radius:8px;padding:0 12px;font-family:inherit;font-size:13px;color:var(--color-textPrimary);outline:none;background:var(--color-surface)}
        .form-field textarea{height:auto;padding:9px 12px;resize:vertical;line-height:1.6}
        .form-field input:focus,.form-field select:focus,.form-field textarea:focus{border-color:var(--color-accent);box-shadow:0 0 0 2px rgba(0,0,0,.06)}
        .btn-row{display:flex;gap:8px}
        .table-scroll{overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch}
        .admin-page [role="tablist"]{justify-content:flex-start;overflow-x:auto;max-width:100%;scrollbar-width:thin;-webkit-overflow-scrolling:touch}
        .form-hint{margin:-6px 0 12px;font-size:12px;color:var(--color-textTertiary);line-height:1.6}
        .logo-row{display:flex;align-items:center;gap:12px}
        .logo-preview{width:48px;height:48px;object-fit:contain;border:1px solid var(--color-borderLight);border-radius:8px;background:var(--color-surface)}
        .visually-hidden{display:none}

        .integration-block{border:1px solid var(--color-borderLight);border-radius:12px;padding:16px;margin-bottom:16px}
        .integration-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
        .integration-head strong{font-size:14px;color:var(--color-textPrimary)}
        .switch-inline{margin-left:auto;display:inline-flex}
        .switch-inline select{height:30px;border-radius:7px;border:1px solid var(--color-borderPrimary);padding:0 8px;font-size:12px;background:var(--color-surface)}

        .save-bar{display:flex;justify-content:flex-end;padding:18px 0 4px;border-top:1px solid var(--color-borderLight);margin-top:8px}
        .primary-btn{height:42px;border:0;border-radius:10px;background:var(--color-accent);color:var(--color-primary-foreground);padding:0 22px;display:inline-flex;align-items:center;gap:8px;font-weight:700;cursor:pointer;font-family:inherit;font-size:14px}
        .primary-btn:disabled{opacity:.55;cursor:not-allowed}

        .dialog-loading-inline{padding:20px;text-align:center;color:var(--color-textTertiary)}
        .msg-timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px;max-height:60vh;overflow:auto}
        .msg-item{display:grid;grid-template-columns:32px 1fr;gap:10px}
        .msg-dot{width:32px;height:32px;border-radius:8px;display:grid;place-items:center;flex:0 0 32px}
        .msg-item.assistant .msg-dot{background:var(--color-primarySoft);color:var(--color-primary)}
        .msg-item.user .msg-dot{background:var(--color-accentSoft);color:var(--color-accent)}
        .msg-meta{display:flex;align-items:baseline;gap:10px;margin-bottom:5px}
        .msg-meta strong{font-size:12px;color:var(--color-textPrimary)}
        .msg-meta span{font-size:11px;color:var(--color-textTertiary)}
        .plain-text{margin:0;font-size:13px;color:var(--color-textSecondary);line-height:1.7;white-space:pre-wrap}


        /* ===== 模型设置：一级分类 / 二级配置列表 / 三级配置表单 三列 ===== */
        .models-panel{padding:0;overflow:hidden}
        .models-layout{display:grid;grid-template-columns:200px 236px minmax(0,1fr);min-height:560px}
        .models-cats{display:flex;flex-direction:column;gap:2px;padding:14px 10px;border-right:1px solid var(--color-borderLight);background:var(--color-bgSecondary)}
        .models-cat{display:flex;align-items:center;gap:9px;border:0;background:transparent;cursor:pointer;text-align:left;
          padding:10px 11px;border-radius:9px;font-size:13px;color:var(--color-textSecondary);font-family:inherit;
          transition:background .15s var(--ease-smooth,ease),color .15s var(--ease-smooth,ease)}
        .models-cat:hover{background:var(--color-primarySoft);color:var(--color-textPrimary)}
        .models-cat.on{background:var(--color-surface);color:var(--color-textPrimary);font-weight:700;box-shadow:var(--shadow-card,0 1px 3px rgba(0,0,0,.05))}
        .models-cat .material-symbol{color:var(--color-textTertiary)}
        .models-cat.on .material-symbol{color:var(--color-textPrimary)}
        .models-configs{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--color-borderLight)}
        .models-configs-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 12px 10px;
          font-size:12px;font-weight:700;color:var(--color-textTertiary)}
        .models-presets{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:2px 12px 10px;border-bottom:1px solid var(--color-borderLight)}
        .models-presets-label{font-size:11px;font-weight:700;color:var(--color-textTertiary)}
        .models-preset-btn{font-size:11px;height:26px;padding:0 8px;border-radius:6px;color:var(--color-accent);
          border-color:color-mix(in srgb,var(--color-accent) 35%,transparent);background:color-mix(in srgb,var(--color-accent) 7%,var(--color-surface))}
        .borrow-key-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:400;color:var(--color-textSecondary);
          cursor:pointer;user-select:none;white-space:nowrap}
        .borrow-key-check:hover{color:var(--color-textPrimary)}
        .form-field input[type="checkbox"]{width:14px;height:14px;min-width:14px;padding:0;border:1px solid var(--color-borderPrimary);
          border-radius:4px;background:var(--color-surface);accent-color:var(--color-accent);cursor:pointer}
        .form-hint-wide{grid-column:1/-1;margin:0 0 14px}
        .models-config-list{display:flex;flex-direction:column;gap:4px;padding:0 10px 14px;overflow:auto;flex:1}
        .models-config-item{display:flex;align-items:center;gap:9px;padding:10px 11px;border-radius:9px;border:1px solid transparent;
          cursor:pointer;font-size:13px;color:var(--color-textSecondary);background:transparent;font-family:inherit;
          transition:background .15s var(--ease-smooth,ease),color .15s var(--ease-smooth,ease)}
        .models-config-item:hover{background:var(--color-primarySoft);color:var(--color-textPrimary)}
        .models-config-item.on{background:var(--color-surface);color:var(--color-textPrimary);font-weight:700;border-color:var(--color-borderLight);
          box-shadow:var(--shadow-card,0 1px 3px rgba(0,0,0,.05))}
        .models-config-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .models-config-live{flex:0 0 auto;font-size:10px;font-weight:700;color:var(--color-success);
          background:color-mix(in srgb,var(--color-success) 14%,transparent);padding:1px 7px;border-radius:999px}
        .models-config-del{display:none;align-items:center;justify-content:center;width:22px;height:22px;flex:0 0 22px;
          border:0;border-radius:6px;background:transparent;color:var(--color-textTertiary);cursor:pointer;padding:0}
        .models-config-item:hover .models-config-del,.models-config-item.on .models-config-del{display:inline-flex}
        .models-config-del:hover{color:var(--color-danger,#c83c3c);background:color-mix(in srgb,var(--color-danger,#c83c3c) 12%,transparent)}
        .models-dot{width:8px;height:8px;border-radius:9999px;flex:0 0 8px;background:var(--color-borderSecondary);box-shadow:inset 0 0 0 1px var(--color-borderLight)}
        .models-dot.on{background:var(--color-success);box-shadow:none}
        .models-config{padding:18px 20px 8px;min-width:0}
        .models-config .form-grid{margin-bottom:6px}
        .models-config-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;color:var(--color-textPrimary)}
        .models-config-head strong{font-size:14px}
        .models-config-head .material-symbol{color:var(--color-textTertiary)}
        .models-enable-btn{margin-left:auto}
        .models-save-hint{margin:0 auto 0 0;font-size:12px;color:var(--color-textTertiary)}
        .models-config .save-bar{align-items:center}
        @media(max-width:900px){.models-layout{grid-template-columns:1fr;min-height:0}
          .models-cats,.models-configs{border-right:0;border-bottom:1px solid var(--color-borderLight);min-width:0}
          .models-cats{flex-direction:row;flex-wrap:wrap}}
        @media(max-width:760px){.form-grid{grid-template-columns:1fr}.admin-page{padding:18px 12px}}
        /* ===== 窄屏/手机（≤680）：表格隐藏次要列 + 触控目标 ≥44px（≥980 桌面不受影响） ===== */
        @media(max-width:680px){
          /* 面板内边距收窄，给关键列让宽度（models-panel 需保持 0 内边距的贴边三栏/单列布局） */
          .panel:not(.models-panel){padding:16px 14px}
          .data-table th,.data-table td{padding:10px 8px}
          .data-table .row-actions{flex-wrap:wrap}
          .data-table .tag{white-space:nowrap}
          .table-profiles .data-table td:nth-child(2),.table-users .data-table td:nth-child(2),.table-convs .data-table td:nth-child(2){word-break:break-all}
          /* 档案表：仅留 患者姓名(2)/类型(8) */
          .table-profiles .data-table th:nth-child(1),.table-profiles .data-table td:nth-child(1),
          .table-profiles .data-table th:nth-child(3),.table-profiles .data-table td:nth-child(3),
          .table-profiles .data-table th:nth-child(4),.table-profiles .data-table td:nth-child(4),
          .table-profiles .data-table th:nth-child(5),.table-profiles .data-table td:nth-child(5),
          .table-profiles .data-table th:nth-child(6),.table-profiles .data-table td:nth-child(6),
          .table-profiles .data-table th:nth-child(7),.table-profiles .data-table td:nth-child(7),
          .table-profiles .data-table th:nth-child(9),.table-profiles .data-table td:nth-child(9){display:none}
          /* 用户表：仅留 用户名(2)/操作(7)；空态整行 td 带 .empty-row，不隐藏 */
          .table-users .data-table th:nth-child(1),.table-users .data-table td:nth-child(1):not(.empty-row),
          .table-users .data-table th:nth-child(3),.table-users .data-table td:nth-child(3),
          .table-users .data-table th:nth-child(4),.table-users .data-table td:nth-child(4),
          .table-users .data-table th:nth-child(5),.table-users .data-table td:nth-child(5),
          .table-users .data-table th:nth-child(6),.table-users .data-table td:nth-child(6){display:none}
          /* 会话表：仅留 会话标题(2)/操作(6) */
          .table-convs .data-table th:nth-child(1),.table-convs .data-table td:nth-child(1):not(.empty-row),
          .table-convs .data-table th:nth-child(3),.table-convs .data-table td:nth-child(3),
          .table-convs .data-table th:nth-child(4),.table-convs .data-table td:nth-child(4),
          .table-convs .data-table th:nth-child(5),.table-convs .data-table td:nth-child(5){display:none}
          /* 触控目标：行内操作按钮（封禁/额度/删除/查看、新增/刷新）与「启用此配置」≥44px；tab 触发器不压缩可横滑；模型分类按钮加高 */
          .row-actions .mini-btn,.models-enable-btn{height:44px;padding:0 14px}
          .admin-page [role="tab"]{flex:0 0 auto}
          .models-cat{padding:12px 13px}
          /* 模型配置头部：状态标签与启用按钮不逐字换行，配置名占剩余宽度换行 */
          .models-config-head .tag,.models-config-head .models-enable-btn{white-space:nowrap;flex:0 0 auto}
        }
      `}</style>
    </div>
  )
}
