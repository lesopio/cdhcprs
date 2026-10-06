import { useEffect } from 'react'
import { useSettingsStore, applyThemeAndFont } from '@/stores/settings'

/**
 * 订阅 settings store，把 themeMode/fontSizeMode 同步到 documentElement。
 * 替代 Vue 版 settings.ts 的 watch immediate + App.vue 的 watch route 重新应用。
 * 挂在应用根部，只跑副作用、不渲染 DOM。
 */
export default function ThemeAndFontSync() {
  const themeMode = useSettingsStore((s) => s.themeMode)
  const fontSizeMode = useSettingsStore((s) => s.fontSizeMode)

  useEffect(() => {
    applyThemeAndFont()
  }, [themeMode, fontSizeMode])

  // 首次挂载也应用一次（覆盖 localStorage 里读取的初始值）
  useEffect(() => {
    applyThemeAndFont()
  }, [])

  return null
}
