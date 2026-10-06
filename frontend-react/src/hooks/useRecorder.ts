import { useCallback, useEffect, useRef, useState } from 'react'
import { chatAPI } from '@/api/chat'
import { notify } from '@/lib/toast'

/**
 * 录音 + ASR 转写 hook（迁移自 Vue 版 Chat.vue toggleRecording）
 *
 * @param maxSeconds 后端约定的最长录音秒数
 * @param onTranscribed 转写完成回调，返回文本会传给它（调用方负责拼到输入框）
 */
export function useRecorder(maxSeconds = 60, onTranscribed?: (text: string) => void) {
  const [recording, setRecording] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | undefined>(undefined)
  // 保持回调最新
  const cbRef = useRef(onTranscribed)
  useEffect(() => { cbRef.current = onTranscribed }, [onTranscribed])

  const stop = useCallback(() => {
    mediaRecorderRef.current?.stop()
  }, [])

  const toggle = useCallback(async () => {
    if (recording) { stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunksRef.current = []
      const recorder = new MediaRecorder(stream)
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
      recorder.onstop = async () => {
        setRecording(false)
        window.clearTimeout(timerRef.current)
        stream.getTracks().forEach((t) => t.stop())
        try {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          const { data } = await chatAPI.transcribe(blob)
          cbRef.current?.(data.text)
        } catch (err: any) {
          notify.error(err?.response?.data?.detail || '语音转写失败')
        } finally {
          chunksRef.current = []
          mediaRecorderRef.current = null
        }
      }
      recorder.start()
      setRecording(true)
      timerRef.current = window.setTimeout(() => mediaRecorderRef.current?.stop(), maxSeconds * 1000)
    } catch {
      notify.error('无法使用麦克风，请检查浏览器权限')
    }
  }, [recording, stop, maxSeconds])

  // 卸载时清理
  useEffect(() => () => {
    window.clearTimeout(timerRef.current)
    mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop())
  }, [])

  return { recording, toggle, stop }
}
