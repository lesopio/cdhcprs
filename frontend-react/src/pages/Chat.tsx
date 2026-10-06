/**
 * 智能问诊页（迁移自 Vue Chat.vue —— 最大一块）
 *
 * 外壳严格照 HTML 的 .chat-workbench：左侧滑入历史 rail + 中央 .conversation-main-pane.chat
 * + 右侧患者档案 Sheet + 分诊编辑 Dialog + 摘要 Dialog。
 * todo A1-A3：欢迎墙（welcome-state）是唯一问诊入口；分诊走对话流内嵌 TriageFlow；
 * AI 主动问诊的逐轮追问走 IntakeStepCard 步骤卡；旧「选择问诊方式」Dialog 已废弃删除。
 *
 * 2026-09 中性单色重塑（docs/ui-spec-v3-monochrome.md，参考 vercel/chatbot 质感）：
 * 欢迎墙 = 居中衬线问候 + 居中 composer（同一 composer 实例二选一挂载）+ 三张中性建议卡
 * （#F7F7F7 底 hairline、hover 白底浮起 shadow-card）；thread 最大宽 740px；用户消息 #EDEDED
 * 气泡右上小角；助手回答去卡片化；操作钮 hover 显现；composer 白底 hairline + composer
 * 阴影聚焦切换、发送键近黑圆形；加载态一律 thinking-dots（无旋转图标）；消息入场 message-in。
 * 状态机 / SSE / 路由 watcher / 动画 reduced-motion 分支等逻辑一律未动，只动样式与展示结构。
 *
 * SSE / intake / recorder / TTS / 附件 / 反馈 / 摘要 / 导出 / 打印 —— 全部保留。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { gsap } from 'gsap'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog'
import {
  Sheet, SheetContent,
} from '@/components/ui/sheet'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import MaterialIcon from '@/components/MaterialIcon'
import MarkdownRenderer from '@/components/MarkdownRenderer'
import CitationList from '@/components/CitationList'
import IntakeOptions from '@/components/IntakeOptions'
import ActivityTrace from '@/components/ActivityTrace'
import PatientRail from '@/components/PatientRail'
import TriageDialog, { type TriageResult } from '@/components/TriageDialog'
import TriageFlow from '@/components/TriageFlow'
import IntakeStepCard from '@/components/IntakeStepCard'
import { chatAPI } from '@/api/chat'
import api from '@/api'
import { patientAPI, type PatientProfile } from '@/api/patient'
import { confirmDialog, notify } from '@/lib/toast'
import {
  parseJson, makeMessage,
  type ChatMessage, type Conversation,
} from '@/lib/chat-types'
import { useSseChat } from '@/hooks/useSseChat'
import { useRecorder } from '@/hooks/useRecorder'
import { useTts } from '@/hooks/useTts'

interface Capabilities {
  asr_available: boolean
  tts_available: boolean
  vl_available: boolean
  asr_max_seconds: number
  vl_max_images: number
  vl_max_image_mb: number
}
const DEFAULT_CAPABILITIES: Capabilities = {
  asr_available: false, tts_available: false, vl_available: false,
  asr_max_seconds: 60, vl_max_images: 4, vl_max_image_mb: 10,
}

interface PendingAttachment { id: number; name: string }

/** 问诊模式循环（原首页逻辑迁入）：AI 主动问诊建 intake 会话，其余建 free */
const CONSULT_MODES = ['标准问诊', 'AI 主动问诊', '自由问答'] as const
/** 欢迎墙快捷问题（原首页迁入，点击填入输入框） */
const QUICK_QUESTIONS = [
  '跑步后膝盖疼',
  '最近血压偏高',
  '长期睡不好头晕',
  '血糖波动大',
]
// bedtime（月牙）字形在 1em 图标框内会被裁角，换 dark_mode（整月）保证显示完整
const QUICK_ICONS = ['personal_injury', 'monitor_heart', 'dark_mode', 'bloodtype'] as const

/** 按浏览器本地时间返回问候语（用户指定档位：早上好/上午好/中午好/下午好/傍晚好/晚上好/夜深了） */
function timeGreeting(): string {
  const h = new Date().getHours()
  if (h >= 5 && h < 8) return '早上好'
  if (h >= 8 && h < 11) return '上午好'
  if (h >= 11 && h < 13) return '中午好'
  if (h >= 13 && h < 17) return '下午好'
  if (h >= 17 && h < 19) return '傍晚好'
  if (h >= 19 && h < 23) return '晚上好'
  return '夜深了'
}

/** intake.turn 载荷（useSseChat.onIntakeTurn 与 IntakeStepCard 的 questions 同形） */
type IntakeTurnPayload = { reply: string; options: Array<{ label: string; multi: boolean }> }

/** 从可能为 UTC 缺时区的字符串得到本地 Date */
function toDate(value?: string): Date | null {
  if (!value) return null
  const d = new Date(value)
  return isNaN(d.getTime()) ? null : d
}
function formatDate(value?: string): string {
  const d = toDate(value)
  if (!d) return ''
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return `今天 ${hh}:${mm}`
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hh}:${mm}`
}
function conversationDateFormat(value?: string): string {
  const d = toDate(value)
  if (!d) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return '今天'
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 把对话历史拼成 markdown（用于导出） */
function buildConversationMarkdown(conv: Conversation | null, messages: ChatMessage[]): string {
  const head = `# ${conv?.title || '未命名会话'}\n\n生成时间：${formatDate(new Date().toISOString())}\n`
  const body = messages
    .filter((m) => m.role === 'user' || m.content)
    .map((m) => {
      if (m.role === 'user') return `### 问\n\n${m.content}`
      const trace = m.trace.length
        ? `\n\n<details><summary>活动轨迹（${m.trace.length} 步）</summary>${m.trace.map((s) => `\n- ${s.title}（${s.status}）${s.summary ? '：' + s.summary : ''}`).join('')}</details>`
        : ''
      const cites = m.citations.length
        ? `\n\n**参考来源**\n${m.citations.map((c) => `- [${c.id}] ${c.title || c.url || ''}`).join('\n')}`
        : ''
      return `### 答\n\n${m.content}${trace}${cites}`
    })
    .join('\n\n---\n\n')
  return `${head}\n${body}\n`
}

function downloadBlob(name: string, content: string, mime = 'text/markdown') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

interface ChatMessageItemProps {
  message: ChatMessage
  /**
   * 渲染代数（perf）：流式期间 useSseChat 就地修改 message 对象（引用不变），
   * memo 浅比较无法感知内容变化，靠 hook 每次刷出时递增的 renderTick 通知重渲染；
   * 非流式路径（loadMessages / setFeedback 等）message 引用会变，自然重渲染。
   * 只作为 memo 比对信号，不在渲染体内使用（故不参与解构）。
   */
  tick: number
  ttsAvailable: boolean
  isPlaying: boolean
  /** A3：intake 问题已由 IntakeStepCard 承载时（intakeQuestions 非空）跳过旧行内选项块 */
  showInlineIntake: boolean
  onFeedback: (message: ChatMessage, value: 'helpful' | 'unhelpful') => void
  onCopy: (content: string) => void
  onSpeech: (messageId: number) => void
  onStop: () => void
  onIntakeOptionSubmit: (message: ChatMessage, selections: string[]) => void
}

/** 单条消息（React.memo）：handler 全部 useCallback 稳定、布尔 props 派生自父态，
 *  草稿输入 / 侧栏搜索 / 各对话框开关等无关 state 变化不再触发整列表逐条重渲染 */
const ChatMessageItem = memo(function ChatMessageItem({
  message,
  ttsAvailable,
  isPlaying,
  showInlineIntake,
  onFeedback,
  onCopy,
  onSpeech,
  onStop,
  onIntakeOptionSubmit,
}: ChatMessageItemProps) {
  if (message.role === 'user') {
    return (
      <article className="message user">
        <div className="user-bubble">{message.content}</div>
      </article>
    )
  }
  return (
    <article className="message assistant">
      <div className="assistant-response">
        <div className="assistant-label">
          <MaterialIcon name="spa" size={15} />
          <span>橘泉智养助手</span>
          {message.created_at && <em>{formatDate(message.created_at)}</em>}
        </div>

        <ActivityTrace
          trace={message.trace}
          thinkingEvidence={message.thinkingEvidence}
          thinkingAnswer={message.thinkingAnswer}
          answerThinkingStreaming={message.generation_status === 'streaming'}
        />

        <section className="answer-block">
          {message.generation_status === 'streaming' && !message.content ? (
            <div className="answer-loading">
              <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>
              <span>{(message.thinkingAnswer || message.thinkingEvidence) ? '思考中…' : '正在生成回答…'}</span>
            </div>
          ) : (
            <>
              <MarkdownRenderer content={message.content} />
              <CitationList citations={message.citations} />
              {/* Claude 式：操作钮平时隐藏（hover 显现）；有选中反馈 / 生成中 / 触屏 / 键盘焦点时常显 */}
              <div
                className={[
                  'answer-actions',
                  message.feedback ? 'has-selected' : '',
                  message.generation_status === 'streaming' ? 'is-streaming' : '',
                ].filter(Boolean).join(' ')}
              >
                <button
                  type="button"
                  className={message.feedback === 'helpful' ? 'selected' : ''}
                  onClick={() => onFeedback(message, 'helpful')}
                  title="有帮助"
                >
                  <MaterialIcon name="thumb_up" size={16} />
                </button>
                <button
                  type="button"
                  className={message.feedback === 'unhelpful' ? 'selected' : ''}
                  onClick={() => onFeedback(message, 'unhelpful')}
                  title="无帮助"
                >
                  <MaterialIcon name="thumb_down" size={16} />
                </button>
                <button type="button" onClick={() => onCopy(message.content)} title="复制">
                  <MaterialIcon name="content_copy" size={16} />
                </button>
                {ttsAvailable && message.id && (
                  <button
                    type="button"
                    className={isPlaying ? 'selected' : ''}
                    onClick={() => onSpeech(message.id!)}
                    title="朗读"
                  >
                    <MaterialIcon
                      name={isPlaying ? 'stop' : 'volume_up'}
                      size={16}
                    />
                  </button>
                )}
                {message.generation_status === 'streaming' && (
                  <button type="button" onClick={onStop} title="停止生成">
                    <MaterialIcon name="stop_circle" size={16} />
                  </button>
                )}
              </div>
            </>
          )}

          {/* A3：intake 问题已由 IntakeStepCard 承载时跳过旧的行内选项块，避免双重 UI */}
          {showInlineIntake && message.intakeTurn?.collecting && (
            <IntakeOptions
              reply={message.intakeTurn.reply || ''}
              options={message.intakeTurn.options}
              initialSelected={message.intakeTurn.submittedSelections}
              onSubmit={(sel) => onIntakeOptionSubmit(message, sel)}
            />
          )}
        </section>
      </div>
    </article>
  )
}, (prev, next) => {
  // perf：tick 每次流式 flush 都递增并传给所有消息项，若参与浅比较会击穿整列表。
  // 语义：message 引用变化 → 必须重渲染；引用不变但 tick 变化时，仅「流式中的那条」
  // 跟随重渲染，其余历史消息跳过；其余 props 变化正常比较。
  if (prev.message !== next.message) return false
  if (prev.tick !== next.tick) {
    return next.message.generation_status !== 'streaming'
  }
  return (
    prev.ttsAvailable === next.ttsAvailable &&
    prev.isPlaying === next.isPlaying &&
    prev.showInlineIntake === next.showInlineIntake
  )
})

export default function Chat() {
  const navigate = useNavigate()
  const [, setSearchParams] = useSearchParams()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [profiles, setProfiles] = useState<PatientProfile[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState(0)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [loadingMessages, setLoadingMessages] = useState(false)
  // 启动标记：会话列表首次拉取完成前不显示欢迎墙（避免闪现），拉完后仅在“无选中会话”时显示
  const [bootReady, setBootReady] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [patientOpen, setPatientOpen] = useState(false)
  const [triageOpen, setTriageOpen] = useState(false)
  const [triageMode, setTriageMode] = useState<'create' | 'edit'>('create')
  // A2：分诊草稿激活态 —— true 且无选中会话时，在消息流内渲染 TriageFlow（欢迎墙让位）
  const [triageDraftActive, setTriageDraftActive] = useState(false)
  // A3：AI 主动问诊的逐轮问题与作答记录（由 IntakeStepCard 承载）
  const [intakeQuestions, setIntakeQuestions] = useState<IntakeTurnPayload[]>([])
  const [intakeAnswers, setIntakeAnswers] = useState<string[][]>([])
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryText, setSummaryText] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  // 附件小窗：+ 按钮点击弹出（锚定输入区上方），点窗外 / Esc 关闭
  const [attachOpen, setAttachOpen] = useState(false)
  const [capabilities, setCapabilities] = useState<Capabilities>(DEFAULT_CAPABILITIES)
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // 问诊入口合并（原首页逻辑迁入）：欢迎墙提供模式循环选择，发送时按模式建会话
  const [consultModeIdx, setConsultModeIdx] = useState(0)

  const messageScrollerRef = useRef<HTMLDivElement | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  // 附件小窗锚点（+ 按钮 wrapper）：「点击窗外关闭」的包含块判定
  const attachAnchorRef = useRef<HTMLDivElement | null>(null)
  const messageLoadSeq = useRef(0)
  // 新建会话后 currentId 变化会触发 loadMessages，把刚乐观插入的首条消息流覆盖掉——跳过一次
  const skipNextLoadRef = useRef(false)

  const currentConversation = useMemo(
    () => conversations.find((c) => c.id === currentId) || null,
    [conversations, currentId],
  )
  const filteredConversations = useMemo(() => {
    const kw = search.trim().toLowerCase()
    if (!kw) return conversations
    return conversations.filter((c) => (c.title || '未命名会话').toLowerCase().includes(kw))
  }, [conversations, search])
  const triageInitial = useMemo<TriageResult | null>(
    () => parseJson(currentConversation?.triage_json, null as TriageResult | null),
    [currentConversation],
  )

  // 用户上滚检测：距底 >90px 视为用户在看历史，暂停自动跟随；滚回底部附近自动恢复
  const userScrolledUpRef = useRef(false)
  const onScrollerScroll = useCallback(() => {
    const el = messageScrollerRef.current
    if (!el) return
    userScrolledUpRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 90
  }, [])
  const scrollToBottom = useCallback((force = false) => {
    if (!force && userScrolledUpRef.current) return
    requestAnimationFrame(() => {
      const el = messageScrollerRef.current
      if (el) el.scrollTop = el.scrollHeight
      userScrolledUpRef.current = false
    })
  }, [])

  // 稳定 getter（memo 链）：这里若传内联箭头，streamSend→sendMessage→submitIntakeSelection
  // →handleIntakeSubmit→handleIntakeOptionSubmit 整条 useCallback 链都会随每次渲染变化，
  // ChatMessageItem 的 React.memo 会在每次按键时失效
  const getConversationId = useCallback(() => currentId, [currentId])
  const getProfileId = useCallback(() => selectedProfileId || undefined, [selectedProfileId])

  const {
    messages, setMessages, sending, renderTick, sendMessage, submitIntakeSelection, abort,
  } = useSseChat({
    getConversationId,
    getProfileId,
    onMessagesUpdated: scrollToBottom,
    // A3：每轮追问交给 IntakeStepCard 承载（消息体内的旧 IntakeOptions 块随之跳过）
    onIntakeTurn: (turn) => setIntakeQuestions((prev) => [...prev, turn]),
  })
  const { recording, toggle: toggleRecording } = useRecorder(
    capabilities.asr_max_seconds,
    (text) => {
      if (text) setDraft((prev) => (prev ? `${prev} ${text}` : text))
    },
  )
  const { playingMessageId, toggle: toggleSpeech } = useTts()

  /** 拉会话列表；只填充侧栏，不自动选中任何会话（A1：裸 /chat 与 ?new=1 都回到欢迎墙，
   *  会话仅经 ?c=、侧栏最近会话点击或无会话直接发送（自动建会话）进入）。
   *  bootReady 不在这里放开 —— 挂载 effect 改为三路并发后，统一在三路落定并应用后再置 true，
   *  保证欢迎墙出现时档案/设置已就绪（语义与原串行版一致） */
  const loadConversations = useCallback(async () => {
    try {
      const { data } = await chatAPI.getConversations()
      const list: Conversation[] = (Array.isArray(data) ? data : data?.items ?? []) as Conversation[]
      setConversations(list)
      // 空列表与非空列表都不自动打开会话：欢迎墙（唯一问诊入口）自然显示
    } catch { /* 拦截器已提示 */ }
  }, [])

  /** 加载某会话消息；带 sequence 防竞态 */
  const loadMessages = useCallback(async (id: number) => {
    const seq = ++messageLoadSeq.current
    setLoadingMessages(true)
    try {
      const { data } = await chatAPI.getMessages(id)
      if (seq !== messageLoadSeq.current) return
      const records = (Array.isArray(data) ? data : data?.items ?? []) as Record<string, any>[]
      setMessages(() => records.map((r) => makeMessage(r)))
      scrollToBottom()
    } catch {
      if (seq === messageLoadSeq.current) setMessages(() => [])
    } finally {
      if (seq === messageLoadSeq.current) setLoadingMessages(false)
    }
  }, [setMessages, scrollToBottom])

  /** 新建会话 */
  const createConversation = useCallback(
    async (
      title = '新问诊',
      profileId?: number | null,
      triage: Record<string, unknown> | null = null,
      mode: 'free' | 'guided' | 'intake' = 'free',
    ): Promise<Conversation | null> => {
      try {
        const { data } = await chatAPI.createConversation(title, profileId ?? null, triage, mode)
        setConversations((prev) => [data as Conversation, ...prev])
        skipNextLoadRef.current = true
        setCurrentId((data as Conversation).id)
        setMessages(() => [])
        requestAnimationFrame(() => composerRef.current?.focus())
        return data as Conversation
      } catch {
        return null
      }
    },
    [setMessages],
  )

  // currentId 变化 → 同步 selectedProfileId + 加载消息（新建会话后的那次跳过，避免覆盖乐观消息）；
  // 同时重置主动问诊步骤卡；currentId 变非空即退出分诊草稿
  useEffect(() => {
    setIntakeQuestions([])
    setIntakeAnswers([])
    if (currentId) setTriageDraftActive(false)
    if (!currentId) {
      setMessages(() => [])
      return
    }
    if (skipNextLoadRef.current) {
      skipNextLoadRef.current = false
      return
    }
    const conv = conversations.find((c) => c.id === currentId)
    if (conv) setSelectedProfileId(conv.patient_profile_id || 0)
    void loadMessages(currentId)
  }, [currentId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 挂载：拉档案 + 公共设置 + 会话列表 —— 三路并入同一个 Promise.allSettled 全并发
  //（perf：原版 conversations 串行在档案/设置之后，现在三路同时出网）；
  // 全部落定并应用后再放开 bootReady（欢迎墙等三路就绪，语义与原串行版一致）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [profilesRes, settingsRes, conversationsRes] = await Promise.allSettled([
        patientAPI.getProfiles(),
        api.get('/api/public/settings'),
        loadConversations(),
      ])
      if (cancelled) return
      void conversationsRes // 会话列表在 loadConversations 内部已处理（失败走拦截器提示）
      if (profilesRes.status === 'fulfilled') {
        const list = (profilesRes.value.data as PatientProfile[]) || []
        setProfiles(list)
        const stored = localStorage.getItem('selectedPatientProfile')
        const storedId = stored ? Number(stored) : 0
        setSelectedProfileId(list.find((p) => p.id === storedId)?.id || list.find((p) => p.is_default)?.id || list[0]?.id || 0)
      }
      if (settingsRes.status === 'fulfilled') {
        const s = (settingsRes.value.data as Partial<Capabilities>) || {}
        setCapabilities({
          ...DEFAULT_CAPABILITIES,
          asr_available: !!s.asr_available,
          tts_available: !!s.tts_available,
          vl_available: !!s.vl_available,
          asr_max_seconds: Number(s.asr_max_seconds) || DEFAULT_CAPABILITIES.asr_max_seconds,
          vl_max_images: Number(s.vl_max_images) || DEFAULT_CAPABILITIES.vl_max_images,
          vl_max_image_mb: Number(s.vl_max_image_mb) || DEFAULT_CAPABILITIES.vl_max_image_mb,
        })
      }
      setBootReady(true)
    })()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 路由参数驱动（统一监听 location.search，挂载与后续变化都生效）：
  // - ?q&mode：Home 发起 → intake/free 新建会话并自动发首条；guided 启动对话流内嵌分诊（q 忽略）
  // - ?c= / ?conversation=：切换到指定会话（侧栏最近会话、长辈模式报告入口）
  // - ?new=1 或参数从有 c 变为无：回到欢迎墙（唯一问诊入口）
  // lastQueryRef 初始为 ''：挂载带参时不被跳过；挂载裸 /chat 时（''===''）静默
  const location = useLocation()
  const lastQueryRef = useRef('')
  useEffect(() => {
    const key = location.search
    if (key === lastQueryRef.current) return
    const prevKey = lastQueryRef.current
    lastQueryRef.current = key

    const params = new URLSearchParams(key)
    const q = params.get('q')
    const mode = params.get('mode')
    const c = params.get('c') || params.get('conversation')

    if (q || mode) {
      const run = async () => {
        if (mode === 'intake') {
          const conv = await createConversation(q || 'AI 主动问诊', selectedProfileId || null, null, 'intake')
          if (conv && q) void sendMessage(q, [], conv.id)
        } else if (mode === 'guided') {
          // A2：分诊改为对话流内嵌 TriageFlow（q 忽略）；需先回到无会话的欢迎墙态
          setTriageDraftActive(true)
          setCurrentId(null)
        } else {
          const conv = await createConversation(q || '自由问答', selectedProfileId || null, null, 'free')
          if (conv && q) void sendMessage(q, [], conv.id)
        }
        setSearchParams({}, { replace: true })
      }
      void run()
      return
    }
    if (c) {
      const id = Number(c)
      if (id && id !== currentId) setCurrentId(id)
      return
    }
    // ?new=1：显式「新问诊」→ 回到欢迎墙（唯一问诊入口）
    if (params.get('new')) {
      setTriageDraftActive(false)
      setCurrentId(null)
      setSearchParams({}, { replace: true })
      return
    }
    // 从带 c 的 URL 变成裸 /chat = 点了「新问诊」→ 回到欢迎墙
    if (new URLSearchParams(prevKey).get('c') || new URLSearchParams(prevKey).get('conversation')) {
      setTriageDraftActive(false)
      setCurrentId(null)
    }
  }, [location.search]) // eslint-disable-line react-hooks/exhaustive-deps

  // 发送守卫：sending state 在同一次事件循环里读两次是旧值（欢迎墙双击 / Enter+按钮齐发
  // 会在 createConversation await 间隙放进第二次点击，重复建会话），用同步 ref 硬挡
  const submittingRef = useRef(false)

  /** 发送当前草稿 */
  const submitMessage = useCallback(async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    try {
      const content = draft.trim()
      if (!content && pendingAttachments.length === 0) return
      const attachmentIds = pendingAttachments.map((a) => a.id)
      if (!currentId) {
        // A1：欢迎墙是唯一入口 —— 无会话时按所选模式创建会话并发送草稿
        const isIntake = CONSULT_MODES[consultModeIdx] === 'AI 主动问诊'
        const conv = await createConversation(
          isIntake ? 'AI 主动问诊' : '自由问诊',
          selectedProfileId || null,
          null,
          isIntake ? 'intake' : 'free',
        )
        if (!conv) return // 创建失败（拦截器已提示）：保留草稿与附件
        setPendingAttachments([])
        setDraft('')
        void sendMessage(content, attachmentIds, conv.id)
        return
      }
      setPendingAttachments([])
      setDraft('')
      await sendMessage(content, attachmentIds)
    } finally {
      submittingRef.current = false
    }
    scrollToBottom(true)
  }, [draft, pendingAttachments, currentId, selectedProfileId, consultModeIdx, createConversation, sendMessage, scrollToBottom])

  /** intake 选择回传（消息体内旧 IntakeOptions 的兜底路径） */
  const handleIntakeSubmit = useCallback(
    async (selections: string[]) => {
      if (!selections.length) return
      await submitIntakeSelection(selections.join('、'))
    },
    [submitIntakeSelection],
  )

  /** 行内 intake 选项提交（原消息渲染内联逻辑外提，经 props 传给 memo 消息项）：
   *  先回写 submittedSelections 再走统一回传 */
  const handleIntakeOptionSubmit = useCallback(
    (message: ChatMessage, selections: string[]) => {
      setMessages((prev) => prev.map((m) =>
        m.localKey === message.localKey
          ? { ...m, intakeTurn: { ...m.intakeTurn!, submittedSelections: selections } }
          : m,
      ))
      void handleIntakeSubmit(selections)
    },
    [setMessages, handleIntakeSubmit],
  )

  /** A3：IntakeStepCard 作答 —— 记录答案后按序回传 */
  const handleStepAnswer = useCallback(
    (questionIndex: number, selections: string[]) => {
      setIntakeAnswers((prev) => {
        const next = prev.slice()
        while (next.length <= questionIndex) next.push([])
        next[questionIndex] = [...selections]
        return next
      })
      void submitIntakeSelection(selections.join('、'))
    },
    [submitIntakeSelection],
  )

  /** A2：内嵌分诊提交 —— 建 guided 会话并发送主诉；建会话失败时保留分诊草稿，避免用户逐级填完的选择被静默丢弃 */
  const handleTriageFlowSubmit = useCallback(
    async (triage: TriageResult, profileId: number | null) => {
      const conv = await createConversation(
        triage.diseaseName || '分诊问诊',
        profileId,
        triage as unknown as Record<string, unknown>,
        'guided',
      )
      if (!conv) return
      if (triage.chiefComplaint) void sendMessage(triage.chiefComplaint, [], conv.id)
      setTriageDraftActive(false)
    },
    [createConversation, sendMessage],
  )

  /** A2：内嵌分诊跳过 —— 直接建自由问诊会话 */
  const handleTriageFlowSkip = useCallback(async () => {
    await createConversation('自由问诊', selectedProfileId || null, null, 'free')
    setTriageDraftActive(false)
  }, [createConversation, selectedProfileId])

  /** 选择某个会话 */
  const selectConversation = (id: number) => {
    setCurrentId(id)
    setHistoryOpen(false)
  }

  /** 把当前选择写入 localStorage + 同步到后端上下文 */
  const persistPatientLink = useCallback(async (id: number) => {
    localStorage.setItem('selectedPatientProfile', String(id || ''))
    if (currentId) {
      try { await chatAPI.updateConversationContext(currentId, id || null) } catch { /* noop */ }
    }
  }, [currentId])

  const onSelectProfile = (id: number) => {
    setSelectedProfileId(id)
    void persistPatientLink(id)
  }

  /** 删除 / 重命名 / 自动改名（对应 Vue 的 onConversationCommand） */
  const handleDelete = async (conv: Conversation) => {
    if (!(await confirmDialog(`确定删除会话「${conv.title || '未命名'}」吗？`, '删除会话'))) return
    try {
      await chatAPI.deleteConversation(conv.id)
      setConversations((prev) => prev.filter((c) => c.id !== conv.id))
      if (currentId === conv.id) {
        setCurrentId(null)
        setMessages(() => [])
      }
      notify.success('会话已删除')
    } catch { /* 拦截器已提示 */ }
  }
  const openRename = (conv: Conversation) => {
    setRenameTarget(conv)
    setRenameValue(conv.title || '')
  }
  const submitRename = async () => {
    if (!renameTarget) return
    const title = renameValue.trim()
    if (!title) return
    try {
      await chatAPI.updateConversationTitle(renameTarget.id, title)
      setConversations((prev) => prev.map((c) => (c.id === renameTarget.id ? { ...c, title } : c)))
      setRenameTarget(null)
    } catch { /* noop */ }
  }
  const autoRename = async (conv: Conversation) => {
    try {
      const { data } = await chatAPI.autoRename(conv.id)
      const title = (data as { title?: string })?.title
      if (title) setConversations((prev) => prev.map((c) => (c.id === conv.id ? { ...c, title } : c)))
      notify.success('已根据首条对话生成标题')
    } catch { /* noop */ }
  }

  /** 分诊提交 */
  const saveTriage = async (triage: TriageResult, profileId: number | null) => {
    setTriageOpen(false)
    if (triageMode === 'create') {
      const conv = await createConversation(triage.diseaseName || '分诊问诊', profileId, triage as unknown as Record<string, unknown>, 'guided')
      if (conv && triage.chiefComplaint) void sendMessage(triage.chiefComplaint, [], conv.id)
    } else if (currentId) {
      try {
        await chatAPI.updateConversationContext(currentId, profileId, triage as unknown as Record<string, unknown>)
        setConversations((prev) => prev.map((c) => (c.id === currentId ? { ...c, triage_json: JSON.stringify(triage), patient_profile_id: profileId } : c)))
        notify.success('分诊信息已更新')
      } catch { /* noop */ }
    }
  }
  const skipTriage = async () => {
    setTriageOpen(false)
    await createConversation('自由问诊', selectedProfileId || null, null, 'free')
  }

  const openEditTriage = () => {
    if (!currentConversation) {
      // A2：无会话时工具栏「分诊信息」→ 对话流内嵌分诊草稿
      setTriageDraftActive(true)
      return
    }
    // 有会话：保持 TriageDialog 编辑模式
    setTriageMode('edit')
    setTriageOpen(true)
  }

  /** 生成摘要 */
  const openSummary = async () => {
    if (!currentId) return
    setSummaryOpen(true)
    setSummaryLoading(true)
    setSummaryText('')
    try {
      const { data } = await chatAPI.summarize(currentId)
      setSummaryText((data as { summary?: string })?.summary || '')
    } catch {
      setSummaryText('摘要生成失败，请稍后重试。')
    } finally {
      setSummaryLoading(false)
    }
  }
  const downloadSummary = () => {
    if (!summaryText) return
    downloadBlob(`${currentConversation?.title || '摘要'}.md`, summaryText)
  }
  const downloadConversation = () => {
    if (!messages.length) { notify.warning('当前会话暂无消息可导出'); return }
    const md = buildConversationMarkdown(currentConversation, messages)
    downloadBlob(`${currentConversation?.title || '会话'}.md`, md)
  }
  const printConversation = () => window.print()

  /** 复制答案（useCallback 稳定：作为 ChatMessageItem 的 memo props 传入） */
  const copyAnswer = useCallback(async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      notify.success('已复制到剪贴板')
    } catch {
      notify.error('复制失败')
    }
  }, [])

  /** 反馈（useCallback 稳定：作为 ChatMessageItem 的 memo props 传入） */
  const setFeedback = useCallback(async (message: ChatMessage, value: 'helpful' | 'unhelpful') => {
    if (!message.id) return
    const next = message.feedback === value ? null : value
    try {
      await chatAPI.updateFeedback(message.id, next)
      setMessages((prev) => prev.map((m) => (m.localKey === message.localKey ? { ...m, feedback: next } : m)))
    } catch { /* noop */ }
  }, [setMessages])

  /** 附件选择：缩图 + 上传 */
  const resizeForAnalysis = (file: File): Promise<Blob> =>
    new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const maxDim = 2048
        let { width, height } = img
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height)
          width = Math.round(width * scale)
          height = Math.round(height * scale)
        }
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) { resolve(file); return }
        ctx.drawImage(img, 0, 0, width, height)
        canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.9)
      }
      img.onerror = () => resolve(file)
      img.src = URL.createObjectURL(file)
    })

  const onAttachmentSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || !fileList.length) return
    // 欢迎墙态（无会话）也可上传：先自动建「自由问诊」会话再走既有上传流程；
    // 建会话失败（拦截器已提示）时放弃本次选择，等价于原 currentId 守卫
    let targetId = currentId
    if (!targetId) {
      const conv = await createConversation('自由问诊', selectedProfileId || null, null, 'free')
      if (!conv) return
      targetId = conv.id
    }
    const files = Array.from(fileList).slice(0, capabilities.vl_max_images)
    for (const file of files) {
      if (file.size / 1024 / 1024 > capabilities.vl_max_image_mb) {
        notify.error(`${file.name} 超过 ${capabilities.vl_max_image_mb}MB 限制`)
        continue
      }
      try {
        const analysis = await resizeForAnalysis(file)
        const { data } = await chatAPI.uploadAttachment(targetId, file, analysis)
        const record = data as { id: number; filename?: string }
        setPendingAttachments((prev) => [...prev, { id: record.id, name: record.filename || file.name }])
      } catch { /* 拦截器已提示 */ }
    }
    if (attachmentInputRef.current) attachmentInputRef.current.value = ''
  }
  const removePendingAttachment = async (att: PendingAttachment) => {
    try { await chatAPI.deleteAttachment(att.id) } catch { /* noop */ }
    setPendingAttachments((prev) => prev.filter((a) => a.id !== att.id))
  }

  // 附件小窗：打开期间点击窗外（锚点 wrapper 之外）/ 按 Esc 关闭；
  // pointerdown 阶段关闭，早于任何后续 click，避免误触窗下控件
  useEffect(() => {
    if (!attachOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (attachAnchorRef.current && !attachAnchorRef.current.contains(e.target as Node)) {
        setAttachOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAttachOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [attachOpen])

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submitMessage()
    }
  }

  /** 侧栏「新问诊」：回到欢迎墙 */
  const goWelcomeWall = () => {
    setTriageDraftActive(false)
    setCurrentId(null)
  }

  // 欢迎墙只在「启动完成 && 没有选中任何会话 && 未激活内嵌分诊」时出现；
  // 选完模式新建会话后（currentId 已设）直接进入空白对话 + 输入框，不再重复落回欢迎页
  const isEmpty = bootReady && currentId === null && !loadingMessages && !triageDraftActive

  // A4：欢迎墙 ↔ 对话内容切换时，新内容 fade+上移入场（尊重 prefers-reduced-motion；
  // TriageFlow 自带入场动画，分诊草稿激活时跳过避免双重动画）
  const prevEmptyRef = useRef<boolean | null>(null)
  useEffect(() => {
    const prevEmpty = prevEmptyRef.current
    prevEmptyRef.current = isEmpty
    if (prevEmpty === null || prevEmpty === isEmpty) return
    if (triageDraftActive) return
    const container = threadRef.current
    if (!container || !container.children.length) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const ctx = gsap.context(() => {
      gsap.from(container.children, {
        opacity: 0, y: 16, duration: 0.42, ease: 'power2.out',
        stagger: 0.06, clearProps: 'opacity,transform',
      })
    }, threadRef)
    return () => ctx.revert()
  }, [isEmpty, triageDraftActive])

  /** 输入区（form + 附件 chips）：欢迎墙态渲染进居中问候列，会话态渲染进底部 dock ——
   *  同一个 JSX 实例，两种布局二选一挂载（ref/受控状态均由本组件持有，切换不丢逻辑） */
  const composerBlock = (
    <>
      <form className="dock" onSubmit={(e) => { e.preventDefault(); void submitMessage() }}>
        <input
          ref={attachmentInputRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          multiple
          onChange={onAttachmentSelected}
        />
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKey}
          placeholder="描述症状或上传资料，Enter 发送 / Shift+Enter 换行"
          rows={1}
        />
        {/* Kimi 式两行 composer：上行输入、下行左工具 / 右模式档位 + 发送 */}
        <div className="dock-foot">
          <div className="dock-tools">
            {capabilities.vl_available && (
              <div className="attach-anchor" ref={attachAnchorRef}>
                <button
                  className={`composer-tool${attachOpen ? ' on' : ''}`}
                  type="button"
                  title="添加图片"
                  aria-haspopup="dialog"
                  aria-expanded={attachOpen}
                  onClick={() => setAttachOpen((v) => !v)}
                >
                  <MaterialIcon name="add" size={20} />
                </button>
                {attachOpen && (
                  <div className="attach-pop" role="dialog" aria-label="上传图片">
                    <button
                      type="button"
                      className="attach-close"
                      aria-label="关闭"
                      onClick={() => setAttachOpen(false)}
                    >
                      <MaterialIcon name="close" size={16} />
                    </button>
                    {/* 无会话（欢迎墙态）也可选图：onAttachmentSelected 内会先自动建会话 */}
                    <button
                      type="button"
                      className="attach-pick"
                      onClick={() => attachmentInputRef.current?.click()}
                    >
                      <MaterialIcon name="image" size={16} />
                      选择图片
                    </button>
                    {pendingAttachments.length > 0 && (
                      <ul className="attach-list">
                        {pendingAttachments.map((att) => (
                          <li key={att.id}>
                            <MaterialIcon name="image" size={14} />
                            <span className="attach-name">{att.name}</span>
                            <button
                              type="button"
                              aria-label="移除"
                              onClick={() => void removePendingAttachment(att)}
                            >
                              <MaterialIcon name="close" size={14} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="attach-hint">图片将用于医学影像理解</p>
                  </div>
                )}
              </div>
            )}
            {capabilities.asr_available && (
              <button
                className={`composer-tool${recording ? ' recording' : ''}`}
                type="button"
                title={recording ? '停止录音' : '语音输入'}
                onClick={toggleRecording}
              >
                <MaterialIcon name={recording ? 'stop' : 'mic'} size={20} />
              </button>
            )}
          </div>
          <div className="dock-right">
            {/* 问诊模式档位：合并为单按钮循环切换（用户指定） */}
            <button
              type="button"
              className="mode-tab"
              onClick={() => setConsultModeIdx((i) => (i + 1) % CONSULT_MODES.length)}
              title="切换问诊模式"
            >
              {CONSULT_MODES[consultModeIdx]}
            </button>
            {/* A1：无会话时发送会自动建自由问诊会话（见 submitMessage），只需防重复提交；箭头常驻不换图标 */}
            <button className={`send-button${sending ? ' sending' : ''}`} type="submit" disabled={sending}>
              <MaterialIcon name="arrow_upward" size={18} />
            </button>
          </div>
        </div>
      </form>
      {pendingAttachments.length > 0 && (
        <div className="pending-attachments">
          {pendingAttachments.map((att) => (
            <span key={att.id}>
              <MaterialIcon name="image" size={14} />
              {att.name}
              <button type="button" onClick={() => removePendingAttachment(att)} aria-label="移除">
                <MaterialIcon name="close" size={14} />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  )
  const disclaimerNote = (
    <div className="composer-note">橘泉智养仅作健康参考，不能替代医生诊断；回答基于公开医学资料与档案信息生成。</div>
  )

  return (
    <div className="chat-workbench">
      {/* 历史 rail 遮罩：≤760px rail 变右侧 fixed overlay 时显示，点遮罩关闭 rail；
          桌面（>760）由样式 display:none 兜底，不渲染视觉（见下方内联样式） */}
      {historyOpen && (
        <div className="rail-mask" aria-hidden="true" onClick={() => setHistoryOpen(false)} />
      )}
      {/* 历史侧栏 —— 滑入式 */}
      {historyOpen && (
        <aside className="conversation-rail">
          <div className="rail-tools">
            <button className="new-chat" type="button" onClick={goWelcomeWall}>
              <MaterialIcon name="add" size={18} /> 新问诊
            </button>
            <label className="history-search">
              <MaterialIcon name="search" size={16} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索会话" />
            </label>
            <button className="rail-close" type="button" aria-label="关闭历史" onClick={() => setHistoryOpen(false)}>
              <MaterialIcon name="chevron_left" size={20} />
            </button>
          </div>
          <div className="rail-label">最近会话（{filteredConversations.length}）</div>
          <div className="conversation-list">
            {filteredConversations.map((conv) => (
              <div
                key={conv.id}
                className={`conversation-row${conv.id === currentId ? ' active' : ''}`}
              >
                <button
                  type="button"
                  className="conversation-main"
                  onClick={() => selectConversation(conv.id)}
                >
                  <strong>{conv.title || '未命名会话'}</strong>
                  <span>{conversationDateFormat(conv.updated_at || conv.created_at)}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="row-more" type="button" aria-label="更多操作">
                      <MaterialIcon name="more_horiz" size={18} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem icon="edit" onClick={() => openRename(conv)}>重命名</DropdownMenuItem>
                    <DropdownMenuItem icon="auto_awesome" onClick={() => autoRename(conv)}>自动命名</DropdownMenuItem>
                    <DropdownMenuItem icon="delete" onClick={() => handleDelete(conv)}>删除</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
            {filteredConversations.length === 0 && (
              <div className="empty-list">未找到会话</div>
            )}
          </div>
        </aside>
      )}

      {/* 主对话区 */}
      <section className="conversation-main-pane chat">
        {/* 欢迎态不渲染工具条（对齐参考产品的干净首页）；工具在会话态可用 */}
        {!isEmpty && (
        <div className="chat-toolbar">
          <button
            className={`chat-tool${historyOpen ? ' on' : ''}`}
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-label="历史会话"
          >
            <MaterialIcon name="history" size={18} />
          </button>
          <h1 className="conversation-title">{currentConversation?.title || '问诊'}</h1>
          <div className="chat-actions">
            <button className="chat-tool" type="button" onClick={() => setPatientOpen(true)} title="患者档案">
              <MaterialIcon name="person" size={18} />
            </button>
            <button className="chat-tool" type="button" onClick={openEditTriage} title="分诊信息">
              <MaterialIcon name="account_tree" size={18} />
            </button>
            <button className="chat-tool" type="button" onClick={openSummary} title="生成摘要">
              <MaterialIcon name="description" size={18} />
            </button>
            <button className="chat-tool" type="button" onClick={downloadConversation} title="导出会话">
              <MaterialIcon name="download" size={18} />
            </button>
            <button className="chat-tool" type="button" onClick={printConversation} title="打印">
              <MaterialIcon name="print" size={18} />
            </button>
          </div>
        </div>
        )}

        <div className="chat-scroll" ref={messageScrollerRef} onScroll={onScrollerScroll}>
          <div className="thread" ref={threadRef}>
            {loadingMessages && (
              <div className="loading-state">
                <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>
                <span>加载中…</span>
              </div>
            )}
            {isEmpty && (
              <div className="welcome-state">
                {/* 首页合并（用户需求）：logo 放问候语左侧，两个组件合并居中；问候语按浏览器时间变化 */}
                <div className="welcome-hello">
                  <img className="welcome-logo" src="/logo.png" alt="橘泉智养" />
                  <h1 className="welcome-title">{timeGreeting()}，有什么可以帮您的</h1>
                </div>
                {composerBlock}
                <div className="welcome-quick">
                  {QUICK_QUESTIONS.map((q, i) => (
                    <button key={q} type="button" title={q} onClick={() => setDraft(q)}>
                      <MaterialIcon name={QUICK_ICONS[i]} size={18} />
                      <span>{q}</span>
                    </button>
                  ))}
                </div>
                {disclaimerNote}
              </div>
            )}

            {/* A2：对话流内嵌分诊（无会话草稿态，欢迎墙让位） */}
            {triageDraftActive && currentId === null && (
              <TriageFlow
                profiles={profiles}
                initialProfileId={selectedProfileId}
                onSubmit={handleTriageFlowSubmit}
                onSkip={handleTriageFlowSkip}
              />
            )}

            {messages.map((message) => (
              <ChatMessageItem
                key={message.localKey}
                message={message}
                tick={renderTick}
                ttsAvailable={capabilities.tts_available}
                isPlaying={playingMessageId === message.id}
                showInlineIntake={intakeQuestions.length === 0}
                onFeedback={setFeedback}
                onCopy={copyAnswer}
                onSpeech={toggleSpeech}
                onStop={abort}
                onIntakeOptionSubmit={handleIntakeOptionSubmit}
              />
            ))}

            {/* A3：AI 主动问诊步骤卡（逐轮问题统一在消息列表后承载） */}
            {intakeQuestions.length > 0 && (
              <IntakeStepCard
                questions={intakeQuestions}
                answers={intakeAnswers}
                submitting={sending}
                onAnswer={handleStepAnswer}
              />
            )}
          </div>
        </div>

        {/* 会话态：composer 贴底常驻（欢迎墙态时 composer 已渲染进上方居中问候列） */}
        {!isEmpty && (
          <div className="dock-wrap">
            {composerBlock}
            {disclaimerNote}
          </div>
        )}
      </section>

      {/* 患者档案抽屉 */}
      <Sheet open={patientOpen} onOpenChange={setPatientOpen}>
        <SheetContent side="right" style={{ width: 'min(380px, 92vw)', padding: 0, maxWidth: '92vw' }}>
          <PatientRail
            profiles={profiles}
            selectedProfileId={selectedProfileId}
            onSelect={onSelectProfile}
            onEdit={() => { setPatientOpen(false); navigate('/profile') }}
          />
        </SheetContent>
      </Sheet>

      {/* 分诊对话框 */}
      <TriageDialog
        open={triageOpen}
        onOpenChange={setTriageOpen}
        profiles={profiles}
        initial={triageInitial}
        initialProfileId={selectedProfileId}
        mode={triageMode}
        onSubmit={saveTriage}
        onSkip={skipTriage}
      />

      {/* 重命名对话框 */}
      <AlertDialog open={!!renameTarget} onOpenChange={(v: boolean) => !v && setRenameTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重命名会话</AlertDialogTitle>
            <AlertDialogDescription>输入新的会话标题</AlertDialogDescription>
          </AlertDialogHeader>
          <input
            className="rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') void submitRename() }}
          />
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRenameTarget(null)}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={submitRename}>保存</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 摘要对话框 */}
      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent style={{ maxWidth: 'min(640px, 94vw)' }}>
          <DialogHeader>
            <DialogTitle>会话摘要</DialogTitle>
            <DialogDescription>{currentConversation?.title}</DialogDescription>
          </DialogHeader>
          {summaryLoading ? (
            <div className="dialog-loading">
              <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>
              <span>正在生成摘要…</span>
            </div>
          ) : (
            <MarkdownRenderer content={summaryText} />
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button type="button" className="text-tool-btn" onClick={() => setSummaryOpen(false)}>关闭</button>
            <button type="button" className="text-tool-btn" onClick={downloadSummary} disabled={!summaryText}>
              下载 .md
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <style>{`
        .chat-workbench{
          position:relative;height:100%;display:flex;align-items:stretch;
          background:var(--paper,#FAFAFA);
          /* 中性单色语义槽（组件级别名，v4 多主题；照 IntakeStepCard --isc-* /
             TriageFlow --tflow-* 模式）：全部 var() 回指 tokens.css 全局语义层，
             四主题（graphite/paper/spring/night）切换即跟随，组件内不再写死色值。
             原为 v3 石墨字面值（ink 近黑 / selected 用户气泡填充 / panel 侧栏浅底 /
             hairline 描边 / hover 黑5%）；彩色仅余链接蓝/危险红功能位。
             阴影与缓动照 vercel globals.css tokens（--shadow-* 已含 night 深色覆盖）。 */
          --mono-ink:var(--color-primary);
          --mono-ink-hover:var(--color-accentHover);
          --mono-selected:var(--user);
          --mono-hover:var(--color-primarySoft);
          --mono-panel:var(--color-bgSecondary);
          --mono-hairline:var(--color-borderPrimary);
          --mono-shadow-card:var(--shadow-card);
          --mono-shadow-composer:var(--shadow-composer);
          --mono-shadow-composer-focus:var(--shadow-composer-focus);
          --ease-spring:cubic-bezier(0.22,1,0.36,1);
          --ease-smooth:cubic-bezier(0.4,0,0.2,1);
        }
        .chat-workbench button,.chat-workbench input,.chat-workbench textarea,.chat-workbench select{
          font-family:inherit;color:inherit;
        }

        /* 历史侧栏：#F7F7F7 底，比主背景深半档分区（无竖线分隔）；新问诊=近黑实底胶囊 */
        .conversation-rail{
          flex:0 0 min(288px,82vw);width:min(288px,82vw);height:100%;background:var(--mono-panel);
          padding:14px 12px;display:flex;flex-direction:column;gap:10px;overflow:hidden;
        }
        /* 历史 rail 遮罩：桌面（>760）永远隐藏；≤760 在媒体查询里以 fixed 半透明层启用 */
        .rail-mask{display:none}
        @keyframes rail-in{from{transform:translateX(100%)}to{transform:translateX(0)}}
        @keyframes mask-in{from{opacity:0}to{opacity:1}}
        .rail-tools{display:flex;align-items:center;gap:6px}
        .new-chat{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:44px;border:1px solid var(--color-primary);background:var(--color-primary);color:var(--color-primary-foreground);border-radius:9999px;padding:0 14px;font-size:.7rem;font-weight:600;cursor:pointer;flex:1;transition:background .15s var(--ease-smooth)}
        .new-chat:hover{background:var(--mono-ink-hover);border-color:var(--mono-ink-hover)}
        .history-search{display:flex;align-items:center;gap:6px;height:38px;border:1px solid var(--mono-hairline);border-radius:9999px;padding:0 12px;background:var(--color-surface,#fff);flex:1.4;color:var(--color-textTertiary);transition:border-color .15s var(--ease-smooth)}
        .history-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:.675rem;color:var(--color-textPrimary)}
        .history-search:focus-within{border-color:var(--color-ring)}
        .rail-close{width:30px;height:30px;border:0;background:transparent;border-radius:9999px;cursor:pointer;display:grid;place-items:center;color:var(--color-textTertiary);transition:background .15s var(--ease-smooth)}
        .rail-close:hover{background:var(--mono-hover);color:var(--color-textPrimary)}
        .rail-label{font-size:.6rem;color:var(--color-textTertiary);padding:4px 6px 0}
        .conversation-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:2px}
        .conversation-row{display:flex;align-items:center;gap:4px;padding:0 4px;border-radius:10px;transition:background .15s var(--ease-smooth)}
        .conversation-row:hover{background:var(--mono-hover)}
        .conversation-row.active{background:var(--mono-selected)}
        .conversation-main{flex:1;min-width:0;background:transparent;border:0;text-align:left;padding:8px;cursor:pointer;display:block}
        .conversation-main strong{display:block;font-size:.7rem;font-weight:600;color:var(--color-textPrimary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .conversation-main span{display:block;font-size:.6rem;color:var(--color-textTertiary);margin-top:3px}
        .row-more{width:26px;height:26px;border:0;background:transparent;border-radius:8px;cursor:pointer;color:var(--color-textTertiary);display:grid;place-items:center;flex:0 0 26px;transition:background .15s var(--ease-smooth),color .15s var(--ease-smooth)}
        .row-more:hover{background:var(--mono-hover);color:var(--color-textPrimary)}
        /* Claude 式：行操作 hover 才显现（触屏 / 键盘焦点常显） */
        @media(hover:hover){
          .row-more{opacity:0}
          .conversation-row:hover .row-more,.conversation-row:focus-within .row-more,.row-more:focus-visible{opacity:1}
        }
        .empty-list,.loading-state{padding:18px;text-align:center;color:var(--color-textTertiary);font-size:.675rem}

        /* 顶栏：ghost 图标钮 + hairline 分隔 */
        .conversation-main-pane{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;background:var(--paper,#FAFAFA)}
        .chat-toolbar{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--mono-hairline);min-height:54px}
        .conversation-title{flex:1;min-width:0;margin:0;font-size:1.05rem;font-weight:600;color:var(--color-textPrimary);font-family:var(--font-family-serif);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .chat-tool{width:36px;height:36px;flex:0 0 36px;border:0;border-radius:10px;background:transparent;color:var(--color-textSecondary);cursor:pointer;display:grid;place-items:center;padding:0;transition:background .15s var(--ease-smooth),color .15s var(--ease-smooth)}
        .chat-tool:hover{background:var(--mono-hover);color:var(--color-textPrimary)}
        .chat-tool.on{background:var(--mono-selected);color:var(--mono-ink)}
        .chat-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
        .text-tool-btn{height:36px;border:1px solid var(--mono-hairline);background:var(--color-surface,#fff);color:var(--color-textSecondary);border-radius:10px;padding:0 14px;cursor:pointer;font-family:inherit;font-size:.72rem;transition:background .15s var(--ease-smooth),color .15s var(--ease-smooth)}
        .text-tool-btn:hover{background:var(--mono-hover);border-color:var(--mono-hairline);color:var(--mono-ink)}
        .text-tool-btn:disabled{opacity:.5;cursor:not-allowed}

        /* 消息区：thread 居中单栏，规格 46rem ≈ 740px；消息入场 message-in 微动效（规格 §2） */
        .chat-scroll{flex:1;min-height:0;overflow:auto;padding:20px 22px 10px;display:flex;flex-direction:column}
        .thread{width:100%;max-width:740px;margin:0 auto;min-height:100%;display:flex;flex-direction:column;gap:26px;font-size:.8rem;line-height:1.7}
        @keyframes message-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .message{display:flex;animation:message-in .3s cubic-bezier(0.16,1,0.3,1) both}
        .message.user{justify-content:flex-end}
        .user-bubble{max-width:78%;background:var(--mono-selected);color:var(--color-textPrimary);padding:11px 16px;border-radius:16px 4px 16px 16px;font-size:.8rem;line-height:1.7;overflow-wrap:anywhere}
        .assistant-response{width:100%;min-width:0;display:flex;flex-direction:column;gap:10px}
        .assistant-label{display:inline-flex;align-items:center;gap:7px;font-size:.7rem;color:var(--color-textPrimary);font-weight:600;font-family:var(--font-family-serif)}
        .assistant-label>.material-symbol{color:var(--color-textTertiary)}
        .assistant-label em{font-style:normal;font-size:.6rem;color:var(--color-textTertiary);font-weight:400;margin-left:2px}

        /* 助手回答：无卡片、无边框、无阴影，纯文本块直接坐在页面上 */
        .answer-block{display:flex;flex-direction:column;color:var(--color-textSecondary)}
        .answer-loading,.dialog-loading,.loading-state{display:inline-flex;align-items:center;gap:8px;color:var(--color-textTertiary);font-size:.72rem;padding:4px 0}
        .answer-actions{display:flex;align-items:center;gap:2px;margin-top:10px;transition:opacity .15s var(--ease-smooth)}
        .answer-actions button{width:30px;height:30px;border:0;background:transparent;border-radius:8px;cursor:pointer;color:var(--color-textTertiary);display:grid;place-items:center;transition:background .15s var(--ease-smooth),color .15s var(--ease-smooth)}
        .answer-actions button:hover{background:var(--mono-hover);color:var(--color-textPrimary)}
        .answer-actions button.selected{color:var(--mono-ink)}
        /* Claude 式：操作钮 hover 才显现；有反馈 / 生成中 / 触屏 / 键盘焦点时常显 */
        @media(hover:hover){
          .answer-actions{opacity:0}
          .message.assistant:hover .answer-actions,.answer-actions:focus-within,
          .answer-actions.has-selected,.answer-actions.is-streaming{opacity:1}
        }

        /* 活动轨迹：覆盖 ActivityTrace 的卡片式默认样式，收成一行极简折叠（仅本页生效） */
        .thread .trace-panel{border:0;background:transparent;border-radius:10px;margin-bottom:0;overflow:visible}
        .thread .trace-panel>summary{padding:3px 6px;margin-left:-6px;font-size:.65rem;color:var(--color-textTertiary);border-radius:8px;transition:background .15s var(--ease-smooth),color .15s var(--ease-smooth)}
        .thread .trace-panel>summary:hover{background:var(--mono-hover);color:var(--color-textSecondary)}
        .thread .trace-panel[open]>summary{border-bottom:0}
        .thread .trace-panel .trace-title{font-weight:600}
        .thread .trace-panel:not([open]) .trace-time{display:none}
        .thread .trace-steps{margin-top:4px;padding:10px 12px;border:1px solid var(--mono-hairline);border-radius:12px;background:var(--color-surface,#fff)}
        .thread .trace-step.completed>.material-symbol{color:var(--mono-ink)}

        /* 引用行的配色与字号由 CitationList 自身按规格提供（小号链接行、规格蓝），此处不再覆盖 */

        /* 欢迎墙：居中衬线问候 + 居中 composer + 三张中性建议卡（垂直居中于视口中上部） */
        .welcome-state{margin:auto 0;padding:8px 8px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--color-textSecondary)}
        /* 首页合并后的欢迎墙：logo 与时间问候语同行居中（用户指定） */
        .welcome-hello{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:10px}
        .welcome-logo{width:42px;height:42px;border-radius:10px;flex:0 0 42px}
        .welcome-title{margin:0;font-size:2rem;font-weight:600;color:var(--color-textPrimary);font-family:var(--font-family-serif);letter-spacing:.01em}
        .welcome-state .dock,.welcome-quick,.welcome-state .pending-attachments,.welcome-state .composer-note{width:100%}
        .welcome-state .dock textarea{min-height:84px}
        /* 快捷问题（原首页迁入）：中性建议卡 */
        /* 快捷问题：强制单行（容器 nowrap + 按钮均分收缩），图标不参与收缩保证完整 */
        .welcome-quick{display:flex;flex-wrap:nowrap;justify-content:center;gap:10px;margin-top:22px;max-width:100%}
        .welcome-quick button{display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:1 1 0;min-width:0;max-width:220px;background:var(--mono-panel);border:1px solid var(--mono-hairline);border-radius:12px;padding:10px 12px;font-size:13px;color:var(--color-textSecondary);cursor:pointer;font-family:inherit;transition:background .18s var(--ease-spring),box-shadow .18s var(--ease-spring),color .18s var(--ease-spring)}
        .welcome-quick button>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .welcome-quick button:hover{background:var(--color-surface,#fff);box-shadow:var(--mono-shadow-card);color:var(--color-textPrimary)}
        .welcome-quick button>.material-symbol{color:var(--color-textTertiary);flex:0 0 auto}

        /* 输入区：白底 hairline + composer 阴影，聚焦切 composer-focus 阴影（不跳版，规格 §3）；
           圆角会话态 16px、欢迎墙居中态 24px；发送键近黑圆形 */
        .dock-wrap{padding:8px 22px 14px}
        .dock{background:var(--color-surface,#fff);border:1px solid var(--mono-hairline);border-radius:16px;box-shadow:var(--mono-shadow-composer);padding:10px 10px 8px 12px;display:flex;flex-direction:column;align-items:stretch;gap:2px;max-width:740px;margin:0 auto;transition:box-shadow .2s var(--ease-smooth)}
        .dock-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}
        .dock-tools{display:flex;align-items:center;gap:2px}
        .dock-right{display:flex;align-items:center;gap:10px}
        /* 单按钮循环档位（合并三个模式，点击切换） */
        .mode-tab{border:0;background:transparent;padding:5px 2px;border-radius:8px;font-size:.72rem;color:var(--color-textTertiary);cursor:pointer;font-family:inherit;transition:color .15s var(--ease-smooth)}
        .mode-tab:hover{color:var(--color-textPrimary)}
        .mode-tab.on{color:var(--mono-ink);font-weight:700}
        .welcome-state .dock{border-radius:24px}
        .dock:focus-within{box-shadow:var(--mono-shadow-composer-focus)}
        .composer-tool{width:38px;height:38px;border:0;border-radius:10px;background:transparent;cursor:pointer;color:var(--color-textTertiary);display:grid;place-items:center;flex:0 0 38px;transition:background .15s var(--ease-smooth),color .15s var(--ease-smooth)}
        .composer-tool:hover{background:var(--mono-hover);color:var(--color-textPrimary)}
        .composer-tool:disabled{opacity:.4;cursor:not-allowed}
        .composer-tool.recording{background:var(--mono-selected);color:var(--mono-ink);animation:pulse-rec 1.3s var(--ease-smooth) infinite}
        @keyframes pulse-rec{0%,100%{opacity:1}50%{opacity:.5}}
        .composer-tool.on{background:var(--mono-hover);color:var(--color-textPrimary)}

        /* 附件小窗：+ 按钮弹出，锚定按钮上方（白卡 hairline 描边 + composer 阴影；
           入场复用 message-in 关键帧）；欢迎墙 / 会话两态同用 */
        .attach-anchor{position:relative;display:inline-flex}
        .attach-pop{position:absolute;left:0;bottom:calc(100% + 10px);width:280px;background:var(--color-surface,#fff);border:1px solid var(--color-borderPrimary);border-radius:14px;box-shadow:var(--mono-shadow-composer);padding:14px;display:flex;flex-direction:column;gap:10px;text-align:left;z-index:40;animation:message-in .28s var(--ease-spring) both}
        .attach-close{position:absolute;top:8px;right:8px;width:24px;height:24px;border:0;background:transparent;border-radius:9999px;cursor:pointer;color:var(--color-textTertiary);display:grid;place-items:center;transition:background .15s var(--ease-smooth),color .15s var(--ease-smooth)}
        .attach-close:hover{background:var(--color-primarySoft);color:var(--color-textPrimary)}
        /* 主按钮照 .new-chat 近黑实底胶囊规格；material-symbol 需高特异度钉成主钮配对字色（同 .send-button） */
        .attach-pick{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;border:1px solid var(--color-primary);background:var(--color-primary);color:var(--color-primary-foreground);border-radius:10px;padding:0 14px;font-size:.72rem;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s var(--ease-smooth)}
        .attach-pick:hover{background:var(--color-accentHover,var(--color-primary));border-color:var(--color-accentHover,var(--color-primary))}
        .attach-pick .material-symbol{color:var(--color-primary-foreground)}
        .attach-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:132px;overflow:auto}
        .attach-list li{display:flex;align-items:center;gap:6px;background:var(--color-bgSecondary);border:1px solid var(--color-borderPrimary);border-radius:8px;padding:5px 8px;font-size:.625rem;color:var(--color-textSecondary)}
        .attach-list li>.material-symbol{color:var(--color-textTertiary);flex:0 0 auto}
        .attach-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .attach-list button{display:grid;place-items:center;width:18px;height:18px;flex:0 0 18px;border:0;background:transparent;color:var(--color-textTertiary);cursor:pointer;border-radius:9999px;transition:background .15s var(--ease-smooth),color .15s var(--ease-smooth)}
        .attach-list button:hover{background:var(--color-primarySoft);color:var(--color-danger)}
        .attach-hint{margin:0;font-size:.575rem;color:var(--color-textTertiary);line-height:1.6}
        .dock textarea{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:.8rem;line-height:1.65;padding:9px 4px;resize:none;max-height:160px;color:var(--color-textPrimary)}
        .dock textarea::placeholder{color:var(--color-textDisabled)}
        .send-button{width:38px;height:38px;border:0;border-radius:9999px;background:var(--mono-ink);color:var(--color-primary-foreground);cursor:pointer;display:grid;place-items:center;flex:0 0 38px;transition:background .15s var(--ease-smooth)}
        /* .chat-workbench button 的 color:inherit 重置特异性更高，需更高特异度把箭头钉成主钮配对字色（night 反白时换深字） */
        .send-button .material-symbol{color:var(--color-primary-foreground)}
        .send-button:hover{background:var(--mono-ink-hover)}
        .send-button:disabled{opacity:.45;cursor:not-allowed}
        .visually-hidden{display:none}
        .pending-attachments{display:flex;flex-wrap:wrap;gap:6px;max-width:740px;margin:6px auto 0}
        .pending-attachments>span{display:inline-flex;align-items:center;gap:5px;background:var(--mono-panel);border:1px solid var(--mono-hairline);border-radius:9999px;padding:4px 10px;font-size:.625rem;color:var(--color-textSecondary)}
        .pending-attachments button{display:grid;place-items:center;width:18px;height:18px;border:0;background:transparent;color:var(--color-textTertiary);cursor:pointer;border-radius:9999px}
        .pending-attachments button:hover{background:var(--mono-hover);color:var(--color-danger)}
        .composer-note{max-width:740px;margin:14px auto 0;text-align:center;font-size:.525rem;color:var(--color-textTertiary);line-height:1.6;flex:0 0 auto}

        .rename-input{width:100%;border:1px solid var(--mono-hairline);border-radius:12px;padding:9px 12px;font-size:.8rem;margin-top:8px;outline:none;color:var(--color-textPrimary);background:var(--color-surface,#fff)}
        .rename-input:focus{border-color:var(--color-ring);box-shadow:0 0 0 3px var(--color-primarySoft)}

        /* 加载态：thinking-dots 三点跳动 1.4s（规格 §2，根治无限旋转图标） */
        .thinking-dots{display:inline-flex;align-items:center;gap:3px;height:16px;flex:0 0 auto}
        .thinking-dots>span{width:4px;height:4px;border-radius:9999px;background:currentColor;opacity:.3;animation:thinking-dot 1.4s var(--ease-smooth) infinite}
        .thinking-dots>span:nth-child(2){animation-delay:.15s}
        .thinking-dots>span:nth-child(3){animation-delay:.3s}
        @keyframes thinking-dot{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}

        @media(prefers-reduced-motion:reduce){
          .thinking-dots>span,.composer-tool.recording,.message,.attach-pop,.conversation-rail,.rail-mask{animation:none}
          .dock,.answer-actions,.row-more,.chat-tool,.composer-tool,.welcome-card,.text-tool-btn,.conversation-row,.rail-close,.history-search,.attach-close,.attach-pick,.attach-list button{transition:none}
        }

        @media(max-width:760px){
          .chat-toolbar{padding:8px 10px}
          .chat-scroll{padding:14px 12px 6px}
          .thread,.dock,.pending-attachments,.composer-note{max-width:none}
          .user-bubble{max-width:88%}
          .composer-tool{width:34px;height:34px;flex:0 0 34px}
          .send-button{width:36px;height:36px;flex:0 0 36px}
          .dock-wrap{padding:6px 10px 10px}
          .welcome-title{font-size:1.5rem}
          .welcome-actions{grid-template-columns:1fr}
          .welcome-state{padding-bottom:8vh}
          /* 历史 rail 改右侧 fixed overlay：脱离 flex 流，主区不再被挤压；
             遮罩半透明盖住主区，点遮罩关闭（rail-mask 基础规则 display:none） */
          .rail-mask{display:block;position:fixed;inset:0;z-index:44;background:color-mix(in srgb,var(--color-black) 42%,transparent);animation:mask-in .2s var(--ease-smooth) both}
          .conversation-rail{position:fixed;top:0;right:0;bottom:0;height:auto;flex:none;z-index:45;box-shadow:-18px 0 44px color-mix(in srgb,var(--color-black) 18%,transparent);animation:rail-in .28s var(--ease-spring) both}
          /* 触控目标 ≥44px：小钮不动视觉尺寸，用 ::after 伪元素扩可点区
             （36+8 / 34+10 / 26+18 / 30+14；绝对定位伪元素参与命中测试）；
             漏网小钮一并补足：附件小窗关闭 24+10、问诊模式档位 30+7（伪元素扩区），
             18px 附件移除钮视觉同步放大到 24px 再扩区 44（px 定值，不受 20px 根字号 rem 放大影响）。
             .attach-close 本身 position:absolute（可作伪元素包含块），不得并入下方 relative 组 */
          .chat-tool,.composer-tool,.row-more,.answer-actions button,.mode-tab,.attach-list button,.pending-attachments button{position:relative}
          .chat-tool::after{content:'';position:absolute;inset:-4px;border-radius:14px}
          .composer-tool::after{content:'';position:absolute;inset:-5px;border-radius:12px}
          .row-more::after{content:'';position:absolute;inset:-9px;border-radius:8px}
          .answer-actions button::after{content:'';position:absolute;inset:-7px;border-radius:10px}
          .attach-close::after{content:'';position:absolute;inset:-10px;border-radius:9999px}
          .mode-tab::after{content:'';position:absolute;inset:-7px;border-radius:12px}
          .attach-list button{width:24px;height:24px;flex:0 0 24px}
          .attach-list button::after{content:'';position:absolute;inset:-10px;border-radius:9999px}
          .pending-attachments button{width:24px;height:24px}
          .pending-attachments button::after{content:'';position:absolute;inset:-10px;border-radius:9999px}
          .rail-close{width:44px;height:44px}
        }
        /* ≤480 手机：附件小窗与欢迎墙胶囊自适应（≥481 走上方通用规则） */
        @media(max-width:480px){
          /* 附件小窗：锚点让位改以 dock 为定位基准，左右 8px 自适应，窄屏不再贴边溢出 */
          .attach-anchor{position:static}
          .dock{position:relative}
          .attach-pop{left:8px;right:8px;bottom:calc(100% + 8px);width:auto}
          /* 欢迎墙 4 胶囊：仅缩 padding/gap 保证 360px 单行不溢出
             （flex-wrap:nowrap + flex:1 1 0 均分单行布局不动，文字仍 ellipsis） */
          .welcome-quick{gap:8px}
          .welcome-quick button{padding:10px 8px;gap:6px}
        }
        @media print{
          .chat-toolbar,.dock-wrap,.trace-panel,.answer-actions,.welcome-state,.conversation-rail,.rail-mask{display:none!important}
          .chat-workbench{display:block}
          .chat-scroll{overflow:visible;padding:0}
          .thread{max-width:none;min-height:0}
          .message{break-inside:avoid}
        }
      `}</style>
    </div>
  )
}
