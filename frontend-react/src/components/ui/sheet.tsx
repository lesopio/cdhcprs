import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cva, type VariantProps } from 'class-variance-authority'
import MaterialIcon from '@/components/MaterialIcon'
import { cn } from '@/lib/utils'

/**
 * 春分谱侧滑层（todo C：与 dialog.tsx 统一遮罩、层叠与稳定标识）
 *
 * 1. 挂载位置：Radix 的 SheetPortal（即 DialogPortal）以 asChild 把
 *    Overlay/Content 直接挂到 document.body，不会生成包裹 div；
 *    用 data 属性 + 固定类名在真实 DOM 节点上打稳定标识：
 *      遮罩   → [data-cdhc-overlay="sheet"] .cdhc-sheet-overlay
 *      内容   → [data-cdhc-content="sheet"] .cdhc-sheet-content
 *
 * 2. 层叠约定（与 dialog.tsx 顶部注释一致，全站弹层唯一真相）：
 *      topbar 10 < 侧栏 30（styles/shell.css）< Sheet/Dialog 遮罩+内容 50
 *      < 全局状态胶囊 1000 < sonner toast（默认 999999999）。
 *    Sheet 与 Dialog 同层，多个弹层同开时按 DOM 挂载顺序后者在上，
 *    遮罩一律盖住侧栏与顶栏。
 */

const Sheet = DialogPrimitive.Root
const SheetTrigger = DialogPrimitive.Trigger
const SheetClose = DialogPrimitive.Close
const SheetPortal = DialogPrimitive.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="sheet-overlay"
    data-cdhc-overlay="sheet"
    className={cn(
      'cdhc-sheet-overlay',
      // 与 Dialog/AlertDialog 同一遮罩：消费 --color-overlay（规格 §3 中性压暗，
      // night 加深至 0.60 照 vercel dark），无模糊
      'fixed inset-0 z-50 bg-[color:var(--color-overlay)]',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
))
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName

const sheetVariants = cva(
  // 规格 §3 弹层：白底面板（var(--color-surface)→#FFFFFF）+ float 阴影（与 DialogContent
  // 同消费 --shadow-float，规格 §2 vercel 值，night 有加深覆盖）；边缘 hairline 用
  // var(--color-borderPrimary)→#E5E5E5，由各 side 变体给出
  'cdhc-sheet-content fixed z-50 bg-[color:var(--color-surface,#fff)] p-0 shadow-[var(--shadow-float)] transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500',
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b border-[color:var(--color-borderPrimary)] data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        bottom: 'inset-x-0 bottom-0 border-t border-[color:var(--color-borderPrimary)] data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        left: 'inset-y-0 left-0 h-full w-3/4 border-r border-[color:var(--color-borderPrimary)] data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
        right: 'inset-y-0 right-0 h-full w-3/4 border-l border-[color:var(--color-borderPrimary)] data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
      },
    },
    defaultVariants: { side: 'right' },
  },
)

interface SheetContentProps
  extends Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'children'>,
    VariantProps<typeof sheetVariants> {
  hideClose?: boolean
  children?: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ side = 'right', className, children, hideClose, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      {...props}
      data-slot="sheet-content"
      data-cdhc-content="sheet"
      className={cn(sheetVariants({ side }), className)}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close
          data-slot="sheet-close"
          className={cn(
            'absolute right-4 top-4 flex h-8 w-8 items-center justify-center',
            'rounded-[var(--border-radius-md)] text-[color:var(--color-textTertiary)]',
            // 幽灵图标钮（规格 §1/§3）：hover 黑 5% 圆角块；聚焦环近黑
            'transition-colors duration-150 hover:bg-[color:var(--color-primarySoft)] hover:text-[color:var(--color-textPrimary)]',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
          )}
          aria-label="关闭"
        >
          <MaterialIcon name="close" size={18} />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </SheetPortal>
))
SheetContent.displayName = DialogPrimitive.Content.displayName

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="sheet-header"
    className={cn('flex flex-col space-y-2 text-left p-6 pb-4', className)}
    {...props}
  />
)
SheetHeader.displayName = 'SheetHeader'

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="sheet-title"
    className={cn(
      // 与 DialogTitle 一致：衬线 + 近黑（规格 §3 弹层标题）
      'text-lg font-semibold leading-snug tracking-normal',
      '[font-family:var(--font-family-serif)] text-[color:var(--color-textPrimary)]',
      className,
    )}
    {...props}
  />
))
SheetTitle.displayName = DialogPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="sheet-description"
    className={cn('text-sm text-[color:var(--color-textTertiary)]', className)}
    {...props}
  />
))
SheetDescription.displayName = DialogPrimitive.Description.displayName

export {
  Sheet, SheetTrigger, SheetClose, SheetPortal, SheetOverlay,
  SheetContent, SheetHeader, SheetTitle, SheetDescription,
}
