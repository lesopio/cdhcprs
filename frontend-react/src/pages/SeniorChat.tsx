/**
 * 长辈模式（重做版）。
 *
 * 交互流程（产品定义）：
 * 1. 入口态：页面居中一颗「光球」（CSS 径向渐变 + 呼吸动画，prefers-reduced-motion 停用；
 *    点击光球 = 真实语音输入：MediaRecorder 录音 → /api/media/asr 转写 → 文本填入输入框；
 *    asr 未配置时点击只 toast 提示。录音中光球加速脉动并显示「正在听…」），
 *    下方大号输入框提交主诉；输入框左侧「+」按钮可选图片（转 data URL 随请求直传，
 *    不依赖会话），已选图片以缩略 chip 展示、可移除。
 * 2. 问答态：后端 /api/senior/question 依据主诉 + 历史问答 + triageData.json 分诊摘要
 *    （+ 可选图片 VL 观察 + 可选网络检索）生成下一问（question/options/multi/tip）。
 *    每问一张卡片：顶部进度（第 N 问 / 约 6 问）、问题旁「朗读」按钮（/api/media/tts/text，
 *    tts 未配置时点击 toast）、中部整行大选项按钮（单选/多选）+ 「其他/补充说明」自由输入框
 *    （左侧同款「+」可换图）+ 底部该问题的口语科普 tip。
 * 3. 问满 6 问或随时点「生成健康报告」：/api/senior/report 汇总 markdown 报告，本页渲染；
 *    报告标题旁「朗读」按钮可整篇口播（自动剥掉 markdown 符号与参考来源链接）。
 *
 * 能力开关统一来自 /api/public/settings（asr/tts/vl_available 与张数、大小、录音时长上限）。
 * 视觉约定：全部 var(--color-*)，单栏居中 max-width 680px，按钮 min-height 56px。
 * 字号：进入强制 extra-large，离开还原进入前档位（沿用旧实现的行为）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import api from '@/api/client'
import MaterialIcon from '@/components/MaterialIcon'
import MarkdownRenderer from '@/components/MarkdownRenderer'
import { seniorAPI, buildTriageContext, type SeniorHistoryItem, type SeniorQuestionResult } from '@/api/senior'
import { consumeSseResponse } from '@/lib/sse'
import { useSeniorVoice } from '@/hooks/useSeniorVoice'
import { notify } from '@/lib/toast'
import { useSettingsStore, type FontSizeMode } from '@/stores/settings'

/** 问满轮数：问满即自动生成报告 */
const MAX_QUESTIONS = 6

type Phase = 'entry' | 'thinking' | 'asking' | 'reporting' | 'report' | 'history'

/** 思维链步骤（后端 stage 事件；skipped 前端过滤不渲染） */
interface ChainStep {
  id: string
  title: string
  status: 'running' | 'completed' | 'skipped' | 'failed' | string
  summary?: string
}

/** 思维链步骤图标（senior 简版映射） */
const CHAIN_ICONS: Record<string, string> = {
  understand: 'person_search',
  web: 'travel_explore',
  mirror: 'cloud_done',
  authoritative: 'verified',
  organize: 'edit_note',
}

/** 引用条目（citations 事件 payload） */
interface SeniorCitation {
  id: number
  source: string
  title: string
  url: string
  snippet?: string
}

interface SeniorError {
  kind: 'question' | 'report'
  message: string
}

/** /api/public/settings 的能力开关（与 Chat.tsx 的 Capabilities 同源字段） */
interface SeniorCapabilities {
  asr_available: boolean
  tts_available: boolean
  vl_available: boolean
  asr_max_seconds: number
  vl_max_images: number
  vl_max_image_mb: number
}
const DEFAULT_CAPABILITIES: SeniorCapabilities = {
  asr_available: false, tts_available: false, vl_available: false,
  asr_max_seconds: 60, vl_max_images: 4, vl_max_image_mb: 10,
}

/** 后端与问诊页同口径：仅收这三种图片（senior.py _decode_images 同名单） */
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

interface PendingImage {
  name: string
  dataUrl: string
}

/** File → data URL（base64 直传后端，不经会话附件接口） */
const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })

/** 问题卡口播文本：问题 + 选项 + 科普（长辈不用逐字看） */
const questionToSpeech = (q: SeniorQuestionResult) =>
  [q.question, q.options.length ? `选项有：${q.options.join('，')}` : '', q.tip]
    .filter(Boolean)
    .join('。')

/** 报告口播文本：剥 markdown 符号、截掉参考来源附录、去掉 [n] 编号标记 */
const reportToSpeech = (md: string) =>
  (md.split(/^###?\s*参考来源\s*$/m)[0] || md)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_~>|]+/g, '')
    .replace(/\[\d+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export default function SeniorChat() {
  const setFontSizeMode = useSettingsStore((s) => s.setFontSizeMode)
  // 进入长辈模式前的字号档位：离开时还原它，而不是写死 normal
  //（用户若本就开着 large / extra-large，不应被长辈模式「降档」）
  const prevFontSizeRef = useRef<FontSizeMode>(useSettingsStore.getState().fontSizeMode)

  const [phase, setPhase] = useState<Phase>('entry')
  const [chief, setChief] = useState('')
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState<SeniorHistoryItem[]>([])
  const [current, setCurrent] = useState<SeniorQuestionResult | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [freeText, setFreeText] = useState('')
  const [report, setReport] = useState('')
  const [error, setError] = useState<SeniorError | null>(null)

  // 长辈问诊历史（与普通问诊分离：consultation_mode='senior' 的会话）
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [pastSessions, setPastSessions] = useState<Array<{ id: number; title: string; created_at: string }>>([])
  const [historyView, setHistoryView] = useState<{ title: string; messages: Array<{ id: number; role: string; content: string }> } | null>(null)

  // 思维链 + 流式：左侧时间线步骤、模型思考流式文本、右侧题目/报告流式文本
  const [chain, setChain] = useState<ChainStep[]>([])
  /* ≤979 折叠条开关：默认收起仅留一行状态（手机先看题目，不滚过整块思维链），
     点头部展开；≥980 桌面由 CSS 强制展开、忽略此状态 */
  const [chainOpen, setChainOpen] = useState(false)
  const [thinking, setThinking] = useState('')
  const [streamedQuestion, setStreamedQuestion] = useState('')
  const [streamedReport, setStreamedReport] = useState('')
  const [citations, setCitations] = useState<SeniorCitation[]>([])
  // 用户在思考容器内上滚后暂停自动跟随（滚回底部恢复）
  const thoughtBoxRef = useRef<HTMLDivElement | null>(null)
  const thoughtAutoScrollRef = useRef(true)

  // 能力开关（asr/tts/vl 可用性与限额）：挂载时拉一次 /api/public/settings
  const [capabilities, setCapabilities] = useState<SeniorCapabilities>(DEFAULT_CAPABILITIES)
  // 本轮待发送图片（data URL 直传，提交后清空；仅作问诊参考，不进会话库）
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])

  // 发送守卫：LLM 生成耗时以十秒计，双击/回车+点击齐发必须用同步 ref 硬挡
  //（比照旧实现 submittingRef 的做法，state 在同一事件循环里读两次是旧值）
  const busyRef = useRef(false)
  const mainRef = useRef<HTMLDivElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  // 分诊依据摘要只构建一次（9 分类 / 36 疾病 / 229 证型，截断到 4000 字）
  const triageContext = useMemo(() => buildTriageContext(), [])

  // 语音输入 + 朗读：转写文本按当前阶段填进主诉框（entry）或补充说明框（其余阶段）
  const phaseRef = useRef<Phase>(phase)
  useEffect(() => { phaseRef.current = phase }, [phase])
  const {
    recording, transcribing, toggleRecording,
    speakingKey, toggleSpeak,
  } = useSeniorVoice({
    asrAvailable: capabilities.asr_available,
    ttsAvailable: capabilities.tts_available,
    maxSeconds: capabilities.asr_max_seconds,
    onTranscribed: (text) => {
      if (!text) return
      if (phaseRef.current === 'entry') setDraft((prev) => (prev ? `${prev} ${text}` : text))
      else setFreeText((prev) => (prev ? `${prev} ${text}` : text))
    },
  })

  // 进入长辈模式即强制超大字号；离开时还原进入前的档位
  useEffect(() => {
    const restoreTo = prevFontSizeRef.current
    setFontSizeMode('extra-large')
    return () => setFontSizeMode(restoreTo)
  }, [setFontSizeMode])

  // 挂载拉一次公共设置：asr/tts/vl 可用性与张数、大小、录音时长上限（同 Chat 页数据源）
  useEffect(() => {
    let cancelled = false
    api.get('/api/public/settings').then(({ data }) => {
      if (cancelled) return
      const s = (data ?? {}) as Partial<SeniorCapabilities>
      setCapabilities({
        asr_available: !!s.asr_available,
        tts_available: !!s.tts_available,
        vl_available: !!s.vl_available,
        asr_max_seconds: Number(s.asr_max_seconds) || DEFAULT_CAPABILITIES.asr_max_seconds,
        vl_max_images: Number(s.vl_max_images) || DEFAULT_CAPABILITIES.vl_max_images,
        vl_max_image_mb: Number(s.vl_max_image_mb) || DEFAULT_CAPABILITIES.vl_max_image_mb,
      })
    }).catch(() => { /* 拦截器已提示；能力开关保持默认关 */ })
    return () => { cancelled = true }
  }, [])

  // 阶段/问题切换时回到顶部，长辈不需要自己找滚动条
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [phase, current])

  /** 思考容器：内容增长时自动跟随底部（用户上滚则暂停，滚回底部恢复） */
  useEffect(() => {
    const box = thoughtBoxRef.current
    if (!box || !thoughtAutoScrollRef.current) return
    box.scrollTop = box.scrollHeight
  }, [thinking, chain])

  const onThoughtScroll = () => {
    const box = thoughtBoxRef.current
    if (!box) return
    thoughtAutoScrollRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48
  }

  /** 重置思维链/流式状态（每轮生成前调用） */
  const resetStreamState = useCallback(() => {
    setChain([])
    setThinking('')
    setStreamedQuestion('')
    setStreamedReport('')
    thoughtAutoScrollRef.current = true
  }, [])

  /** 拉取长辈问诊历史（入口态列表；consultation_mode==='senior' 的会话） */
  const loadPastSessions = useCallback(async () => {
    try {
      const { data } = await api.get('/api/chat/conversations')
      const list: any[] = Array.isArray(data) ? data : (data?.items ?? [])
      setPastSessions(
        list
          .filter((c) => c.consultation_mode === 'senior')
          .slice(0, 6)
          .map((c) => ({ id: c.id, title: c.title || '长辈问诊', created_at: c.created_at || '' })),
      )
    } catch {
      setPastSessions([])
    }
  }, [])

  // 入口态挂载/返回时刷新历史
  useEffect(() => {
    if (phase === 'entry') void loadPastSessions()
  }, [phase, loadPastSessions])

  /** 打开一条历史问诊：拉取消息列表进入只读回看 */
  const openHistorySession = useCallback(async (id: number) => {
    try {
      const { data: conv } = await api.get(`/api/chat/conversations/${id}`)
      const { data: msgs } = await api.get(`/api/chat/conversations/${id}/messages`)
      setHistoryView({
        title: (conv as any)?.title || '长辈问诊',
        messages: (Array.isArray(msgs) ? msgs : []).map((m: any) => ({
          id: m.id, role: m.role, content: m.content || '',
        })),
      })
      setPhase('history')
    } catch {
      notify.error('历史问诊加载失败')
    }
  }, [])

  /** 统一 SSE 事件处理：stage/thinking/question/report/citations/error/done */
  const consumeSeniorStream = useCallback(async (
    response: Response,
    handlers: {
      onStage: (step: ChainStep) => void
      onThinking: (delta: string) => void
      onQuestionDelta: (delta: string) => void
      onQuestion: (q: SeniorQuestionResult & { number: number; total: number }) => void
      onReportDelta: (delta: string) => void
      onReport: (report: string) => void
      onCitations?: (items: SeniorCitation[]) => void
      onError: (message: string) => void
      onDone?: () => void
    },
    signal?: AbortSignal,
  ) => {
    await consumeSseResponse(response, {
      onEvent: (event, data) => {
        const d = (data ?? {}) as Record<string, unknown>
        switch (event) {
          case 'stage':
            handlers.onStage(d as unknown as ChainStep)
            break
          case 'thinking.delta':
            handlers.onThinking(String(d.delta || ''))
            break
          case 'question.delta':
            handlers.onQuestionDelta(String(d.delta || ''))
            break
          case 'question':
            handlers.onQuestion({
              question: String(d.question || ''),
              options: Array.isArray(d.options) ? d.options.map(String) : [],
              multi: !!d.multi,
              tip: String(d.tip || ''),
              number: Number(d.number) || 1,
              total: Number(d.total) || MAX_QUESTIONS,
            })
            break
          case 'report.delta':
            handlers.onReportDelta(String(d.delta || ''))
            break
          case 'report':
            handlers.onReport(String(d.report || ''))
            break
          case 'citations':
            handlers.onCitations?.(Array.isArray(d.items) ? (d.items as SeniorCitation[]) : [])
            break
          case 'error':
            handlers.onError(String(d.message || '生成失败'))
            break
          case 'done':
            handlers.onDone?.()
            break
        }
      },
      onError: (err) => {
        handlers.onError((err as Error)?.message || '连接中断')
      },
    }, signal)
  }, [])

  const fetchQuestion = useCallback(async (historySoFar: SeniorHistoryItem[], chiefText: string, images: string[] = [], sessionIdOverride?: number | null) => {
    const activeSessionId = sessionIdOverride ?? sessionId
    setPhase('thinking')
    setError(null)
    resetStreamState()
    try {
      const response = await seniorAPI.streamSeniorQuestion({
        chief_complaint: chiefText,
        history: historySoFar,
        triage_context: triageContext,
        images: images.length ? images : undefined,
        session_id: activeSessionId ?? undefined,
      })
      await consumeSeniorStream(response, {
        onStage: (step) => setChain((prev) => {
          const next = prev.filter((s) => s.id !== step.id)
          next.push(step)
          return next
        }),
        onThinking: (delta) => setThinking((prev) => prev + delta),
        onQuestionDelta: (delta) => setStreamedQuestion((prev) => prev + delta),
        onQuestion: (q) => {
          setCurrent({ question: q.question, options: q.options, multi: q.multi, tip: q.tip })
          setSelected([])
          setFreeText('')
          setPhase('asking')
          // 题目落库（assistant=题目+科普要点）
          if (activeSessionId) {
            void seniorAPI.saveSeniorMessage(
              activeSessionId, 'assistant',
              [q.question, q.tip ? `【为什么这么问】${q.tip}` : ''].filter(Boolean).join('\n\n'),
            ).catch(() => {})
          }
        },
        onReportDelta: () => {},
        onReport: () => {},
        onCitations: (items) => setCitations(items),
        onError: (message) => {
          setError({ kind: 'question', message })
          setPhase('asking')
        },
      }, undefined)
    } catch (err: any) {
      setError({ kind: 'question', message: err?.message || '问题生成失败' })
      setPhase('asking')
    }
  }, [triageContext, consumeSeniorStream, resetStreamState, sessionId])

  const generateReport = useCallback(async (historyAll: SeniorHistoryItem[], chiefText: string, images: string[] = []) => {
    setPhase('reporting')
    setError(null)
    resetStreamState()
    setReport('')
    try {
      const response = await seniorAPI.streamSeniorReport({
        chief_complaint: chiefText,
        history: historyAll,
        images: images.length ? images : undefined,
      })
      await consumeSeniorStream(response, {
        onStage: (step) => setChain((prev) => {
          const next = prev.filter((s) => s.id !== step.id)
          next.push(step)
          return next
        }),
        onThinking: (delta) => setThinking((prev) => prev + delta),
        onQuestionDelta: () => {},
        onQuestion: () => {},
        onReportDelta: (delta) => setStreamedReport((prev) => prev + delta),
        onReport: (full) => {
          setReport(full)
          setPhase('report')
          // 报告落库（assistant=报告全文）
          if (sessionId) {
            void seniorAPI.saveSeniorMessage(sessionId, 'assistant', full).catch(() => {})
          }
        },
        onCitations: (items) => setCitations(items),
        onError: (message) => {
          setError({ kind: 'report', message })
          setPhase('report')
        },
      }, undefined)
    } catch (err: any) {
      setError({ kind: 'report', message: err?.message || '报告生成失败' })
      setPhase('report')
    }
  }, [consumeSeniorStream, resetStreamState, sessionId])

  const submitChief = async () => {
    const text = draft.trim()
    if (!text || busyRef.current) return
    busyRef.current = true
    setChief(text)
    setHistory([])
    setCurrent(null)
    setReport('')
    setDraft('')
    const images = pendingImages.map((img) => img.dataUrl)
    setPendingImages([])
    try {
      // 创建长辈问诊会话（历史分离），失败不阻断生成（仅不落库）；
      // id 立即透传给 fetchQuestion（setState 异步，闭包拿到的是旧值）
      const created = await seniorAPI.createSeniorSession(text).catch(() => null)
      const sid = created?.data?.id ?? null
      setSessionId(sid)
      if (sid) await seniorAPI.saveSeniorMessage(sid, 'user', text).catch(() => {})
      await fetchQuestion([], text, images, sid)
    } finally {
      busyRef.current = false
    }
  }

  const submitAnswer = async () => {
    if (!current || busyRef.current) return
    const picked = selected.join('、')
    const extra = freeText.trim()
    const answer = [picked, extra ? `补充：${extra}` : ''].filter(Boolean).join('；')
    if (!answer) return
    busyRef.current = true
    const nextHistory = [...history, { question: current.question, answer }]
    setHistory(nextHistory)
    setCurrent(null)
    setFreeText('')
    const images = pendingImages.map((img) => img.dataUrl)
    setPendingImages([])
    // 答案落库（user=用户回答）
    if (sessionId) void seniorAPI.saveSeniorMessage(sessionId, 'user', answer).catch(() => {})
    try {
      if (nextHistory.length >= MAX_QUESTIONS) {
        await generateReport(nextHistory, chief, images)
      } else {
        await fetchQuestion(nextHistory, chief, images)
      }
    } finally {
      busyRef.current = false
    }
  }

  const startReport = async () => {
    if (busyRef.current) return
    busyRef.current = true
    const images = pendingImages.map((img) => img.dataUrl)
    setPendingImages([])
    try {
      await generateReport(history, chief, images)
    } finally {
      busyRef.current = false
    }
  }

  const restart = () => {
    if (busyRef.current) return
    setPhase('entry')
    setChief('')
    setDraft('')
    setHistory([])
    setCurrent(null)
    setSelected([])
    setFreeText('')
    setReport('')
    setError(null)
    setPendingImages([])
    setSessionId(null)
    setHistoryView(null)
  }

  const toggleOption = (label: string) => {
    setSelected((prev) =>
      current?.multi
        ? (prev.includes(label) ? prev.filter((item) => item !== label) : [...prev, label])
        : [label],
    )
  }

  /** 「+」选图：校验类型/大小/剩余张数 → data URL → 待发 chip（同问诊页小窗交互） */
  const onImagesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (imageInputRef.current) imageInputRef.current.value = ''
    if (!fileList || !fileList.length) return
    const room = capabilities.vl_max_images - pendingImages.length
    if (room <= 0) {
      notify.info(`一次最多带 ${capabilities.vl_max_images} 张图片`)
      return
    }
    const picked: PendingImage[] = []
    let overflowNotified = false
    for (const file of Array.from(fileList)) {
      if (picked.length >= room) {
        if (!overflowNotified) {
          notify.info(`一次最多带 ${capabilities.vl_max_images} 张图片，多余的没有选上`)
          overflowNotified = true
        }
        break
      }
      if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
        notify.error('只能选择 JPEG、PNG 或 WebP 图片')
        continue
      }
      if (file.size > capabilities.vl_max_image_mb * 1024 * 1024) {
        notify.error(`${file.name} 超过 ${capabilities.vl_max_image_mb}MB 限制`)
        continue
      }
      try {
        picked.push({ name: file.name, dataUrl: await fileToDataUrl(file) })
      } catch {
        notify.error(`${file.name} 读取失败，请重试`)
      }
    }
    if (picked.length) setPendingImages((prev) => [...prev, ...picked])
  }

  const addPhotoButton = capabilities.vl_available && (
    <button
      type="button"
      className="senior-tool-btn"
      title="添加照片"
      aria-label="添加照片"
      onClick={() => imageInputRef.current?.click()}
    >
      <MaterialIcon name="add" size={24} />
    </button>
  )

  const pendingBlock = pendingImages.length > 0 && (
    <div className="senior-pending" aria-label="已选择的图片">
      {pendingImages.map((img, idx) => (
        <span key={`${img.name}-${idx}`} className="senior-pending-chip">
          <img src={img.dataUrl} alt="" />
          <em>{img.name}</em>
          <button
            type="button"
            aria-label={`移除图片 ${img.name}`}
            onClick={() => setPendingImages((prev) => prev.filter((_, i) => i !== idx))}
          >
            <MaterialIcon name="close" size={20} />
          </button>
        </span>
      ))}
    </div>
  )

  const answerReady = selected.length > 0 || freeText.trim().length > 0
  const questionNumber = Math.min(history.length + 1, MAX_QUESTIONS)
  const progressPercent = Math.min(100, Math.round((questionNumber / MAX_QUESTIONS) * 100))
  const visibleChain = chain.filter((s) => s.status !== 'skipped')
  const chainRunning = visibleChain.some((s) => s.status === 'running')

  return (
    <div className="senior-view">
      {/* 顶栏已按需求移除（侧栏可切换模式），内容区全屏解放 */}

      {/* 隐藏选图控件：入口态与问答态的「+」共用（同问诊页小窗交互） */}
      <input
        ref={imageInputRef}
        className="senior-hidden-input"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        onChange={onImagesSelected}
      />

      <main className="senior-main" ref={mainRef}>
        {phase === 'entry' && (
          <div className="senior-column">
            <section className="senior-hero">
              <button
                type="button"
                className={`senior-orb${recording ? ' recording' : ''}`}
                aria-label={recording ? '停止录音' : '语音输入'}
                disabled={transcribing}
                onClick={() => void toggleRecording()}
              >
                {/* 光影流动：四层各自独立动画（高光漂移/暗斑游走/底部光带摆动/外光晕呼吸） */}
                <span className="orb-layer orb-hi" aria-hidden="true" />
                <span className="orb-layer orb-shade" aria-hidden="true" />
                <span className="orb-layer orb-glow" aria-hidden="true" />
                <span className="senior-orb-halo" aria-hidden="true" />
              </button>
              {(recording || transcribing) && (
                <p className="senior-listening" role="status">
                  {recording ? (
                    <>
                      <span className="listening-waves" aria-hidden="true">
                        <span /><span /><span /><span />
                      </span>
                      正在听…
                    </>
                  ) : '正在识别您说的话…'}
                </p>
              )}
              {/* 输入框：普通模式同款 dock（两行式：输入上行 / 工具+发送下行），字号保持长辈档 */}
              <form
                className="senior-dock"
                onSubmit={(e) => { e.preventDefault(); void submitChief() }}
              >
                <textarea
                  className="senior-dock-input"
                  placeholder="哪里不舒服？用简单的话告诉我"
                  autoFocus
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="senior-dock-foot">
                  {addPhotoButton}
                  <button type="submit" className="senior-dock-send" disabled={!draft.trim()} aria-label="开始问诊">
                    <MaterialIcon name="arrow_upward" size={20} />
                  </button>
                </div>
              </form>
              {pendingBlock}
              {/* 快捷问题：普通模式同款胶囊（强制单行均分），点击填入输入框 */}
              <div className="senior-quick">
                {[
                  { icon: 'personal_injury', text: '膝盖疼' },
                  { icon: 'monitor_heart', text: '最近血压偏高' },
                  { icon: 'dark_mode', text: '长期睡不好头晕' },
                  { icon: 'bloodtype', text: '血糖波动大' },
                ].map((q) => (
                  <button key={q.text} type="button" onClick={() => setDraft((prev) => (prev ? `${prev} ${q.text}` : q.text))}>
                    <MaterialIcon name={q.icon} size={18} />
                    <span>{q.text}</span>
                  </button>
                ))}
              </div>

              {/* 长辈问诊历史（与普通问诊分离） */}
              {pastSessions.length > 0 && (
                <section className="senior-past" aria-label="过往问诊">
                  <h3 className="senior-past-title"><MaterialIcon name="history" size={24} />过往问诊</h3>
                  <div className="senior-past-list">
                    {pastSessions.map((s) => (
                      <button key={s.id} type="button" className="senior-past-item" onClick={() => void openHistorySession(s.id)}>
                        <span className="senior-past-name">{s.title}</span>
                        <span className="senior-past-date">{s.created_at ? s.created_at.slice(0, 10) : ''}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </section>
          </div>
        )}

        {phase === 'history' && historyView && (
          <div className="senior-column">
            <section className="senior-history-view">
              <h2 className="senior-history-title">
                <MaterialIcon name="history" size={28} />{historyView.title}
              </h2>
              <div className="senior-history-body">
                {historyView.messages.map((m) => (
                  <div key={m.id} className={`senior-history-msg ${m.role}`}>
                    <span className="senior-history-role">{m.role === 'user' ? '您' : '助手'}</span>
                    {m.role === 'assistant' && m.content.includes('## ') ? (
                      <div className="senior-history-md"><MarkdownRenderer content={m.content} /></div>
                    ) : (
                      <p>{m.content}</p>
                    )}
                  </div>
                ))}
              </div>
              <div className="senior-history-actions">
                <button type="button" className="senior-primary" onClick={restart}>
                  <MaterialIcon name="add" size={26} />开始新问诊
                </button>
              </div>
            </section>
          </div>
        )}

        {phase !== 'entry' && (
          <div className="senior-workspace">
            {/* 左栏：思维链时间线 + 思考流式（桌面固定宽 sticky；≤979 收成折叠条：
                默认只留一行状态，点头部展开时间线与思考流，手机先看题目） */}
            <aside className="senior-chain">
              <div className={`senior-chain-card${chainOpen ? ' chain-open' : ''}`}>
                <button
                  type="button"
                  className="senior-chain-head"
                  aria-expanded={chainOpen}
                  aria-controls="senior-chain-detail"
                  onClick={() => setChainOpen((v) => !v)}
                >
                  <MaterialIcon name="neurology" size={24} />
                  <strong>问诊思路</strong>
                  <span className={`senior-chain-state${chainRunning ? '' : ' done'}`}>
                    {chainRunning ? '进行中' : '已完成'}
                  </span>
                  <MaterialIcon name="keyboard_arrow_down" size={24} className="senior-chain-caret" />
                </button>
                <div className="senior-chain-detail" id="senior-chain-detail">
                  <ol className="senior-chain-steps">
                    {chain.filter((s) => s.status !== 'skipped').map((step) => (
                      <li key={step.id} className={`senior-chain-step ${step.status}`}>
                        <span className="senior-chain-node">
                          {step.status === 'running' ? (
                            <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>
                          ) : (
                            <MaterialIcon name={CHAIN_ICONS[step.id] || 'bolt'} size={22} />
                          )}
                        </span>
                        <div className="senior-chain-body">
                          <strong>{step.title}</strong>
                          {step.summary && <p>{step.summary}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                  {thinking && (
                    <div
                      className="senior-thought"
                      ref={thoughtBoxRef}
                      onScroll={onThoughtScroll}
                      aria-label="助手思考过程"
                    >
                      {thinking}
                    </div>
                  )}
                </div>
              </div>
              {/* 科普 tip：脱离问题卡，放问诊思路底部（无外框，弱化科普条） */}
              {phase === 'asking' && current?.tip && (
                <aside className="senior-tip">
                  <MaterialIcon name="lightbulb" size={24} className="senior-tip-icon" />
                  <p>{current.tip}</p>
                </aside>
              )}
            </aside>

            {/* 右栏：流式题目 / 问题卡 / 流式报告 / 报告成品 */}
            <section className="senior-content">
              {error && (
                <section className="senior-error-card">
                  <MaterialIcon name="error_outline" size={34} />
                  <p>{error.kind === 'question' ? '出了点小状况，问题没有生成出来。' : '健康报告没有生成出来。'}</p>
                  <div className="senior-error-actions">
                    <button
                      type="button"
                      onClick={() => (error.kind === 'question'
                        ? void fetchQuestion(history, chief)
                        : void generateReport(history, chief))}
                    >
                      <MaterialIcon name="refresh" size={24} />再试一次
                    </button>
                    <button type="button" onClick={restart}>
                      <MaterialIcon name="home" size={24} />回到开始
                    </button>
                  </div>
                </section>
              )}

              {!error && (phase === 'thinking' || phase === 'reporting') && (
                <section className="senior-stream-card">
                  {phase === 'thinking' && (
                    <>
                      <div className="senior-stream-label">
                        <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>
                        题目正在生成…
                      </div>
                      <h2 className="senior-question-stream">
                        {streamedQuestion || <span className="senior-stream-placeholder">想好了就写在右边…</span>}
                        {streamedQuestion && <span className="senior-caret" aria-hidden="true" />}
                      </h2>
                    </>
                  )}
                  {phase === 'reporting' && (
                    <>
                      <div className="senior-stream-label">
                        <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>
                        报告正在撰写…
                      </div>
                      {streamedReport ? (
                        <div className="senior-report-stream">
                          <MarkdownRenderer content={streamedReport} />
                        </div>
                      ) : (
                        <p className="senior-stream-placeholder">正在为您整理健康报告…</p>
                      )}
                    </>
                  )}
                </section>
              )}

              {phase === 'asking' && !error && current && (
                <section className="senior-question-card">
              <div className="senior-progress">
                <div className="senior-progress-label">
                  <strong>第 {questionNumber} 问</strong>
                  <span>共约 {MAX_QUESTIONS} 问</span>
                </div>
                <div
                  className="senior-progress-track"
                  role="progressbar"
                  aria-valuemin={1}
                  aria-valuemax={MAX_QUESTIONS}
                  aria-valuenow={questionNumber}
                >
                  <div className="senior-progress-fill" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>

              <div className="senior-question-head">
                <h2 className="senior-question-text">{current.question}</h2>
                <button
                  type="button"
                  className={`senior-speak${speakingKey === 'question' ? ' active' : ''}`}
                  onClick={() => void toggleSpeak('question', questionToSpeech(current))}
                  aria-label={speakingKey === 'question' ? '停止朗读' : '朗读这个问题'}
                >
                  <MaterialIcon name={speakingKey === 'question' ? 'stop' : 'volume_up'} size={26} />
                  {speakingKey === 'question' ? '停止' : '朗读'}
                </button>
              </div>

              <div className="senior-options" role="group" aria-label="问题选项">
                {current.options.map((label) => {
                  const active = selected.includes(label)
                  return (
                    <button
                      key={label}
                      type="button"
                      className={`senior-option${active ? ' active' : ''}`}
                      role={current.multi ? 'checkbox' : 'radio'}
                      aria-checked={active}
                      onClick={() => toggleOption(label)}
                    >
                      <MaterialIcon
                        name={active
                          ? (current.multi ? 'check_box' : 'radio_button_checked')
                          : (current.multi ? 'check_box_outline_blank' : 'radio_button_unchecked')}
                        size={28}
                        className="senior-option-mark"
                      />
                      <span>{label}</span>
                    </button>
                  )
                })}
              </div>

              <div className="senior-free-row">
                {addPhotoButton}
                <textarea
                  className="senior-free-input"
                  rows={2}
                  placeholder="其他 / 补充说明（可不填）"
                  value={freeText}
                  onChange={(e) => setFreeText(e.target.value)}
                />
              </div>
              {pendingBlock}

              <div className="senior-question-actions">
                <button type="button" className="senior-primary" disabled={!answerReady} onClick={() => void submitAnswer()}>
                  <MaterialIcon name="arrow_forward" size={26} />
                  {history.length + 1 >= MAX_QUESTIONS ? '生成健康报告' : '下一问'}
                </button>
                <button type="button" className="senior-ghost" onClick={() => void startReport()}>
                  <MaterialIcon name="description" size={24} />生成健康报告
                </button>
              </div>

            </section>
            )}

              {phase === 'report' && !error && (
                <section className="senior-report">
                  <article className="senior-report-card">
                    <h2 className="senior-report-title">
                      <MaterialIcon name="description" size={30} />您的健康报告
                      <button
                        type="button"
                        className={`senior-speak senior-speak-report${speakingKey === 'report' ? ' active' : ''}`}
                        onClick={() => void toggleSpeak('report', reportToSpeech(report))}
                        aria-label={speakingKey === 'report' ? '停止朗读' : '朗读报告'}
                      >
                        <MaterialIcon name={speakingKey === 'report' ? 'stop' : 'volume_up'} size={26} />
                        {speakingKey === 'report' ? '停止' : '朗读'}
                      </button>
                    </h2>
                    <MarkdownRenderer content={report} />
                    {citations.length > 0 && (
                      <div className="senior-report-sources">
                        <MaterialIcon name="menu_book" size={22} />
                        <span>
                          本次参考了 {citations.length} 条资料
                          （网络类为非权威来源，仅供健康参考）：
                          {citations.slice(0, 4).map((c) => c.title).join('；')}
                          {citations.length > 4 ? ' 等' : ''}
                        </span>
                      </div>
                    )}
                  </article>
                  <div className="senior-report-actions">
                    <button type="button" className="senior-primary" onClick={restart}>
                      <MaterialIcon name="refresh" size={26} />重新开始
                    </button>
                  </div>
                </section>
              )}
            </section>
          </div>
        )}
      </main>

      <style>{`
        .senior-view{height:100%;display:flex;flex-direction:column;background:var(--color-bgPrimary)}
        /* 顶栏已移除（模式切换走侧栏），内容区全屏解放 */
        .senior-main{flex:1;min-height:0;overflow-y:auto}
        .senior-column{display:flex;flex-direction:column;min-height:100%;max-width:680px;margin:0 auto;padding:40px 20px 64px}

        /* ── 工作区双栏：左思维链 + 右题目/报告（桌面 ≥980px；窄屏单栏收折） ── */
        .senior-workspace{display:grid;grid-template-columns:1fr;gap:22px;max-width:1180px;margin:0 auto;padding:26px 20px 56px;align-items:start}
        @media(min-width:980px){
          .senior-workspace{grid-template-columns:360px 1fr}
          .senior-chain{position:sticky;top:22px}
          /* 桌面永远展开：折叠箭头不显示，头部退化为纯标题行（指针穿透，点击不产生副作用） */
          .senior-chain-caret{display:none}
          .senior-chain-head{pointer-events:none}
        }
        /* ≤979 单栏：思维链收成折叠条——默认只留一行状态（图标+标题+进行中/已完成+箭头），
           点头部展开时间线与思考流；手机先看题目，不再每轮滚过约一屏过程面板。
           用 .chain-open 类开关而非 <details>，与桌面卡片样式共用 */
        @media(max-width:979px){
          .senior-chain-card .senior-chain-detail{display:none}
          .senior-chain-card.chain-open .senior-chain-detail{display:block}
          .senior-chain-card:not(.chain-open) .senior-chain-head{margin-bottom:0}
          .senior-chain-caret{margin-left:6px;transition:transform 180ms var(--ease-smooth,ease)}
          .senior-chain-card.chain-open .senior-chain-caret{transform:rotate(180deg)}
        }
        .senior-chain-card{background:var(--color-surface);border:2px solid var(--color-borderLight);border-radius:24px;padding:20px 18px;box-shadow:var(--shadow-card)}
        /* 头部为按钮（≤979 可点展开折叠条）：按钮 reset 后保持原 flex 标题行视觉 */
        .senior-chain-head{display:flex;align-items:center;gap:10px;width:100%;margin-bottom:14px;padding:0;border:0;background:transparent;color:var(--color-accent);font-family:inherit;text-align:left;cursor:pointer}
        .senior-chain-head strong{font-size:21px;color:var(--color-textPrimary)}
        .senior-chain-state{margin-left:auto;font-size:16px;font-weight:600;color:var(--color-warning);background:var(--color-accentSoft);border-radius:9999px;padding:3px 12px}
        .senior-chain-state.done{color:var(--color-success,var(--color-accent))}
        .senior-chain-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
        .senior-chain-step{position:relative;display:grid;grid-template-columns:40px 1fr;gap:10px;padding:7px 0;min-height:52px}
        .senior-chain-step:not(:last-child)::before{content:'';position:absolute;left:19px;top:50px;bottom:-8px;width:2px;background:var(--color-borderLight);border-radius:1px}
        .senior-chain-step:last-child::before{display:none}
        .senior-chain-node{width:40px;height:40px;border-radius:9999px;background:var(--color-bgSecondary);display:flex;align-items:center;justify-content:center;color:var(--color-textSecondary)}
        .senior-chain-step.completed .senior-chain-node{color:var(--color-accent)}
        .senior-chain-step.skipped{display:none}
        .senior-chain-body{min-width:0;display:flex;flex-direction:column;justify-content:center}
        .senior-chain-body strong{font-size:19px;color:var(--color-textPrimary);line-height:1.4}
        .senior-chain-body p{margin:2px 0 0;font-size:16px;color:var(--color-textTertiary);line-height:1.55;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
        /* 思考流式区：自动跟随底部（用户上滚暂停），完成后停止干预 */
        .senior-thought{margin-top:12px;max-height:300px;overflow-y:auto;scrollbar-width:thin;border-left:3px solid var(--color-borderPrimary);padding:4px 0 4px 14px;font-size:16px;line-height:1.75;color:var(--color-textTertiary);white-space:pre-wrap;word-break:break-word}
        /* 右栏：流式生成卡 + 流式题目大字 */
        .senior-content{display:flex;flex-direction:column;gap:22px;min-width:0}
        .senior-stream-card{background:var(--color-surface);border:2px solid var(--color-borderLight);border-radius:28px;padding:32px 30px;box-shadow:var(--shadow-float);display:flex;flex-direction:column;gap:18px}
        .senior-stream-label{display:inline-flex;align-items:center;gap:10px;font-size:20px;color:var(--color-textSecondary)}
        .senior-question-stream{font-size:32px;line-height:1.55;color:var(--color-textPrimary);margin:6px 0 0;min-height:96px}
        .senior-stream-placeholder{color:var(--color-textTertiary);font-weight:400}
        .senior-caret{display:inline-block;width:3px;height:1.05em;vertical-align:-0.15em;background:var(--color-accent);margin-left:4px;animation:senior-caret 1s steps(2) infinite}
        @keyframes senior-caret{0%,100%{opacity:1}50%{opacity:0}}
        .senior-report-stream{max-height:56vh;overflow-y:auto;scrollbar-width:thin}
        .senior-report-stream .markdown-body p{font-size:22px;line-height:1.85}
        .senior-report-stream .markdown-body li{font-size:22px;line-height:1.85}
        .senior-report-sources{display:flex;gap:10px;align-items:flex-start;margin-top:18px;padding-top:14px;border-top:2px solid var(--color-borderLight);color:var(--color-textTertiary)}
        .senior-report-sources span{font-size:17px;line-height:1.7}
        .senior-hidden-input{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

        /* ── 入口态：光球 + 大输入框 ─────────────────────────── */
        .senior-hero{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;text-align:center}
        /* 光球：参考图蓝青色系 + 光影流动动画——基底渐变 + 三层独立漂移（高光/暗斑/底部光带），
           各层 keyframes 独立周期与方向，叠加出「光影在球面上游走」的观感（非简单呼吸）；
           颜色全部读 tokens.css 四主题 --senior-orb-top/mid/deep/glow/shade/rim */
        .senior-orb{position:relative;width:clamp(180px,30vw,240px);aspect-ratio:1/1;border-radius:9999px;border:0;padding:0;cursor:pointer;overflow:hidden;
          background:linear-gradient(168deg, var(--senior-orb-top) 6%, var(--senior-orb-mid) 52%, var(--senior-orb-deep) 100%);
          box-shadow:0 22px 52px -14px color-mix(in srgb, var(--senior-orb-deep) 42%, transparent), inset 0 -12px 26px color-mix(in srgb, var(--senior-orb-glow) 55%, transparent), inset 0 10px 20px rgba(255,255,255,.24);
          animation:orb-breathe 5.5s ease-in-out infinite;transition:transform 160ms ease}
        .senior-orb:hover{transform:scale(1.03)}
        .senior-orb:active{transform:scale(.98)}
        .senior-orb:focus-visible{outline:3px solid var(--color-accent);outline-offset:6px}
        .senior-orb:disabled{cursor:progress}
        .orb-layer{position:absolute;inset:-14%;pointer-events:none;border-radius:50%}
        /* 顶部高光：缓慢斜向漂移 + 张缩（参考图帧1→帧3 的高光位移） */
        .orb-hi{background:radial-gradient(circle at 36% 24%, rgba(255,255,255,.9) 0%, rgba(255,255,255,0) 47%);animation:orb-hi 9s ease-in-out infinite alternate}
        /* 左下暗斑：主题色深斑游走（帧1 的深蓝斑位置） */
        .orb-shade{background:radial-gradient(circle at 50% 50%, var(--senior-orb-shade) 0%, transparent 58%);width:72%;height:72%;inset:auto;top:4%;right:-8%;opacity:.55;animation:orb-shade 13s ease-in-out infinite alternate}
        /* 底部青白光带：左右摆动 + 明暗呼吸（帧2 的底光位置） */
        .orb-glow{background:radial-gradient(ellipse 62% 40% at 50% 86%, var(--senior-orb-glow) 0%, transparent 100%);opacity:.85;animation:orb-glow 7s ease-in-out infinite alternate}
        .senior-orb-halo{position:absolute;inset:-18px;border-radius:9999px;background:radial-gradient(circle, color-mix(in srgb, var(--senior-orb-mid) 35%, transparent) 0%, transparent 70%);animation:orb-halo 4.5s ease-in-out infinite;pointer-events:none}
        /* 录音中：所有层加速（光影流速加快 = 「在听」的活力感） */
        .senior-orb.recording{animation-duration:2.2s}
        .senior-orb.recording .orb-hi{animation-duration:3.5s}
        .senior-orb.recording .orb-shade{animation-duration:4.5s}
        .senior-orb.recording .orb-glow{animation-duration:2.8s}
        .senior-orb.recording .senior-orb-halo{animation-duration:1.6s}
        @keyframes orb-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}
        @keyframes orb-hi{from{transform:translate(-5%,3%) scale(1)}to{transform:translate(6%,-5%) scale(1.14)}}
        @keyframes orb-shade{from{transform:translate(-9%,-5%) rotate(-10deg);opacity:.45}to{transform:translate(5%,7%) rotate(8deg);opacity:.75}}
        @keyframes orb-glow{from{transform:translateX(-8%) scaleY(1);opacity:.65}to{transform:translateX(8%) scaleY(1.18);opacity:.95}}
        @keyframes orb-halo{0%,100%{transform:scale(1);opacity:.6}50%{transform:scale(1.1);opacity:.25}}
        .senior-listening{display:inline-flex;align-items:center;gap:10px;margin:0;font-size:24px;font-weight:600;color:var(--color-accent)}
        .listening-waves{display:inline-flex;align-items:flex-end;gap:3px;height:22px}
        .listening-waves>span{width:5px;border-radius:9999px;background:currentColor;transform-origin:bottom;animation:listening-bar .9s ease-in-out infinite}
        .listening-waves>span:nth-child(1){height:10px}
        .listening-waves>span:nth-child(2){height:20px;animation-delay:.15s}
        .listening-waves>span:nth-child(3){height:14px;animation-delay:.3s}
        .listening-waves>span:nth-child(4){height:18px;animation-delay:.45s}
        @keyframes listening-bar{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1)}}
        @media(prefers-reduced-motion:reduce){
          .senior-orb,.senior-orb-halo,.orb-layer,.senior-orb.recording,.senior-orb.recording .orb-layer,.senior-orb.recording .senior-orb-halo{animation:none}
          .listening-waves>span{animation:none}
          .thinking-dots>span{animation:none}
        }
        /* 输入 dock：普通模式同款两行式（Claude 风格白卡 hairline + 底部工具行），字号保持长辈档 */
        .senior-dock{background:var(--color-surface,#fff);border:1px solid var(--mono-hairline);border-radius:24px;box-shadow:var(--mono-shadow-composer);padding:12px 12px 10px 16px;display:flex;flex-direction:column;align-items:stretch;gap:2px;width:100%;transition:box-shadow .2s var(--ease-smooth)}
        .senior-dock:focus-within{box-shadow:var(--mono-shadow-composer-focus)}
        .senior-dock-input{border:0;outline:0;background:transparent;font-size:23px;line-height:1.6;color:var(--color-textPrimary);resize:none;font-family:inherit;min-height:60px;width:100%}
        .senior-dock-input::placeholder{color:var(--color-textTertiary)}
        .senior-dock-foot{display:flex;align-items:center;justify-content:space-between}
        .senior-tool-btn{width:44px;height:44px;border:0;border-radius:12px;background:transparent;cursor:pointer;color:var(--color-textTertiary);display:grid;place-items:center;flex:0 0 44px;transition:background .15s var(--ease-smooth),color .15s var(--ease-smooth)}
        .senior-tool-btn:hover{background:var(--mono-hover);color:var(--color-textPrimary)}
        .senior-dock-send{width:44px;height:44px;border:0;border-radius:9999px;background:var(--mono-ink);color:var(--color-primary-foreground);cursor:pointer;display:grid;place-items:center;flex:0 0 44px;transition:background .15s var(--ease-smooth)}
        .senior-dock-send:hover:not(:disabled){background:var(--mono-ink-hover)}
        .senior-dock-send:disabled{background:var(--color-borderPrimary);cursor:not-allowed}
        /* 快捷问题：普通模式同款胶囊（强制单行均分，图标不收缩），字号长辈档 */
        .senior-quick{display:flex;flex-wrap:nowrap;justify-content:center;gap:10px;width:100%}
        .senior-quick button{display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:1 1 0;min-width:0;background:var(--mono-panel);border:1px solid var(--mono-hairline);border-radius:12px;padding:12px 12px;font-size:17px;color:var(--color-textSecondary);cursor:pointer;font-family:inherit;transition:background .18s var(--ease-spring),box-shadow .18s var(--ease-spring),color .18s var(--ease-spring)}
        .senior-quick button>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .senior-quick button>.material-symbol{color:var(--color-textTertiary);flex:0 0 auto}
        .senior-quick button:hover{background:var(--color-surface,#fff);box-shadow:var(--mono-shadow-card);color:var(--color-textPrimary)}
        .senior-pending{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-start;width:100%}
        .senior-pending-chip{display:inline-flex;align-items:center;gap:8px;background:var(--color-surface);border:2px solid var(--color-borderPrimary);border-radius:16px;padding:6px 10px 6px 6px;box-shadow:var(--shadow-card)}
        .senior-pending-chip img{width:44px;height:44px;border-radius:10px;object-fit:cover}
        .senior-pending-chip em{font-style:normal;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px;color:var(--color-textSecondary)}
        .senior-pending-chip button{flex:0 0 auto;width:32px;height:32px;border:0;border-radius:9999px;background:transparent;color:var(--color-textTertiary);cursor:pointer;display:flex;align-items:center;justify-content:center}
        .senior-pending-chip button:hover{background:var(--color-bgSecondary);color:var(--color-danger)}
        .senior-hint{font-size:20px;color:var(--color-textTertiary);margin:0}
        /* .senior-disclaimer 免责声明已按需求移除 */

        /* ── 加载态 ─────────────────────────────────────────── */
        .senior-loading{display:flex;align-items:center;justify-content:center;gap:12px;padding:120px 20px;font-size:24px;color:var(--color-textSecondary)}
        .thinking-dots{display:inline-flex;align-items:center;gap:4px;height:16px;flex:0 0 auto}
        .thinking-dots>span{width:5px;height:5px;border-radius:9999px;background:currentColor;opacity:.3;animation:thinking-dot 1.4s var(--ease-smooth) infinite}
        .thinking-dots>span:nth-child(2){animation-delay:.15s}
        .thinking-dots>span:nth-child(3){animation-delay:.3s}
        @keyframes thinking-dot{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}

        /* ── 问答态 ─────────────────────────────────────────── */
        .senior-question-card{display:flex;flex-direction:column;gap:24px;background:var(--color-surface);border:2px solid var(--color-borderLight);border-radius:28px;padding:32px 30px;box-shadow:var(--shadow-float)}
        .senior-progress{display:flex;flex-direction:column;gap:10px}
        .senior-progress-label{display:flex;align-items:baseline;justify-content:space-between}
        .senior-progress-label strong{font-size:24px;color:var(--color-textPrimary)}
        .senior-progress-label span{font-size:18px;color:var(--color-textTertiary)}
        .senior-progress-track{height:14px;border-radius:9999px;background:var(--color-bgSecondary);overflow:hidden}
        .senior-progress-fill{height:100%;border-radius:9999px;background:var(--color-accent);transition:width 320ms ease}
        .senior-question-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
        .senior-question-text{flex:1 1 auto;font-size:30px;line-height:1.5;color:var(--color-textPrimary);margin:0}
        .senior-speak{flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;min-height:52px;padding:8px 20px;border-radius:9999px;border:2px solid var(--color-borderPrimary);background:var(--color-bgPrimary);color:var(--color-accent);font-size:20px;font-weight:600;font-family:inherit;cursor:pointer;transition:border-color 160ms ease,background 160ms ease}
        .senior-speak:hover{border-color:var(--color-accent);background:var(--color-accentSoft)}
        .senior-speak.active{border-color:var(--color-accent);background:var(--color-accentSoft)}
        .senior-options{display:flex;flex-direction:column;gap:14px}
        .senior-option{display:flex;align-items:center;gap:14px;width:100%;min-height:56px;text-align:left;padding:14px 20px;border-radius:18px;border:2px solid var(--color-borderPrimary);background:var(--color-bgPrimary);color:var(--color-textPrimary);font-size:23px;font-family:inherit;line-height:1.5;cursor:pointer;transition:border-color 140ms ease,background 140ms ease}
        .senior-option:hover{border-color:var(--color-accent)}
        .senior-option.active{border-color:var(--color-accent);background:var(--color-accentSoft);border-width:2px}
        .senior-option-mark{flex:0 0 auto;color:var(--color-accent)}
        .senior-free-row{display:flex;align-items:stretch;gap:12px}
        .senior-free-row .senior-tool-btn{align-self:flex-start}
        .senior-free-input{flex:1;min-width:0;width:100%;border:2px solid var(--color-borderPrimary);border-radius:18px;padding:16px 20px;font-size:22px;line-height:1.6;font-family:inherit;color:var(--color-textPrimary);background:var(--color-bgPrimary);outline:0;resize:vertical}
        .senior-free-input:focus{border-color:var(--color-accent);box-shadow:var(--shadow-composer-focus)}
        .senior-free-input::placeholder{color:var(--color-textTertiary)}
        .senior-question-actions{display:flex;gap:14px;flex-wrap:wrap}
        .senior-primary,.senior-ghost{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:56px;border-radius:18px;font-size:23px;font-weight:700;font-family:inherit;cursor:pointer;transition:background 160ms ease,border-color 160ms ease}
        .senior-primary{flex:1;border:0;background:var(--color-accent);color:var(--color-bgPrimary);padding:12px 28px}
        .senior-primary:hover:not(:disabled){background:var(--color-accentHover)}
        .senior-primary:disabled{background:var(--color-borderPrimary);cursor:not-allowed}
        .senior-ghost{border:2px solid var(--color-borderPrimary);background:var(--color-surface);color:var(--color-accent);padding:12px 24px}
        .senior-ghost:hover:not(:disabled){border-color:var(--color-accent);background:var(--color-accentSoft)}
        .senior-ghost:disabled{color:var(--color-textDisabled);border-color:var(--color-borderLight);cursor:not-allowed}
        /* tip 科普条：位于问诊思路底部，无外框弱化展示 */
        .senior-tip{display:flex;gap:12px;align-items:flex-start;margin-top:14px;padding:4px 6px}

        /* ── 长辈问诊历史（入口态列表 + 只读回看） ── */
        .senior-past{width:100%;display:flex;flex-direction:column;gap:12px;text-align:left}
        .senior-past-title{display:flex;align-items:center;gap:8px;margin:0;font-size:21px;color:var(--color-textPrimary)}
        .senior-past-list{display:flex;flex-direction:column;gap:10px}
        .senior-past-item{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;padding:12px 20px;border-radius:16px;border:2px solid var(--color-borderPrimary);background:var(--color-surface);cursor:pointer;font-family:inherit;transition:border-color 140ms ease,background 140ms ease}
        .senior-past-item:hover{border-color:var(--color-accent);background:var(--color-accentSoft)}
        .senior-past-name{font-size:20px;color:var(--color-textPrimary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .senior-past-date{flex:0 0 auto;font-size:16px;color:var(--color-textTertiary)}
        .senior-history-view{display:flex;flex-direction:column;gap:22px}
        .senior-history-title{display:flex;align-items:center;gap:10px;margin:0;font-size:27px;color:var(--color-textPrimary)}
        .senior-history-body{display:flex;flex-direction:column;gap:16px;background:var(--color-surface);border:2px solid var(--color-borderLight);border-radius:24px;padding:26px 24px;box-shadow:var(--shadow-card)}
        .senior-history-msg{display:flex;flex-direction:column;gap:6px}
        .senior-history-msg.user p{margin:0;font-size:21px;line-height:1.7;color:var(--color-textPrimary)}
        .senior-history-msg.assistant p{margin:0;font-size:20px;line-height:1.75;color:var(--color-textSecondary)}
        .senior-history-role{font-size:15px;font-weight:700;color:var(--color-textTertiary)}
        .senior-history-md{font-size:20px}
        .senior-history-actions{display:flex;justify-content:center}
        .senior-tip-icon{flex:0 0 auto;color:var(--color-warning);margin-top:2px}
        .senior-tip p{margin:0;font-size:20px;line-height:1.8;color:var(--color-textSecondary)}

        /* ── 报告态 ─────────────────────────────────────────── */
        .senior-report{display:flex;flex-direction:column;gap:24px}
        .senior-report-card{background:var(--color-surface);border:2px solid var(--color-borderLight);border-radius:28px;padding:32px 30px;box-shadow:var(--shadow-float)}
        .senior-report-title{display:flex;align-items:center;gap:10px;font-size:28px;color:var(--color-textPrimary);margin:0 0 20px}
        .senior-speak-report{margin-left:auto}
        .senior-report-card .markdown-body p{font-size:22px;line-height:1.85}
        .senior-report-card .markdown-body strong{font-size:24px}
        .senior-report-card .markdown-body li{font-size:22px;line-height:1.85}
        .senior-report-actions{display:flex;justify-content:center}

        /* ── 错误态 ─────────────────────────────────────────── */
        .senior-error-card{display:flex;flex-direction:column;align-items:center;gap:16px;background:var(--color-surface);border:2px solid var(--color-borderLight);border-radius:28px;padding:44px 30px;text-align:center;color:var(--color-danger)}
        .senior-error-card p{margin:0;font-size:23px;color:var(--color-textPrimary)}
        .senior-error-actions{display:flex;gap:14px;flex-wrap:wrap;justify-content:center}
        .senior-error-actions button{display:inline-flex;align-items:center;gap:8px;min-height:56px;padding:12px 26px;border-radius:18px;border:2px solid var(--color-borderPrimary);background:var(--color-surface);color:var(--color-accent);font-size:21px;font-family:inherit;cursor:pointer}
        .senior-error-actions button:hover{border-color:var(--color-accent);background:var(--color-accentSoft)}

        /* ── 平板与大屏手机（481-979）：单栏布局下的中间档降级（桌面 ≥980 不受影响） ── */
        @media(min-width:481px) and (max-width:979px){
          .senior-question-card{padding:24px 20px}
          .senior-stream-card{padding:24px 20px}
          .senior-report-card{padding:24px 20px}
          .senior-chain-card{padding:16px 14px}
          .senior-history-body{padding:20px 18px}
          .senior-error-card{padding:28px 20px}
          .senior-question-text,.senior-question-stream{font-size:26px}
          .senior-option{font-size:20px}
          .senior-dock-input{font-size:20px}
          .senior-free-input{font-size:19px}
          .senior-report-card .markdown-body p,.senior-report-card .markdown-body li{font-size:19px}
          .senior-report-card .markdown-body strong{font-size:21px}
          .senior-report-stream .markdown-body p,.senior-report-stream .markdown-body li{font-size:19px}
          .senior-quick button{font-size:15px}
        }

        @media(max-width:480px){
          .senior-question-card{padding:24px 18px}
          .senior-question-text{font-size:26px}
          .senior-option{font-size:20px}
          .senior-pending-chip em{max-width:96px}
          .senior-question-stream{font-size:26px}
          .senior-dock-input{font-size:20px}
          .senior-free-input{font-size:20px}
          /* 思考过程限高：手机上 300px 偏高，收为 200px */
          .senior-thought{max-height:200px}
          .senior-stream-card{padding:24px 18px}
          .senior-report-card{padding:24px 18px}
          .senior-history-body{padding:20px 16px}
          .senior-error-card{padding:28px 18px}
          /* 快捷胶囊：保持单行（nowrap），但允许按钮收缩、文字省略，窄屏不横向溢出 */
          .senior-quick button{min-width:0;padding:12px 8px;font-size:14px;min-height:44px}
          .senior-quick button>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        }
      `}</style>
    </div>
  )
}
