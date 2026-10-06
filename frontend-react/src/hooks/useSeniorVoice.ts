import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE_URL } from '@/api/client'
import { chatAPI } from '@/api/chat'
import { notify } from '@/lib/toast'

/**
 * 长辈模式语音 hook（合一）：语音输入（录音 → /api/media/asr 转写）+ 文本朗读
 * （POST /api/media/tts/text → blob 播放）。
 *
 * 为什么不复用 useRecorder / useTts：
 * - 长辈模式需要「正在听」「正在识别」两个独立状态给光球动画与文案，
 *   且 asr/tts 未配置时点击只 toast 提示（能力开关由调用方经 /api/public/settings 读入）；
 * - useTts 以 messageId 为键缓存会话消息朗读，长辈模式这里按卡片 key
 *   （'question' / 'report'）即时取流播放、播完即释放，不占缓存。
 *
 * 录音实现与 useRecorder 同模式（MediaRecorder + 最长 maxSeconds 自动停），但独立实例。
 */
export interface SeniorVoiceOptions {
  /** /api/public/settings 的 asr_available：false 时点击只 toast，不申请麦克风 */
  asrAvailable: boolean
  /** /api/public/settings 的 tts_available：false 时点击朗读只 toast */
  ttsAvailable: boolean
  /** 最长录音秒数（asr_max_seconds，后端约定） */
  maxSeconds?: number
  /** 转写完成回调（调用方负责把文本填进对应输入框） */
  onTranscribed?: (text: string) => void
}

export function useSeniorVoice({ asrAvailable, ttsAvailable, maxSeconds = 60, onTranscribed }: SeniorVoiceOptions) {
  // ── 语音输入：录音 → ASR ──────────────────────────────────────────
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | undefined>(undefined)
  // 保持回调最新（录音周期内不因调用方重渲染而丢回调）
  const cbRef = useRef(onTranscribed)
  useEffect(() => { cbRef.current = onTranscribed }, [onTranscribed])

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop()
  }, [])

  const toggleRecording = useCallback(async () => {
    if (recording) { stopRecording(); return }
    if (!asrAvailable) {
      notify.info('语音输入暂未开通，请直接打字提问')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunksRef.current = []
      const recorder = new MediaRecorder(stream)
      recorderRef.current = recorder
      recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
      recorder.onstop = async () => {
        setRecording(false)
        window.clearTimeout(timerRef.current)
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        chunksRef.current = []
        recorderRef.current = null
        if (!blob.size) return
        setTranscribing(true)
        try {
          const { data } = await chatAPI.transcribe(blob)
          if (data?.text) cbRef.current?.(data.text)
          else notify.info('没有听清，请再说一遍')
        } catch (err: any) {
          // detail 可能是 FastAPI 校验错误数组，规范成字符串再进 toast
          const detail = err?.response?.data?.detail
          const message = typeof detail === 'string'
            ? detail
            : Array.isArray(detail)
              ? detail.map((d: any) => d?.msg || String(d)).join('；')
              : '语音转写失败，请再试一次'
          notify.error(message)
        } finally {
          setTranscribing(false)
        }
      }
      recorder.start()
      setRecording(true)
      timerRef.current = window.setTimeout(() => recorderRef.current?.stop(), maxSeconds * 1000)
    } catch {
      notify.error('无法使用麦克风，请检查浏览器权限')
    }
  }, [recording, stopRecording, asrAvailable, maxSeconds])

  // ── 朗读：文本 → /api/media/tts/text → blob 播放 ─────────────────
  const [speakingKey, setSpeakingKey] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setSpeakingKey(null)
  }, [])

  /** key 区分哪张卡在朗读（同一时刻只播一段）；再点同一按钮即停止 */
  const toggleSpeak = useCallback(async (key: string, text: string) => {
    if (speakingKey === key) { stopSpeaking(); return }
    if (!ttsAvailable) {
      notify.info('朗读暂未开通，请联系管理员配置')
      return
    }
    const clean = text.trim()
    if (!clean) return
    stopSpeaking()
    try {
      const response = await fetch(`${API_BASE_URL}/api/media/tts/text`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
        },
        body: JSON.stringify({ text: clean.slice(0, 6000) }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { detail?: string } | null
        notify.error(detail?.detail || '朗读服务调用失败')
        return
      }
      const url = URL.createObjectURL(await response.blob())
      urlRef.current = url
      const audio = new Audio(url)
      audio.onended = () => {
        if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
        audioRef.current = null
        setSpeakingKey(null)
      }
      audioRef.current = audio
      await audio.play()
      setSpeakingKey(key)
    } catch {
      notify.error('朗读服务调用失败')
    }
  }, [speakingKey, stopSpeaking, ttsAvailable])

  // 卸载清理：停录音、停播放、回收 blob URL
  useEffect(() => () => {
    window.clearTimeout(timerRef.current)
    recorderRef.current?.stream.getTracks().forEach((t) => t.stop())
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  return {
    // 语音输入
    recording,
    transcribing,
    toggleRecording,
    stopRecording,
    // 朗读
    speakingKey,
    toggleSpeak,
    stopSpeaking,
  }
}
