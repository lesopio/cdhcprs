# 橘泉智养（cdhcprs）待办事项

> 更新时间：2026-09-28
> 状态说明：React 重构已上线（frontend-react/dist，nginx 已指向）。
> **2026-09-28：A / B / C 三项已在本地副本完成并经真实流程验收**（见文末「2026-09-28 完成记录」），以下原文保留作需求存档。

---

## A. 问诊入口改版（✅ 2026-09-28 本地完成）

当前的「选择问诊方式」弹窗（consultationEntryOpen Dialog）**废弃不要**，入口统一为**欢迎墙**（welcome-state，即"开始一段新的问诊"那面墙）。

1. **欢迎墙作为唯一入口**：新问诊、无会话、空态全部落在这里，不再弹 Dialog。
   - 相关代码：`frontend-react/src/pages/Chat.tsx` 中 `setConsultationEntryOpen(true)` 的全部调用点（loadConversations 空列表、submitMessage 无 currentId、路由 ?new=1 watcher）以及 `consultationEntryOpen` Dialog JSX 块。
2. **欢迎墙选「分诊问诊」（account_tree 图标）**：不再弹出 4 步 TriageDialog（`src/components/TriageDialog.tsx`），而是**直接在对话容器（消息流）里逐级输出分诊选择**——分类 → 疾病 → 辨证 → 症状确认，以消息卡片形式渲染在 `.thread` 里（可基于 `IntakeOptions` 组件扩展成分诊选择卡），选择完成后组装 `TriageResult` 走原 `saveTriage` 逻辑（createConversation + 关联 triage）。
3. **欢迎墙选「AI 主动问诊」**：所有问诊问题放在**一个卡片**里展示，卡片内做**「上一问 / 下一问」**步骤导航（progress 指示 + 按钮），逐题作答后一次性/按序提交（后端 intake SSE 协议不变，见 `src/hooks/useSseChat.ts` 的 `intake.turn`/`intake.complete` 处理）。
4. **过渡动画**：欢迎墙 → 对话容器、分诊选择逐级展开、问答卡片切换，用 gsap（依赖已装）做入场/切换动画，遵守 `prefers-reduced-motion`。

## B. 全局视觉放大（✅ 2026-09-28 本地完成）

现状等效约 112%，目标**等效 125%**：
- 上调 `frontend-react/src/styles/tokens.css` 的 `--font-size-xs ~ --font-size-4xl` 基准档位
- 关键组件尺寸同步放大：侧栏（.side-btn/.recent/.brand）、聊天气泡与输入框、欢迎墙、按钮
- 注意与现有三档字号模式（`font-size-modes.css` 的 normal/large/extra-large）叠加后的效果

## C. `/html/body/div[3]` 的 bug + 美化（✅ 2026-09-28 本地完成）

- body 下第 3 个 div 是 Radix portal 挂载到 body 的弹层容器（Dialog/Sheet 共用 portal 位置）
- 待办：用 jsdom 或浏览器枚举定位具体是哪个弹层（疑似新问诊 Dialog，其 DialogContent 默认样式 `max-w-lg p-6` 与春分谱风格不符且与遮罩/侧栏层叠有细节问题）
- 修复后按春分谱 token 重新设计弹窗样式（圆角/间距/字体/按钮）

## D. 需要用户手动做的

- [ ] 管理后台 → 系统设置 → **站点名称**改为「橘泉智养」（存后端数据库，代码无法替代；登录卡与关于页顶部站名读自此设置）

## E. 运维备忘

- 2026-09-18：已禁用 nginx 的 `cdhcprs`(80) 与 `frontend`(8124) 两个站点并 reload —— **公网出口已撤**（SSH 22 / 443 lico-sync 不受影响）
- 回滚方法：`ln -s /etc/nginx/sites-available/cdhcprs /etc/nginx/sites-enabled/ && ln -s /etc/nginx/sites-available/frontend /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx`
- 本地预览（不下线公网的前提下）：`cd frontend-react && pnpm dev`（127.0.0.1:5174）
- 全量代码备份：`/root/橘泉.zip`（排除 node_modules）、赤潮备份：`/root/赤潮.zip`

---

## 2026-09-28 完成记录（本地副本 D:\慢性病诊疗LLM\cdhcprs-latest）

**A 问诊入口改版**：`consultationEntryOpen` Dialog 及全部调用点删除，欢迎墙为唯一入口；新组件 `TriageFlow.tsx`（消息流内逐级分诊卡：进度条 + 折叠摘要/修改回跳级联 + 急危提示，gsap 入场动画）替代新建路径的 TriageDialog（编辑模式保留）；新组件 `IntakeStepCard.tsx`（AI 主动问诊单卡：上一问/下一问 + 进度圆点 + 单选即答/多选提交，已答题只读回看）；`useSseChat.ts` 新增 `onIntakeTurn` 回调承载问题累积，SSE 协议未改。欢迎墙升级为图标徽章 + 三张模式卡。

**B 全局视觉放大**：`tokens.css` 字号档位约 1.12 倍上调；`font-size-modes.css` 新增 `html{font-size:var(--font-size-base)}`（normal 18px，等效约 125%，三档相对关系不变）；AppSidebar/Topbar 内联放大；Chat.tsx 内联样式同步（rail 300px、thread/dock 880px、气泡 16px、工具/发送按钮 40px 等）。

**C 弹层修复美化**：`dialog.tsx`/`sheet.tsx` 重写为春分谱弹层（16px 圆角、token 化描边/阴影/遮罩、衬线标题、hideClose）；portal 经 Radix 源码核实无包裹容器，改用 `[data-cdhc-overlay]/[data-cdhc-content]` 稳定标识；z-index 层叠约定固化（topbar 10 < 侧栏 30 < 弹层 50 < 状态胶囊 1000 < sonner）；TriageDialog 样式对齐。

**验收**：pnpm build（tsc -b && vite build）与 oxlint 通过；浏览器真实流程（后端 127.0.0.1:8001 + vite dev + 测试账号 acceptance_test）走通：登录 → 欢迎墙唯一入口 → 分诊四步内嵌流（分类→疾病→辨证→确认）→ guided 会话 + SSE 流式回答（含引用）→ AI 主动问诊步骤卡（多选提交/单选即答/前后导航回看）→ 欢迎墙直接输入自动建自由问诊会话。遗留（低优先级）：BackendStatus 状态胶囊 z-index 1000 高于弹层；Login/Home 等页面内部 px 字号未随 B 放大（不在本次范围）；页面存在无限循环动画（状态胶囊 pulse 等）会干扰部分自动化工具的元素稳定性判定，对人工使用无影响。

**待用户手动**：D 项（管理后台站点名称改「橘泉智养」）仍未做；本批改动仅在本地副本，**未部署回服务器**（需要时明确授权）。
