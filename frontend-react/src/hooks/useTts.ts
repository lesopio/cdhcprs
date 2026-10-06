import { useCallback, useEffect, useRef, useState } from 'react'
import { chatAPI } from '@/api/chat'
import { notify } from '@/lib/toast'

/**
 * TTS 朗读 hook（迁移自 Vue 版 Chat.vue toggleSpeech/stopSpeech）
 *
 * 内部维护：
 * - 一个 audio 元素引用（当前播放的音频）
 * - 一个 Map<messageId, objectURL> 缓存
 * - playingMessageId 状态（当前正在播放的消息 id）
 *
 * 2026-09 加固：
 * - 组件卸载时 pause 当前音频并 revoke 全部 blob objectURL，避免内存泄漏与后台继续发声。
 * - toggle 改读同步 ref（不再依赖 playingMessageId state），identity 稳定，
 *   调用方（Chat 消息项 React.memo）可放心把它作为稳定 handler 传递。
 */
export function useTts() {
  const [playingMessageId, setPlayingMessageId] = useState<number | undefined>(undefined)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const cacheRef = useRef<Map<number, string>>(new Map())
  // 与 playingMessageId 同步的 ref：让 toggle 不依赖 state（identity 稳定）
  const playingIdRef = useRef<number | undefined>(undefined)

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    audioRef.current = null
    playingIdRef.current = undefined
    setPlayingMessageId(undefined)
  }, [])

  const toggle = useCallback(async (messageId: number) => {
    const currentAudio = audioRef.current
    if (currentAudio && playingIdRef.current === messageId) {
      if (currentAudio.paused) {
        await currentAudio.play()
        setPlayingMessageId(messageId)
        playingIdRef.current = messageId
      } else {
        currentAudio.pause()
        setPlayingMessageId(undefined)
        playingIdRef.current = undefined
      }
      return
    }
    stop()
    let url = cacheRef.current.get(messageId)
    if (!url) {
      try {
        const response = await fetch(chatAPI.ttsUrl(messageId), {
          headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
        })
        if (!response.ok) { notify.error('朗读服务调用失败'); return }
        url = URL.createObjectURL(await response.blob())
        cacheRef.current.set(messageId, url)
      } catch {
        notify.error('朗读服务调用失败')
        return
      }
    }
    const audio = new Audio(url)
    audio.onended = () => {
      playingIdRef.current = undefined
      setPlayingMessageId(undefined)
      audioRef.current = null
    }
    audioRef.current = audio
    await audio.play()
    setPlayingMessageId(messageId)
    playingIdRef.current = messageId
  }, [stop])

  // 卸载清理：停掉播放 + 回收全部 objectURL（blob URL 不 revoke 会一直占内存）
  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    cacheRef.current.forEach((url) => URL.revokeObjectURL(url))
    cacheRef.current.clear()
    playingIdRef.current = undefined
  }, [])

  return { playingMessageId, toggle, stop }
}
