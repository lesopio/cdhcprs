import { useCallback, useEffect, useRef, useState } from 'react'
import { chatAPI } from '@/api/chat'
import { consumeSseResponse } from '@/lib/sse'
import { makeMessage, type ChatMessage } from '@/lib/chat-types'
import { notify } from '@/lib/toast'

/**
 * SSE 流式聊天 hook（迁移自 Vue 版 Chat.vue submitMessage/handleSse）
 *
 * 设计要点（React 与 Vue 的差异）：
 * - 消息数组用 React state（每次更新都触发渲染）
 * - 流式过程中频繁追加 content：为了不每次拷贝整个数组，
 *   我们保留 messagesRef（可变引用）+ 通过 setMessages([...]) 触发渲染
 * - AbortController 用于取消进行中的请求
 *
 * 提供方法：
 *   sendMessage(content, { profileId, attachmentIds, onAssistantIdReady? })
 *   submitIntakeSelection(content, { profileId })
 * 并暴露 messages / setMessages / sending / renderTick 状态；
 * 可选 onIntakeTurn 回调在每次 intake.turn 到达时收到 { reply, options }（todo A3）。
 *
 * 2026-09 加固：
 * - 流式刷出 flush 走 150ms 节流合帧；终态（完成/失败）由 flushNow 强制补刷，内容不丢。
 * - 服务端 error 事件与流中断（consumeSseResponse.onError）不再被吞：一律把该条消息
 *   generation_status 置 'failed' 并 notify.error。
 * - renderTick 渲染代数：就地修改 message 对象时（引用不变）供 memo 化消息项感知重渲染。
 */
export interface UseSseChatOptions {
  /** 取得当前会话 id（异步以便从外部 store 读） */
  getConversationId: () => number | null
  /** 获取 profileId（可选） */
  getProfileId?: () => number | undefined
  /** 消息列表渲染完成后的滚动回调（调用方传入） */
  onMessagesUpdated?: () => void
  /** intake.turn 到达时的回调（todo A3）：把每轮追问交给调用方的步骤卡（IntakeStepCard）承载 */
  onIntakeTurn?: (turn: { reply: string; options: Array<{ label: string; multi: boolean }> }) => void
}

/** 流式刷出的节流合帧间隔（ms）：渲染节流（非打字速度）——打字机消费器独立 33ms 运转，
 *  这里只兜底 trace/citations 等低频事件的合帧 */
const FLUSH_THROTTLE_MS = 90

/** 打字机帧间隔（ms）：约 30fps 匀速放出缓冲内容，后端突发大块到达也不视觉跳变 */
const TYPE_TICK_MS = 33

export function useSseChat(options: UseSseChatOptions) {
  const { getConversationId, getProfileId, onMessagesUpdated, onIntakeTurn } = options
  const [messages, setMessagesState] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  // 渲染代数：流式期间 handleSse 就地修改 message 对象（引用不变），调用方的
  // React.memo 消息项靠它在 props 上感知到「同对象、内容已变」，从而重渲染
  const [renderTick, setRenderTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  // 双保险：sending state 在同一次事件循环里连读两次会是旧值（双击发送/Enter+按钮齐发），
  // 用同步 ref 保证同一时刻只有一条流在跑
  const sendingRef = useRef(false)
  // 保持 messages 的可变引用，方便在流式回调里直接改对象再触发渲染
  const messagesRef = useRef<ChatMessage[]>([])
  // 挂起的节流 flush 定时器
  const flushTimerRef = useRef<number | null>(null)
  // 保持最新回调
  const cbRef = useRef(onMessagesUpdated)
  cbRef.current = onMessagesUpdated
  // intake.turn 回调同样保持最新（A3）
  const intakeTurnCbRef = useRef(onIntakeTurn)
  intakeTurnCbRef.current = onIntakeTurn

  // 打字机缓冲：SSE 突发到达的正文/思考先入队，33ms 定时器匀速放出（积压越多放越快，
  // 自适应追赶），视觉上字符连续涌出而非一坨坨跳出——「丝滑」的实现本体
  const typeBufRef = useRef<{ content: string; thinkingA: string }>({ content: '', thinkingA: '' })
  const typeTargetRef = useRef<ChatMessage | null>(null)
  const typeTimerRef = useRef<number | null>(null)

  const stopTyper = useCallback(() => {
    if (typeTimerRef.current !== null) {
      window.clearInterval(typeTimerRef.current)
      typeTimerRef.current = null
    }
  }, [])

  /** 排空缓冲（流终态调用）：剩余内容一次性放出并停表，保证最终内容完整 */
  const drainTyper = useCallback(() => {
    const buf = typeBufRef.current
    const msg = typeTargetRef.current
    if (msg) {
      if (buf.content) { msg.content += buf.content; buf.content = '' }
      if (buf.thinkingA) { msg.thinkingAnswer = (msg.thinkingAnswer || '') + buf.thinkingA; buf.thinkingA = '' }
    }
    stopTyper()
  }, [stopTyper])

  const startTyper = useCallback(() => {
    if (typeTimerRef.current !== null) return
    typeTimerRef.current = window.setInterval(() => {
      const buf = typeBufRef.current
      const msg = typeTargetRef.current
      if (!msg) { stopTyper(); return }
      // 自适应速度：缓冲长（后端快于展示）→ 每帧多放；接近追平 → 匀速小步
      if (buf.content) {
        const n = Math.max(2, Math.ceil(buf.content.length / 5))
        msg.content += buf.content.slice(0, n)
        buf.content = buf.content.slice(n)
      }
      if (buf.thinkingA) {
        const n = Math.max(3, Math.ceil(buf.thinkingA.length / 4))
        msg.thinkingAnswer = (msg.thinkingAnswer || '') + buf.thinkingA.slice(0, n)
        buf.thinkingA = buf.thinkingA.slice(n)
      }
      setMessagesState([...messagesRef.current])
      setRenderTick((t) => t + 1)
      cbRef.current?.()
      if (!buf.content && !buf.thinkingA) stopTyper()
    }, TYPE_TICK_MS)
  }, [stopTyper])

  /** 取消挂起的节流 flush（流终态强制刷出前 / 组件卸载时调用） */
  const cancelPendingFlush = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }, [])

  /** 立即触发渲染 + 调用滚动回调；流结束/出错后的强制刷出，保证最终一致性 */
  const flushNow = useCallback(() => {
    cancelPendingFlush()
    setMessagesState([...messagesRef.current])
    setRenderTick((t) => t + 1)
    cbRef.current?.()
  }, [cancelPendingFlush])

  /** 流终态：用浅拷贝替换 assistant 对象（引用变化）。流式期间对象就地变更 + tick 驱动重渲染，
   *  但终态时 tick 停跳且 memo 比较器对非流式消息返回「未变」，完成态（思考面板收起、
   *  操作钮恢复）将不会被绘制 —— 引用替换是唯一可靠的重渲染信号 */
  const finalizeAssistant = useCallback((assistant: ChatMessage) => {
    messagesRef.current = messagesRef.current.map((m) => (m === assistant ? { ...assistant } : m))
    flushNow()
  }, [flushNow])

  /** 流式期间的高频刷出：150ms 节流合帧（尾沿触发，读最新 messagesRef，不丢内容）；
   *  结束/出错时必须再调 finalizeAssistant() 强制补刷一次 */
  const flush = useCallback(() => {
    if (flushTimerRef.current !== null) return
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null
      setMessagesState([...messagesRef.current])
      setRenderTick((t) => t + 1)
      cbRef.current?.()
    }, FLUSH_THROTTLE_MS)
  }, [])

  // 卸载时清掉挂起的节流/打字机定时器，避免卸载后 setState
  useEffect(() => () => { cancelPendingFlush(); stopTyper() }, [cancelPendingFlush, stopTyper])

  const setMessages = useCallback((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    messagesRef.current = updater(messagesRef.current)
    flushNow()
  }, [flushNow])

  /** SSE 事件处理 —— 就地修改目标 message（迁移自 handleSse） */
  const handleSse = useCallback((event: string, data: any, message: ChatMessage) => {
    if (event === 'trace.stage') {
      const index = message.trace.findIndex((item) => item.id === data.id)
      if (index >= 0) message.trace[index] = data
      else message.trace.push(data)
    } else if (event === 'answer.delta') {
      // 打字机缓冲：先入队匀速放出（SSE 突发大块直接上屏会「一坨坨」跳变）
      typeBufRef.current.content += data.delta || ''
      startTyper()
    } else if (event === 'citations') {
      message.citations = data.items || []
    } else if (event === 'analysis.summary') {
      message.analysis_summary = data.summary || ''
    } else if (event === 'thinking.delta') {
      // 思考增量按阶段分流：证据整合的思考跟轨迹步骤（直接上屏，容器自动滚底跟随）、
      // 正文生成的思考走打字机缓冲匀速放出
      if (data.stage === 'answer') {
        typeBufRef.current.thinkingA += data.delta || ''
        startTyper()
      } else {
        message.thinkingEvidence = (message.thinkingEvidence || '') + (data.delta || '')
      }
    } else if (event === 'intake.turn') {
      const turn = {
        reply: data.reply || '',
        options: (data.options || []).map((o: any) => ({
          label: String(o.label ?? ''),
          multi: !!o.multi,
        })),
      }
      message.intakeTurn = {
        ...turn,
        round: data.round,
        submittedSelections: [],
        collecting: true,
      }
      message.id = data.message_id
      // A3：同步通知调用方（Chat 用 IntakeStepCard 承载逐轮问题）
      intakeTurnCbRef.current?.(turn)
    } else if (event === 'intake.complete') {
      message.intakeTurn = undefined
      message.generation_status = 'streaming'
    } else if (event === 'done') {
      message.id = data.message_id
      message.generation_status = 'completed'
    } else if (event === 'error') {
      throw new Error(data.message)
    }
  }, [])

  /** 公共流式发送逻辑（conversationIdOverride：新建会话后 state 尚未提交时显式传入） */
  const streamSend = useCallback(
    async (content: string, attachmentIds: number[] = [], conversationIdOverride?: number) => {
      const conversationId = conversationIdOverride ?? getConversationId()
      if (!conversationId || sendingRef.current) return false
      sendingRef.current = true

      // 乐观插入用户消息 + 助手占位
      const assistant: ChatMessage = makeMessage({
        role: 'assistant', content: '', generation_status: 'streaming',
      })
      setMessages((prev) => [
        ...prev,
        makeMessage({ role: 'user', content, generation_status: 'completed' }),
        assistant,
      ])
      // 打字机目标指向本条助手消息，缓冲从零开始（上一条的余量已被终态排空）
      typeTargetRef.current = assistant
      typeBufRef.current = { content: '', thinkingA: '' }

      setSending(true)
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const profileId = getProfileId?.()
        const response = await chatAPI.sendMessage(
          conversationId, content || '请分析我上传的医学图片。',
          profileId, attachmentIds, controller.signal,
        )
        if (!response.ok || !response.body) {
          throw new Error((await response.text()) || '请求失败')
        }
        await consumeSseResponse(response, {
          onEvent: (event, data) => {
            try {
              handleSse(event, data, assistant)
              flush()
            } catch (e: any) {
              if (event === 'error') {
                // 服务端 error 事件（handleSse 对 event==='error' 抛出）：
                // 这是真正的失败，不能当作可跳过的解析问题吞掉 —— 置 failed 并提示
                assistant.generation_status = 'failed'
                assistant.content ||= `回答生成失败：${e?.message || '未知错误'}`
                notify.error(assistant.content)
                drainTyper()
                finalizeAssistant(assistant)
                return
              }
              console.warn('SSE 帧解析跳过:', e?.message)
            }
          },
          onError: (err) => {
            // 流中断（网络断开 / reader 异常）：consumeSseResponse 捕获后回调到这里，
            // 与 error 事件同口径置 failed；主动取消不算错（consumeSseResponse 已过滤）
            if (controller.signal.aborted) return
            assistant.generation_status = 'failed'
            assistant.content ||= `回答生成失败：${(err as any)?.message || '连接中断'}`
            notify.error(assistant.content)
            drainTyper()
            finalizeAssistant(assistant)
          },
        }, controller.signal)
        // 流正常走完才置 completed；已被 error 事件 / onError 置 failed 的不能被覆盖回去
        if (assistant.generation_status !== 'failed') {
          assistant.generation_status = 'completed'
        }
        // 先排空打字机缓冲再终态替换（引用变化），内容完整性与完成态渲染一次到位
        drainTyper()
        finalizeAssistant(assistant)
        return true
      } catch (error: any) {
        if (controller.signal.aborted) return false
        assistant.generation_status = 'failed'
        assistant.content ||= `回答生成失败：${error?.message || '未知错误'}`
        notify.error(assistant.content)
        drainTyper()
        finalizeAssistant(assistant)
        return false
      } finally {
        setSending(false)
        sendingRef.current = false
        abortRef.current = null
      }
    },
    [getConversationId, getProfileId, setMessages, flush, flushNow, handleSse, drainTyper, finalizeAssistant, startTyper],
  )

  const sendMessage = useCallback(
    async (content: string, attachmentIds: number[] = [], conversationIdOverride?: number) => {
      const ok = await streamSend(content, attachmentIds, conversationIdOverride)
      return ok
    },
    [streamSend],
  )

  /** intake 选择回传 —— 行为同 sendMessage（用户回显 + 流式助手回复） */
  const submitIntakeSelection = useCallback(
    async (content: string) => streamSend(content, []),
    [streamSend],
  )

  /** 取消进行中的请求 */
  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return {
    messages, setMessages, sending, renderTick, sendMessage, submitIntakeSelection, abort,
  }
}
