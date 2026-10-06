import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import MaterialIcon from '@/components/MaterialIcon'
import { cn } from '@/lib/utils'

/**
 * 春分谱弹层（todo C：修复 body 下“第 3 个 div”的定位模糊 + 统一层叠）
 *
 * 1. 挂载位置：Radix 的 DialogPortal 以 asChild 方式把 Overlay/Content 直接
 *    挂到 document.body（react-dialog@1.1.23 dist 第 94 行），不会生成包裹 div；
 *    且 DialogPortal 会丢弃 className。因此用 data 属性 + 固定类名在
 *    Overlay / Content 两个真实 DOM 节点上打稳定标识：
 *      遮罩   → [data-cdhc-overlay="dialog"] .cdhc-dialog-overlay
 *      内容   → [data-cdhc-content="dialog"] .cdhc-dialog-content
 *      关闭钮 → [data-slot="dialog-close"]
 *    DevTools 里 body 下匿名弹层 div 从此可按选择器直接定位。
 *
 * 2. 层叠约定（全站弹层唯一真相，Sheet 同步遵守，见 sheet.tsx 顶部注释）：
 *      topbar 10（styles/shell.css:183）< 侧栏 30（styles/shell.css:42）
 *      < Dialog/Sheet 遮罩+内容 50（此处，多弹层按挂载顺序后者在上）
 *      < 全局状态胶囊 1000（components/BackendStatus.tsx:55，只读范围外）
 *      < sonner toast（sonner 默认 z-index: 999999999，永远置顶）
 */

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="dialog-overlay"
    data-cdhc-overlay="dialog"
    className={cn(
      'cdhc-dialog-overlay',
      // 规格 §3 弹层遮罩：中性纯色压暗，无模糊；消费 --color-overlay
      // （tokens.css 四主题供给，graphite 下即规格值 rgba(0,0,0,0.32)，
      // night 加深至 0.60 照 vercel dark），Dialog/Sheet/AlertDialog 三组件共用
      'fixed inset-0 z-50 bg-[color:var(--color-overlay)]',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

interface DialogContentProps
  extends Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'children'> {
  children?: React.ReactNode
  /** 隐藏右上角自动关闭按钮（消费方自带关闭钮时用，如 TriageDialog 的头部关闭钮） */
  hideClose?: boolean
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, hideClose = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      {...props}
      data-slot="dialog-content"
      data-cdhc-content="dialog"
      className={cn(
        'cdhc-dialog-content',
        // 居中浮层：小屏留 1rem 边距，默认上限 560px（className/style 可覆盖，
        // TriageDialog / Admin / Profile 均经 style.maxWidth 覆盖为更宽档）
        'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-[560px] -translate-x-1/2 -translate-y-1/2',
        // 规格 §3 弹层面板：白底（var(--color-surface)→#FFFFFF）、hairline #E5E5E5 描边
        // （var(--color-borderPrimary)）、float 阴影（消费 --shadow-float，规格 §2
        // vercel 值，night 有加深覆盖）；className/style 仍可整体覆盖
        // （TriageDialog / Admin / Profile 均经其覆盖宽档）
        'rounded-[var(--border-radius-xl)] border border-[color:var(--color-borderPrimary)]',
        'bg-[color:var(--color-surface,#fff)] p-6 text-[color:var(--color-textSecondary)]',
        'shadow-[var(--shadow-float)]',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        className,
      )}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close
          data-slot="dialog-close"
          className={cn(
            'absolute right-4 top-4 flex h-8 w-8 items-center justify-center',
            'rounded-[var(--border-radius-md)] text-[color:var(--color-textTertiary)]',
            // 幽灵图标钮（规格 §1/§3）：hover 黑 5% 圆角块；聚焦环近黑（--color-primary→#1B1B1B）
            'transition-colors duration-150 hover:bg-[color:var(--color-primarySoft)] hover:text-[color:var(--color-textPrimary)]',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
          )}
          aria-label="关闭"
        >
          <MaterialIcon name="close" size={18} />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="dialog-header"
    className={cn('flex flex-col space-y-1.5 text-left', className)}
    {...props}
  />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="dialog-footer"
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="dialog-title"
    className={cn(
      // 规格 §3 弹层标题：宋体系衬线 + 近黑文本
      'text-lg font-semibold leading-snug tracking-normal',
      '[font-family:var(--font-family-serif)] text-[color:var(--color-textPrimary)]',
      className,
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="dialog-description"
    className={cn('text-sm text-[color:var(--color-textTertiary)]', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
