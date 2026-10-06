import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import './styles/fonts.css'
import './styles/globals.css'
import './styles/tokens.css'
import './styles/font-size-modes.css'
import './styles/shell.css'
import './i18n' // 副作用：初始化 i18next + react-i18next
import App from './App'
import ConfirmDialog from '@/components/shell/ConfirmDialog'
import ThemeAndFontSync from '@/stores/ThemeAndFontSync'
import { useSettingsStore } from '@/stores/settings'

/** 全局 Toast：主题跟随四主题（探查 ux 项）——夜阑传 sonner 'dark'，三个浅色主题传 'light'。
 * 独立小组件订阅 settings store，themeMode 变化时实时跟随；其余样式保持原样。
 * 本文件为应用入口，不参与 fast refresh 单元，禁用该条 react-refresh 规则（同 Chat.tsx 行内禁用先例）。 */
// eslint-disable-next-line react/only-export-components
function ThemedToaster() {
  const themeMode = useSettingsStore((s) => s.themeMode)
  return (
    <Toaster
      theme={themeMode === 'night' ? 'dark' : 'light'}
      position="top-center"
      richColors
      closeButton
      toastOptions={{
        style: {
          // 跟随春分谱：圆角 + 春分谱纸面感
          borderRadius: 'var(--radius, 10px)',
          fontFamily: 'var(--font-family-base)',
        },
      }}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeAndFontSync />
      <App />
      <ConfirmDialog />
      <ThemedToaster />
    </BrowserRouter>
  </StrictMode>,
)
