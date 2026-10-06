import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { useConfirmStore } from '@/lib/toast'

/**
 * 全局确认弹窗 —— 替代 Vue 版的 <Teleport> + alma:confirm window 事件机制。
 * 订阅 useConfirmStore；由 lib/toast.ts 的 confirmDialog() 触发。
 * 挂在应用根部（main.tsx 的根 Provider 树里）。
 */
export default function ConfirmDialog() {
  const open = useConfirmStore((s) => s.open)
  const title = useConfirmStore((s) => s.title)
  const message = useConfirmStore((s) => s.message)
  const close = useConfirmStore((s) => s._close)

  // Radix 的 onOpenChange 在用户按 ESC 或点遮罩时会传 false；那种情况视为取消
  return (
    <AlertDialog open={open} onOpenChange={(v: boolean) => { if (!v) close(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => close(false)}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => close(true)}>确认</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
