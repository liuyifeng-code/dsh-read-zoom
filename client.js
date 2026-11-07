/**
 * 放大阅读（dsh-read-zoom）— DSH 插件（浏览器半）。
 *
 * 解决：会话里助手回答的正文字号偏小，长时间阅读眼睛累。
 * 做法：不碰 React 组件树、不改 app.asar，只做 DOM 增强——
 *   1) 【主入口】每条回答底部那排操作图标（复制 / 点赞 / 分支 / 用量 / 时间）里，
 *      在「用量」图标左边常驻一个「放大阅读」按钮（位置固定，不随鼠标漂移）；
 *   2) 浮层内容 = 这条消息 DOM 的克隆（公式 / 表格 / 代码 / 图片的渲染结果原样保留，
 *      包括 KaTeX），再用 CSS `zoom` 整体等比放大；
 *   3) 浮层顶栏 A− / 百分比（点击重置）/ A+ / 复制文字 / 关闭，Esc、点蒙层也能关；
 *   4) 键盘 Alt+Z 直接放大「离视口最近的那条回答」；右下角常驻一个 Aa 小按钮
 *      （固定位置，同样是放大最近一条回答），保证功能可发现。
 *
 * v0.2.1 起移除了「鼠标悬停时浮出药丸」的行为：药丸会跟着消息/滚动漂移，
 * 干扰阅读；入口改为操作行里的常驻按钮。
 * v0.2.2 修「切换会话后放大面板显示上一个会话的回答」：定位回答不再按整页文档顺序，
 * 而是先锁定当前会话容器（data-conversation-session），再按轮次（data-chat-turn）匹配。
 * v0.3.0 面板改成双栏：
 *   - 左栏是本会话的「轮次列表」（每轮一条，带提问摘要），点一下就切换到那一轮的提问+回答；
 *     底部还有一个输入框，可以把想法先写好，点「填入输入框」写回 DSH 的真实输入框（不自动发送）；
 *   - 右栏是放大后的正文，长公式会自动等比缩小到放得下，渲染失败的公式降级成可读的原始写法；
 *   - 顶栏多一个「公式规约」按钮，一键复制数学/化学输出规约（可粘进 AGENTS.md）。
 *
 * 放大倍数记在 localStorage（键 dsh-read-zoom:zoom），默认 140%。
 * 纯 DOM 实现，因此 DSH 前端升级后只要消息里仍带 data-text-interaction-source 就有效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-read-zoom',
  factory: () => {
    const STYLE_ID = 'dsh-read-zoom/style.css'
    const LS_KEY = 'dsh-read-zoom:zoom'
    const DEFAULT_ZOOM = 1.4
    const MIN_ZOOM = 0.8
    const MAX_ZOOM = 3
    const STEP = 0.1
    const HOST_ATTR = 'data-text-interaction-source'
    const GUARD = 'dsh-read-zoom'
    // 版本号：DOM 上会写进 data-dshzr-version，便于在真实 DSH 里确认加载的是哪一版。
    const VERSION = '0.3.0'
    // 每轮回答底部的操作行所在容器（DSH chat 的 TurnTailNodeView 带这个属性）。
    const TAIL_ATTR = 'data-turn-tail'
    // 16px 对角双箭头（放大/展开），药丸与操作行按钮共用；stroke 用 currentColor 跟随主题。
    const EXPAND_ICON =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M9.9 2.4h3.7v3.7M13.3 2.7 9.2 6.8M6.1 13.6H2.4V9.9M2.7 13.3l4.1-4.1"/></svg>'

    /**
     * 数学 / 化学输出规约（随插件分发，点顶栏「公式规约」可一键复制）。
     * DSH 前端是 micromark + KaTeX 0.18.7，解析层有几个已知坑，写公式时按这份清单来就不会出红字或吞字。
     */
    const MATH_RULES = [
      '## 数学/公式输出规约（DSH 前端渲染兼容）',
      '',
      '1. 行内公式用 `$...$` 或 `\\(...\\)`；不要在句子中间写 `\\[...\\]`（行内没有 tokenizer，反斜杠会被吞成字面 `[x]`）。',
      '2. 独立公式块用 `$$`：`$$` 必须独占一行开头、独占一行结尾；同一行不要写两个 `$$…$$`（闭合要求接行尾，否则整行被贪婪并成一个公式）。',
      '3. 不要用 `latex` / `tex` 代码围栏装公式；需要隔离时用 math 围栏（三个反引号 + `math`）。',
      '4. 只用 KaTeX 子集：多行对齐用 `aligned`（不是 `align`），矩阵用 `pmatrix`/`bmatrix`；不要用 `\\label`/`\\ref`；`\\tag` 只能用在 display 公式里。',
      '5. 金额里的 `$` 写成 `\\$`（正文里两个未转义的 `$` 会被配成行内公式，把中间文字吞进数学环境）。',
      '6. 表格里的公式含竖线时用 `\\lvert … \\rvert`，不要用裸 `|`（会被 GFM 当单元格分隔符）。',
      '7. 超长公式优先拆成 `aligned` 多行（DSH 里 display 公式只横滚不换行）。',
      '8. 生成过程中公式先显示 TeX 源码、结束后才渲染，这是流式设计，不是错误。',
      '9. 化学式与反应式：DSH 没有 mhchem，`\\ce{}`/`\\pu{}`/`\\SI{}`/`\\qty{}`/`\\unit{}` 必红。',
      '   化学式写成 `\\mathrm{H_2O}`、`\\mathrm{SO_4^{2-}}`、`\\mathrm{CuSO_4 \\cdot 5H_2O}`；',
      '   反应式用 `\\rightarrow` / `\\rightleftharpoons`，条件写成 `\\mathrm{CaCO_3 \\xrightarrow{\\text{高温}} CaO + CO_2}`；',
      '   沉淀/气体写 `\\downarrow` / `\\uparrow`；纯文本段落直接写 Unicode 下标与箭头（H₂O、CO₂ + H₂O → H₂CO₃、SO₄²⁻）最稳。',
    ].join('\n')

    // 轻量调试日志：window.__DSHZR_LOG__ 保留最近 200 条，装到真实 DSH 后排查选择器/事件问题用。
    const LOG = (window.__DSHZR_LOG__ = window.__DSHZR_LOG__ || [])
    function dbg(...parts) {
      try {
        LOG.push(parts.join(' '))
        if (LOG.length > 200) LOG.splice(0, LOG.length - 200)
      } catch (error) {
        /* 调试日志失败不影响功能 */
      }
    }

    /* ── 样式 ──────────────────────────────────────────────────────────── */
    const CSS = [
      /* 回答底部操作行里的「放大阅读」按钮：外观沿用 DSH 原生图标按钮的 class，
         这里只补几条兜底规则，避免 DSH 改版后完全没样式。 */
      '.dshzr-tail-btn{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8a8a91);',
      'background:0 0;border:none;cursor:pointer;display:inline-flex;align-items:center;',
      'justify-content:center;padding:6px;border-radius:var(--dsw-radius-sm,6px)}',
      '.dshzr-tail-btn svg{width:15px;height:15px;display:block}',
      '.dshzr-tail-btn:hover{color:var(--dsw-alias-label-primary,#191919);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',

      /* 右下角常驻的 Aa 小按钮 */
      '.dshzr-fab{position:fixed;right:16px;bottom:18px;z-index:2147481900;',
      'box-sizing:border-box;width:34px;height:34px;border-radius:50%;cursor:pointer;',
      'display:flex;align-items:center;justify-content:center;padding:0;',
      'font:600 13px/1 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'letter-spacing:-.5px;color:var(--dsw-alias-label-secondary,#6b6b71);',
      'background:var(--dsw-alias-bg-layer-3,#ffffff);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'box-shadow:0 2px 10px rgba(0,0,0,.10);opacity:.72;',
      'transition:opacity .15s ease,transform .15s ease,background-color .15s ease}',
      '.dshzr-fab:hover{opacity:1;transform:translateY(-1px);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dshzr-fab:focus-visible,.dshzr-pill:focus-visible,.dshzr-btn:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary,#8a8a91);outline-offset:2px}',

      /* 全屏阅读浮层 */
      '.dshzr-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;',
      'justify-content:center;padding:3vh 3vw;box-sizing:border-box;',
      'background:var(--dsw-alias-bg-mask-1,rgba(16,18,22,.55));backdrop-filter:blur(2px)}',
      '.dshzr-panel{display:flex;flex-direction:column;width:min(1280px,96vw);height:min(92vh,940px);',
      'max-height:94vh;',
      'box-sizing:border-box;overflow:hidden;',
      'border-radius:var(--dsw-radius-panel,16px);',
      'background:var(--dsw-alias-bg-layer-2,#ffffff);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));',
      'box-shadow:var(--dsw-shadow-lv3,0 24px 64px rgba(0,0,0,.28))}',
      '.dshzr-main{display:flex;flex:1 1 auto;min-height:0;overflow:hidden}',

      /* 左栏：轮次列表 + 输入框 */
      '.dshzr-turns{width:268px;flex:0 0 268px;display:flex;flex-direction:column;min-height:0;',
      'border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));',
      'background:var(--dsw-alias-bg-layer-1,#fafafa)}',
      '.dshzr-turns-head{flex:none;padding:10px 12px 6px;',
      'font:500 12px/1.4 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-tertiary,#8a8a91)}',
      '.dshzr-turns-list{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 8px 8px}',
      '.dshzr-turn{display:flex;gap:8px;width:100%;box-sizing:border-box;text-align:left;cursor:pointer;',
      'padding:8px 9px;margin:2px 0;border:1px solid transparent;border-radius:10px;background:transparent;',
      'font:400 12.5px/1.45 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-secondary,#6b6b71)}',
      '.dshzr-turn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));',
      'color:var(--dsw-alias-label-primary,#191919)}',
      '.dshzr-turn[data-active]{background:var(--dsw-alias-bg-layer-3,#ffffff);',
      'border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.10));color:var(--dsw-alias-label-primary,#191919)}',
      '.dshzr-turn-no{flex:none;min-width:16px;text-align:right;font-variant-numeric:tabular-nums;',
      'color:var(--dsw-alias-label-tertiary,#8a8a91)}',
      '.dshzr-turn-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshzr-compose{flex:none;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));padding:8px 10px 10px}',
      '.dshzr-compose textarea{display:block;width:100%;box-sizing:border-box;min-height:64px;max-height:180px;',
      'resize:vertical;padding:7px 9px;border-radius:8px;outline:none;',
      'font:400 12.5px/1.5 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-primary,#191919);background:var(--dsw-alias-bg-layer-2,#fff);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12))}',
      '.dshzr-compose textarea:focus{border-color:var(--dsw-alias-label-tertiary,#8a8a91)}',
      '.dshzr-compose-row{display:flex;gap:6px;margin-top:6px}',
      '.dshzr-compose-row .dshzr-btn{height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'background:var(--dsw-alias-bg-layer-2,#fff)}',
      '.dshzr-compose-row .dshzr-btn[data-primary]{background:var(--dsw-alias-label-primary,#191919);',
      'border-color:transparent;color:var(--dsw-alias-bg-layer-2,#fff)}',
      '.dshzr-compose-note{flex:1 1 auto;align-self:center;text-align:right;',
      'font:400 11px/1.4 var(--dsw-font-family,-apple-system,sans-serif);color:var(--dsw-alias-label-tertiary,#8a8a91)}',

      /* 右栏：正文 */
      '.dshzr-item{position:relative;padding-left:14px}',
      '.dshzr-item[data-kind="user"]{margin-bottom:18px}',
      '.dshzr-item-tag{display:block;margin:0 0 6px;',
      'font:500 11px/1.4 var(--dsw-font-family,-apple-system,sans-serif);letter-spacing:.04em;',
      'color:var(--dsw-alias-label-tertiary,#8a8a91)}',
      '.dshzr-head{display:flex;align-items:center;gap:6px;flex:none;padding:10px 12px 10px 16px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
      '.dshzr-title{font:600 14px/1.4 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-primary,#191919);flex:none}',
      '.dshzr-hint{font:400 12px/1.4 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-tertiary,#8a8a91);margin-left:8px;white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis}',
      '.dshzr-spacer{flex:1 1 auto;min-width:8px}',
      '.dshzr-btn{box-sizing:border-box;height:28px;min-width:28px;padding:0 9px;border-radius:8px;cursor:pointer;',
      'font:500 12px/1 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-secondary,#6b6b71);background:transparent;border:none;',
      'display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}',
      '.dshzr-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));',
      'color:var(--dsw-alias-label-primary,#191919)}',
      '.dshzr-zoom{min-width:52px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#191919)}',
      '.dshzr-close{margin-left:4px}',
      '.dshzr-scroller{flex:1 1 auto;min-width:0;overflow:auto;overscroll-behavior:contain;',
      'padding:20px 28px 40px;box-sizing:border-box}',
      '.dshzr-content{zoom:1.4;transform-origin:top left}',
      '.dshzr-content .katex-display{overflow-x:auto;overflow-y:hidden;max-width:100%;padding:2px 0}',
      '.dshzr-content .katex-display > .katex{display:inline-block;transform-origin:left center}',
      '.dshzr-content .katex-error{color:var(--dsw-alias-label-secondary,#6b6b71)!important;',
      'background:var(--dsw-alias-bg-layer-1,#f4f4f6);border-radius:5px;padding:1px 5px;',
      'font:400 .92em/1.5 var(--dsw-font-markdown-code,ui-monospace,SFMono-Regular,Consolas,monospace)!important;',
      'white-space:pre-wrap;word-break:break-word}',
      '.dshzr-content table{max-width:100%}',
      '.dshzr-content button,.dshzr-content [role="button"]{display:none!important}',
      '.dshzr-content *{max-width:100%;box-sizing:border-box}',
      '.dshzr-content [class*="actions"]{display:none!important}',
      '.dshzr-content img,.dshzr-content video{height:auto}',
      '.dshzr-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483500;',
      'padding:8px 14px;border-radius:999px;font:500 12px/1.4 var(--dsw-font-family,-apple-system,sans-serif);',
      'color:var(--dsw-alias-label-primary,#191919);background:var(--dsw-alias-toast-bg,rgba(24,26,30,.92));',
      'color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.22);opacity:0;transition:opacity .18s ease}',
      '.dshzr-toast[data-on]{opacity:1}',
      'body.dshzr-noscroll{overflow:hidden!important}',
      '@media (prefers-reduced-motion:reduce){.dshzr-pill,.dshzr-fab,.dshzr-toast{transition:none}}',
    ].join('')

    function installStyle() {
      let tag = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = GUARD
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
      return () => {
        if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    /* ── 小工具 ────────────────────────────────────────────────────────── */
    function clampZoom(value) {
      const rounded = Math.round(value * 10) / 10
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rounded))
    }

    function readZoom() {
      try {
        const raw = window.localStorage.getItem(LS_KEY)
        const parsed = raw === null ? NaN : Number.parseFloat(raw)
        if (Number.isFinite(parsed)) return clampZoom(parsed)
      } catch (error) {
        /* localStorage 不可用时用默认值 */
      }
      return DEFAULT_ZOOM
    }

    function writeZoom(value) {
      try {
        window.localStorage.setItem(LS_KEY, String(value))
      } catch (error) {
        /* 忽略：只是记不住偏好 */
      }
    }

    function makeButton(label, title) {
      const node = document.createElement('button')
      node.type = 'button'
      node.className = 'dshzr-btn'
      node.textContent = label
      node.title = title
      node.setAttribute('aria-label', title)
      return node
    }

    function textOf(node) {
      const text = node && typeof node.innerText === 'string' ? node.innerText : node ? node.textContent : ''
      return (text || '').replace(/\n{3,}/g, '\n\n').trim()
    }

    /* ── 找到「一条助手消息」 ──────────────────────────────────────────── */
    // DSH 的消息结构（2026-11 UI）：<div class="xMeOpW_root"><div class="xMeOpW_body"> …块… </div></div>
    // 类名里的 hash 前缀会随构建变化，所以用「_body 的父级是 _root」+ 内部含已收敛 markdown 来识别，
    // 不绑定具体 hash。
    const isBodyToken = (token) => /^[A-Za-z0-9_-]{2,20}_body$/.test(token)
    const isRootToken = (token) => /^[A-Za-z0-9_-]{2,20}_root$/.test(token)

    function tokensOf(node) {
      if (!node || node.nodeType !== 1 || !node.classList) return []
      return Array.prototype.slice.call(node.classList)
    }

    function asMessage(node) {
      if (!node || node.nodeType !== 1) return null
      if (!tokensOf(node).some(isBodyToken)) return null
      const parent = node.parentElement
      if (!parent || !tokensOf(parent).some(isRootToken)) return null
      // 只认「已收敛、含 markdown 的助手回答」；用户气泡、思考块、命令卡都不会命中。
      const hasMarkdown = node.querySelector('[' + HOST_ATTR + '][class*="markdown"]')
      if (!hasMarkdown) return null
      return { root: parent, body: node }
    }

    function messageFor(node) {
      let current = node instanceof Element ? node : null
      for (let depth = 0; current && depth < 12; depth += 1) {
        const found = asMessage(current)
        if (found) return found
        current = current.parentElement
      }
      return null
    }

    /**
     * 收集容器内所有「已收敛的助手回答」。
     * 传 scope 时只在那一块 DOM 里找（一次只看一个会话），不传就是整页。
     */
    function settledMessages(scope) {
      const root = scope && typeof scope.querySelectorAll === 'function' ? scope : document
      const blocks = root.querySelectorAll('[' + HOST_ATTR + '][class*="markdown"]')
      const result = []
      for (const block of blocks) {
        const message = messageFor(block)
        if (message === null) continue
        if (root !== document && !root.contains(message.root)) continue
        if (result.indexOf(message) === -1) result.push(message)
      }
      return result
    }

    /**
     * 当前正在看的那个会话容器。
     * 切换会话时旧会话的 DOM 可能还没卸载，靠「可见 + 可见面积最大」挑出真正在看的那一个。
     */
    function activeScope() {
      const scopes = document.querySelectorAll('[' + SESSION_ATTR + ']')
      let best = null
      let bestArea = 0
      for (const scope of scopes) {
        const rect = scope.getBoundingClientRect()
        if (rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) continue
        const area = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)) * rect.width
        if (area > bestArea) {
          best = scope
          bestArea = area
        }
      }
      return best === null ? document : best
    }

    function isVisible(rect) {
      return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
    }

    /** 视口里最靠下的一条已完成回答；都不在视口里就取当前会话里最后一条。 */
    function nearestMessage() {
      const all = settledMessages(activeScope())
      if (all.length === 0) return null
      for (let index = all.length - 1; index >= 0; index -= 1) {
        const message = all[index]
        if (isVisible(message.root.getBoundingClientRect())) return message
      }
      return all[all.length - 1]
    }

    /* ── 回答底部操作行：在「用量」左边常驻一个放大按钮 ──────────────────── */
    function isBefore(node, reference) {
      if (node === reference) return false
      return (node.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    }

    /* ── 会话 / 轮次归属 ────────────────────────────────────────────────
     * 聊天时间线里每个渲染项都带 data-chat-turn（轮次号），整个会话视图带
     * data-conversation-session（会话 id）。切换会话时旧会话的 DOM 可能还留在文档里，
     * 所以绝不能按「整页文档顺序」取上一条回答 —— 必须在「同一个会话容器 + 同一轮次」里找，
     * 否则就会把上一个会话的回答放大出来。
     */
    const SESSION_ATTR = 'data-conversation-session'
    const TURN_ATTR = 'data-chat-turn'
    const FLOW_KIND_ATTR = 'data-chat-flow-kind'

    function scopeOf(node) {
      const scope = node.closest ? node.closest('[' + SESSION_ATTR + ']') : null
      return scope === null ? document : scope
    }

    function itemOf(node) {
      return node.closest ? node.closest('[' + TURN_ATTR + ']') : null
    }

    /** 一个时间线渲染项里承载的回答（先找已收敛的，流式中没有再放宽）。 */
    function messageIn(item) {
      if (!item || typeof item.querySelector !== 'function') return null
      const block =
        item.querySelector('[' + HOST_ATTR + '][class*="markdown"]') || item.querySelector('[class*="markdown"]')
      return block === null ? null : messageFor(block)
    }

    /**
     * 操作行属于哪一条回答：
     * 0) 操作行已不属于当前正在看的会话（切换会话瞬间的残留行）→ 取当前会话最后一条；
     * 1) 按轮次号，在同一会话容器里找同轮次、位于操作行之前的最后一条回答；
     * 2) 拿不到轮次信息时，退化为「同一会话容器内、文档顺序上最近的一条回答」。
     */
    function messageForTail(tail) {
      const item = itemOf(tail)
      const turn = item === null ? null : item.getAttribute(TURN_ATTR)
      const scope = scopeOf(tail)
      const active = activeScope()
      if (active !== document && scope !== active) {
        const messages = settledMessages(active)
        return messages.length === 0 ? null : messages[messages.length - 1]
      }
      if (turn !== null) {
        let found = null
        for (const candidate of scope.querySelectorAll('[' + TURN_ATTR + ']')) {
          if (candidate === item) continue
          if (candidate.getAttribute(TURN_ATTR) !== turn) continue
          if (candidate.getAttribute(FLOW_KIND_ATTR) === 'turn-tail') continue
          if (!isBefore(candidate, tail)) continue
          const message = messageIn(candidate)
          if (message !== null) found = message
        }
        if (found !== null) return found
      }
      let fallback = null
      for (const message of settledMessages(scope)) {
        if (isBefore(message.root, tail)) fallback = message
        else break
      }
      return fallback
    }

    /** 操作行结构：<div class="…_actions"><button…/>…<span class="…_endInfo">{用量}{时间}</span></div> */
    function findRow(tail) {
      const row = tail.querySelector('div[class*="_actions"]')
      if (row === null) return null
      const endInfo = row.querySelector('[class*="_endInfo"]')
      return { row, endInfo }
    }

    function createTailButton(row) {
      // 复用原生图标按钮的 class：尺寸、悬停底色、深色主题全部跟宿主一致。
      const sample = row.querySelector('button[class*="_action"]')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = (sample === null ? '' : sample.className + ' ') + 'dshzr-tail-btn'
      button.title = '放大阅读这条回答（v' + VERSION + '，Alt+Z）'
      button.setAttribute('aria-label', '放大阅读这条回答')
      button.setAttribute('data-dshzr-tail', '')
      button.setAttribute('data-dshzr-version', VERSION)
      button.innerHTML = EXPAND_ICON
      return button
    }

    /**
     * 轮流插入按钮，并盯着 DOM 变化（流式输出 / 切换会话时会整块重渲染）。
     * 幂等：已经在本行的按钮不会重复插入。
     * 优先插在 _endInfo 的首个子节点前（=「用量」左边）；拿不到 _endInfo 时退化为行尾。
     */
    function installActionButtons(openFor) {
      const buttons = new Set()

      function ensure() {
        let added = 0
        for (const tail of document.querySelectorAll('[' + TAIL_ATTR + ']')) {
          const found = findRow(tail)
          if (found === null) continue
          const endInfo = found.endInfo === null ? found.row : found.endInfo
          let alive = null
          for (const button of buttons) {
            if (button.isConnected && button.parentElement === endInfo) {
              alive = button
              break
            }
          }
          if (alive === null) {
            const button = createTailButton(found.row)
            button.addEventListener('click', (event) => {
              event.preventDefault()
              event.stopPropagation()
              const message = messageForTail(tail)
              if (message === null) {
                dbg('tailClick', 'no-message')
                return
              }
              dbg('tailClick', 'open', 'turn=' + (itemOf(tail) === null ? '?' : itemOf(tail).getAttribute(TURN_ATTR)))
              openFor(message)
            })
            if (found.endInfo === null) endInfo.appendChild(button)
            else endInfo.insertBefore(button, endInfo.firstElementChild)
            buttons.add(button)
            added += 1
          } else if (endInfo.firstElementChild !== alive) {
            endInfo.insertBefore(alive, endInfo.firstElementChild)
          }
        }
        for (const button of Array.from(buttons)) {
          if (!button.isConnected) buttons.delete(button)
        }
        if (added > 0) dbg('tailButtons', 'added=' + added)
      }

      ensure()
      let timer = 0
      const observer = new MutationObserver(() => {
        if (timer !== 0) return
        timer = window.setTimeout(() => {
          timer = 0
          ensure()
        }, 80)
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        window.clearTimeout(timer)
        for (const button of buttons) button.remove()
        buttons.clear()
      }
    }

    /* ── 轮次（提问 + 回答）──────────────────────────────────────────────── */
    function summarise(text, limit) {
      const flat = (text || '').replace(/\s+/g, ' ').trim()
      if (flat.length <= limit) return flat
      return flat.slice(0, limit - 1) + '…'
    }

    /**
     * 把当前会话容器里的时间线渲染项按「轮次」归组。
     * 每一轮 = 用户提问（data-chat-flow-kind=user）+ 助手回答（assistant / assistant-step）。
     */
    function turnsIn(scope) {
      const list = []
      const byTurn = new Map()
      for (const item of scope.querySelectorAll('[' + TURN_ATTR + ']')) {
        const turn = item.getAttribute(TURN_ATTR)
        if (turn === null || turn === '') continue
        const kind = item.getAttribute(FLOW_KIND_ATTR) || ''
        if (kind === 'turn-tail') continue
        let entry = byTurn.get(turn)
        if (entry === undefined) {
          entry = { turn, index: list.length, prompt: '', answer: null, items: [] }
          byTurn.set(turn, entry)
          list.push(entry)
        }
        if (kind.indexOf('user') === 0) {
          const text = summarise(textOf(item), 120)
          if (text !== '') entry.prompt = text
          entry.items.push({ kind: 'user', node: item })
          continue
        }
        const message = messageIn(item)
        if (message !== null && entry.answer === null) entry.answer = message
        if (message !== null || kind.indexOf('assistant') === 0 || kind === 'reasoning' || kind === 'turn-error') {
          entry.items.push({ kind: 'answer', node: item })
        }
      }
      const numeric = list.every((entry) => /^\d+$/.test(entry.turn))
      if (numeric) list.sort((left, right) => Number(left.turn) - Number(right.turn))
      list.forEach((entry, index) => {
        entry.index = index
      })
      return list
    }

    /** 一条回答属于哪一轮（拿不到时返回 null）。 */
    function turnOfMessage(message) {
      if (message === null || !message.root) return null
      const item = itemOf(message.root)
      return item === null ? null : item.getAttribute(TURN_ATTR)
    }

    /* ── DSH 输入框：把左栏写好的文字填进去（不自动发送）────────────────── */
    function findComposerEditor() {
      const scopes = [activeScope(), document]
      for (const scope of scopes) {
        const seat = scope.querySelector ? scope.querySelector('[data-composer-seat]') : null
        const host = seat === null ? scope : seat
        if (!host || !host.querySelector) continue
        const editor =
          host.querySelector('[contenteditable="true"]') ||
          host.querySelector('textarea') ||
          host.querySelector('[role="textbox"]')
        if (editor !== null) return editor
      }
      return null
    }

    function fillComposer(text) {
      const editor = findComposerEditor()
      if (editor === null) return { ok: false, reason: 'no-composer' }
      const tag = editor.tagName
      const wanted = text.replace(/\s+/g, ' ').trim()
      try {
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
          const prototype = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
          setter.call(editor, text)
          editor.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          const scrollX = window.scrollX
          const scrollY = window.scrollY
          editor.focus({ preventScroll: true })
          const selection = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(editor)
          if (selection !== null) {
            selection.removeAllRanges()
            selection.addRange(range)
          }
          let inserted = false
          try {
            inserted = document.execCommand('insertText', false, text)
          } catch (error) {
            inserted = false
          }
          if (!inserted) {
            editor.textContent = text
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
          }
          // 有些浏览器/宿主仍会把页面滚到输入框，这里还原滚动位置，避免浮层看起来「跑掉」
          if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY)
        }
      } catch (error) {
        dbg('fillComposer', 'error', String(error && error.message))
        return { ok: false, reason: 'write-failed' }
      }
      const readback = String((tag === 'TEXTAREA' || tag === 'INPUT' ? editor.value : editor.innerText) || '')
        .replace(/\s+/g, ' ')
        .trim()
      const head = wanted.slice(0, 16)
      if (head !== '' && readback.indexOf(head) !== -1) return { ok: true }
      dbg('fillComposer', 'echo-mismatch', summarise(readback, 40))
      return { ok: false, reason: 'echo-mismatch' }
    }

    /** 超宽公式等比缩小到放得下（DSH 原生 display 公式只横滚不换行）。 */
    function fitFormulas(scroller, content) {
      if (!scroller || !content) return
      const zoom = Number.parseFloat(content.style.zoom) || 1
      const available = scroller.clientWidth - 56
      if (available <= 0) return
      for (const katex of content.querySelectorAll('.katex-display > .katex')) {
        katex.style.fontSize = ''
        const natural = katex.getBoundingClientRect().width / zoom
        if (natural > available) {
          const ratio = Math.max(0.45, available / natural)
          katex.style.fontSize = ratio.toFixed(3) + 'em'
        }
      }
    }

    /* ── 全屏阅读浮层 ──────────────────────────────────────────────────── */
    function sanitizeClone(node) {
      node.querySelectorAll('script,style,link,iframe,object,embed,noscript').forEach((child) => child.remove())
      node.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'))
      node.querySelectorAll('[' + HOST_ATTR + ']').forEach((child) => child.removeAttribute(HOST_ATTR))
      node.querySelectorAll('[contenteditable]').forEach((child) => child.setAttribute('contenteditable', 'false'))
      node.querySelectorAll('[tabindex]').forEach((child) => child.setAttribute('tabindex', '-1'))
      if (node.hasAttribute('id')) node.removeAttribute('id')
      return node
    }

    function installZoomOverlay() {
      const state = {
        open: false,
        backdrop: null,
        content: null,
        scroller: null,
        zoomLabel: null,
        zoom: readZoom(),
        prevFocus: null,
        disposeKey: null,
        scope: null,
        turns: [],
        entries: new Map(),
        currentTurn: null,
        turnList: null,
        composeArea: null,
      }

      function applyZoom() {
        if (state.content) state.content.style.zoom = String(state.zoom)
        if (state.zoomLabel) state.zoomLabel.textContent = Math.round(state.zoom * 100) + '%'
        fitFormulas(state.scroller, state.content)
      }

      function setZoom(next) {
        state.zoom = clampZoom(next)
        writeZoom(state.zoom)
        applyZoom()
      }

      let toastTimer = 0
      function toast(text) {
        let node = document.querySelector('.dshzr-toast')
        if (node === null) {
          node = document.createElement('div')
          node.className = 'dshzr-toast'
          node.setAttribute('role', 'status')
          document.body.appendChild(node)
        }
        node.textContent = text
        node.setAttribute('data-on', '')
        window.clearTimeout(toastTimer)
        toastTimer = window.setTimeout(() => {
          node.removeAttribute('data-on')
        }, 1400)
      }

      function close() {
        if (!state.open) return
        state.open = false
        if (state.backdrop && state.backdrop.parentNode) state.backdrop.parentNode.removeChild(state.backdrop)
        state.backdrop = null
        state.content = null
        state.zoomLabel = null
        state.scroller = null
        state.turnList = null
        state.composeArea = null
        state.scope = null
        state.turns = []
        state.entries = new Map()
        state.currentTurn = null
        if (state.disposeKey) state.disposeKey()
        state.disposeKey = null
        document.body.classList.remove('dshzr-noscroll')
        const previous = state.prevFocus
        state.prevFocus = null
        if (previous && previous.isConnected && typeof previous.focus === 'function') {
          try {
            previous.focus({ preventScroll: true })
          } catch (error) {
            /* 焦点恢复失败不影响关闭 */
          }
        }
      }

      function copyText(text, okMessage) {
        const done = () => toast(okMessage)
        const fallback = () => {
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          let ok = false
          try {
            ok = document.execCommand('copy')
          } catch (error) {
            ok = false
          }
          area.remove()
          if (ok) done()
          else toast('复制失败：浏览器拒绝了剪贴板写入')
        }
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(done, fallback)
          return
        }
        fallback()
      }

      function highlightTurn() {
        if (state.turnList === null) return
        for (const button of state.turnList.querySelectorAll('.dshzr-turn')) {
          if (button.getAttribute('data-turn') === state.currentTurn) {
            button.setAttribute('data-active', '')
            if (typeof button.scrollIntoView === 'function') button.scrollIntoView({ block: 'nearest' })
          } else {
            button.removeAttribute('data-active')
          }
        }
      }

      /** 把某一轮的「提问 + 回答」渲染到右栏。 */
      function renderTurn(turn) {
        if (state.content === null) return
        const entry = turn === null ? undefined : state.entries.get(turn)
        state.currentTurn = entry === undefined ? null : entry.turn
        state.content.innerHTML = ''
        if (entry !== undefined) {
          for (const item of entry.items) {
            if (!item.node || !item.node.isConnected) continue
            const wrapper = document.createElement('div')
            wrapper.className = 'dshzr-item'
            wrapper.setAttribute('data-kind', item.kind)
            const tag = document.createElement('span')
            tag.className = 'dshzr-item-tag'
            tag.textContent = item.kind === 'user' ? '提问' : '回答'
            wrapper.appendChild(tag)
            const clone = item.node.cloneNode(true)
            for (const extra of clone.querySelectorAll('[data-dshzr-tail],.dshzr-tail-btn')) extra.remove()
            wrapper.appendChild(sanitizeClone(clone))
            state.content.appendChild(wrapper)
          }
        }
        highlightTurn()
        if (state.scroller !== null) state.scroller.scrollTop = 0
        applyZoom()
      }

      function renderTurnList() {
        if (state.turnList === null) return
        state.turnList.innerHTML = ''
        state.turns.forEach((entry, index) => {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'dshzr-turn'
          button.setAttribute('data-turn', entry.turn)
          const number = document.createElement('span')
          number.className = 'dshzr-turn-no'
          number.textContent = String(index + 1)
          const text = document.createElement('span')
          text.className = 'dshzr-turn-text'
          text.textContent = entry.prompt === '' ? '第 ' + (index + 1) + ' 轮' : entry.prompt
          button.title = entry.prompt === '' ? '第 ' + (index + 1) + ' 轮' : entry.prompt
          button.appendChild(number)
          button.appendChild(text)
          button.addEventListener('click', () => renderTurn(entry.turn))
          state.turnList.appendChild(button)
        })
        highlightTurn()
      }

      /** 左栏底部：先写好，再一键填入 DSH 的真实输入框（不自动发送）。 */
      function buildCompose() {
        const box = document.createElement('div')
        box.className = 'dshzr-compose'
        const area = document.createElement('textarea')
        area.rows = 3
        area.placeholder = '写下一句要问的话……（只填入 DSH 输入框，不自动发送）'
        area.setAttribute('aria-label', '输入要填入 DSH 输入框的文字')
        const row = document.createElement('div')
        row.className = 'dshzr-compose-row'
        const fill = makeButton('填入输入框', '把这里的文字写入 DSH 的输入框（不会自动发送）')
        fill.setAttribute('data-primary', '')
        const copy = makeButton('复制', '复制这里的文字')
        const note = document.createElement('span')
        note.className = 'dshzr-compose-note'
        note.textContent = 'Ctrl+Enter 填入'

        const submit = () => {
          const text = area.value
          if (text.trim() === '') {
            toast('先写点内容再填入')
            area.focus()
            return
          }
          const result = fillComposer(text)
          if (result.ok) {
            toast('已填入 DSH 输入框（不会自动发送）')
            area.value = ''
            return
          }
          if (result.reason === 'no-composer') toast('没找到 DSH 输入框：内容留在左栏，可点「复制」手动粘贴')
          else if (result.reason === 'write-failed') toast('写入失败：请点「复制」再粘进 DSH 输入框')
          else toast('填入后没读到回显：请检查 DSH 输入框，或点「复制」手动粘贴')
          area.focus()
        }
        fill.addEventListener('click', submit)
        copy.addEventListener('click', () => {
          if (area.value.trim() === '') {
            toast('输入框是空的')
            return
          }
          copyText(area.value, '已复制输入框内容')
        })
        area.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            submit()
          }
        })
        row.appendChild(fill)
        row.appendChild(copy)
        row.appendChild(note)
        box.appendChild(area)
        box.appendChild(row)
        state.composeArea = area
        return box
      }

      function open(message) {
        if (!message || !message.body || !message.body.isConnected) return false
        if (state.open) close()
        state.prevFocus = document.activeElement
        state.zoom = readZoom()
        const scope = scopeOf(message.body)
        const turns = turnsIn(scope)
        state.scope = scope
        state.turns = turns
        state.entries = new Map(turns.map((entry) => [entry.turn, entry]))

        const backdrop = document.createElement('div')
        backdrop.className = 'dshzr-backdrop'

        const panel = document.createElement('div')
        panel.className = 'dshzr-panel'
        panel.setAttribute('role', 'dialog')
        panel.setAttribute('aria-modal', 'true')
        panel.setAttribute('aria-label', '放大阅读')

        const head = document.createElement('div')
        head.className = 'dshzr-head'

        const title = document.createElement('div')
        title.className = 'dshzr-title'
        title.textContent = '放大阅读'

        const hint = document.createElement('div')
        hint.className = 'dshzr-hint'
        hint.textContent = '↑↓ 换轮 · Ctrl+滚轮缩放 · Esc 关闭'

        const spacer = document.createElement('div')
        spacer.className = 'dshzr-spacer'

        const minus = makeButton('A−', '减小字号')
        const zoomLabel = makeButton('', '恢复到 140%')
        zoomLabel.className = 'dshzr-btn dshzr-zoom'
        const plus = makeButton('A+', '增大字号')
        const copy = makeButton('复制文字', '复制这一轮的纯文本')
        const rules = makeButton('公式规约', '复制数学/化学输出规约（可粘进 AGENTS.md）')
        const closeButton = makeButton('关闭', '关闭放大阅读（Esc）')
        closeButton.className = 'dshzr-btn dshzr-close'

        minus.addEventListener('click', () => setZoom(state.zoom - STEP))
        plus.addEventListener('click', () => setZoom(state.zoom + STEP))
        zoomLabel.addEventListener('click', () => setZoom(DEFAULT_ZOOM))
        closeButton.addEventListener('click', () => close())
        copy.addEventListener('click', () => {
          const source = state.content === null ? message.body : state.content
          const text = textOf(source)
          if (text === '') {
            toast('这一轮没有可复制的文字')
            return
          }
          copyText(text, '已复制这一轮的纯文本')
        })
        rules.addEventListener('click', () => copyText(MATH_RULES, '已复制数学/化学输出规约（可粘进 AGENTS.md）'))

        const main = document.createElement('div')
        main.className = 'dshzr-main'

        const aside = document.createElement('div')
        aside.className = 'dshzr-turns'
        const asideHead = document.createElement('div')
        asideHead.className = 'dshzr-turns-head'
        asideHead.textContent = '本会话 · ' + turns.length + ' 轮'
        const turnList = document.createElement('div')
        turnList.className = 'dshzr-turns-list'
        state.turnList = turnList
        aside.appendChild(asideHead)
        aside.appendChild(turnList)
        aside.appendChild(buildCompose())

        const scroller = document.createElement('div')
        scroller.className = 'dshzr-scroller'
        const content = document.createElement('div')
        content.className = 'dshzr-content'
        scroller.appendChild(content)

        main.appendChild(aside)
        main.appendChild(scroller)

        head.appendChild(title)
        head.appendChild(hint)
        head.appendChild(spacer)
        head.appendChild(minus)
        head.appendChild(zoomLabel)
        head.appendChild(plus)
        head.appendChild(copy)
        head.appendChild(rules)
        head.appendChild(closeButton)
        panel.appendChild(head)
        panel.appendChild(main)
        backdrop.appendChild(panel)
        document.body.appendChild(backdrop)

        state.open = true
        state.backdrop = backdrop
        state.content = content
        state.scroller = scroller
        state.zoomLabel = zoomLabel
        document.body.classList.add('dshzr-noscroll')

        renderTurnList()
        const initial = turnOfMessage(message)
        if (initial !== null && state.entries.has(initial)) renderTurn(initial)
        else if (turns.length > 0) renderTurn(turns[turns.length - 1].turn)
        else {
          // 拿不到轮次信息（DOM 变体）时退化成只渲染这一条回答
          content.appendChild(sanitizeClone(message.body.cloneNode(true)))
          applyZoom()
        }

        backdrop.addEventListener('mousedown', (event) => {
          if (event.target === backdrop) close()
        })
        scroller.addEventListener(
          'wheel',
          (event) => {
            if (!event.ctrlKey && !event.metaKey) return
            event.preventDefault()
            setZoom(state.zoom + (event.deltaY < 0 ? STEP : -STEP))
          },
          { passive: false },
        )

        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
            return
          }
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          const target = event.target
          if (target instanceof Element && target.closest('textarea,input,[contenteditable="true"]')) return
          if (state.turns.length === 0) return
          const index = state.turns.findIndex((entry) => entry.turn === state.currentTurn)
          const nextIndex = event.key === 'ArrowDown' ? index + 1 : index - 1
          if (nextIndex < 0 || nextIndex >= state.turns.length) return
          event.preventDefault()
          renderTurn(state.turns[nextIndex].turn)
        }
        document.addEventListener('keydown', onKeyDown, true)
        state.disposeKey = () => document.removeEventListener('keydown', onKeyDown, true)

        window.setTimeout(() => {
          try {
            closeButton.focus({ preventScroll: true })
          } catch (error) {
            /* 聚焦失败不影响使用 */
          }
        }, 0)
        return true
      }

      return { open, close, isOpen: () => state.open }
    }

    /* ── 安装 ──────────────────────────────────────────────────────────── */
    function start() {
      dbg('start', document.body ? 'body-ok' : 'no-body', 'v' + VERSION)
      const disposers = []

      const overlay = installZoomOverlay()

      function openFor(message) {
        if (!message) return
        overlay.open(message)
      }

      // 主入口：回答底部操作行里、紧挨「用量」左边的放大按钮（位置固定）
      disposers.push(installActionButtons(openFor))

      // 右下角常驻按钮（固定位置，不随鼠标漂移）+ Alt+Z
      const fab = document.createElement('button')
      fab.type = 'button'
      fab.className = 'dshzr-fab'
      fab.textContent = 'Aa'
      fab.dataset.dshzrVersion = VERSION
      fab.title = '放大阅读最近一条回答（v' + VERSION + '，Alt+Z）'
      fab.setAttribute('aria-label', '放大阅读最近一条回答（Alt+Z）')
      fab.addEventListener('click', () => openFor(nearestMessage()))
      document.body.appendChild(fab)
      disposers.push(() => fab.remove())

      function onKeyDown(event) {
        if (event.defaultPrevented) return
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (event.key !== 'z' && event.key !== 'Z') return
        const target = event.target
        if (target instanceof Element && target.closest('input,textarea,[contenteditable="true"]')) return
        event.preventDefault()
        if (overlay.isOpen()) {
          overlay.close()
          return
        }
        openFor(nearestMessage())
      }
      document.addEventListener('keydown', onKeyDown)
      disposers.push(() => document.removeEventListener('keydown', onKeyDown))

      // 调试 / 自检入口
      window.__DSH_READ_ZOOM__ = {
        version: VERSION,
        openLast: () => openFor(nearestMessage()),
        close: () => overlay.close(),
        messages: settledMessages,
        peek: () => ({
          version: VERSION,
          overlayOpen: overlay.isOpen(),
          tailButtons: document.querySelectorAll('[data-dshzr-tail]').length,
          fab: document.querySelector('.dshzr-fab') !== null,
          panelTurns: document.querySelectorAll('.dshzr-turn').length,
          activeTurn: (() => {
            const active = document.querySelector('.dshzr-turn[data-active]')
            return active === null ? null : active.getAttribute('data-turn')
          })(),
          compose: document.querySelector('.dshzr-compose textarea') !== null,
        }),
      }

      return () => {
        overlay.close()
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (error) {
            /* 清理时忽略单个失败 */
          }
        }
        delete window.__DSH_READ_ZOOM__
      }
    }

    let installed = false

    function apply(ctx) {
      if (installed) return
      installed = true
      const cleanup = () => {
        installed = false
      }
      const run = () => {
        const disposeStyle = installStyle()
        const disposeDom = start()
        return () => {
          disposeDom()
          disposeStyle()
          cleanup()
        }
      }
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => (document.body ? run() : waitForBody(run)), 'read-zoom: 悬停放大按钮与阅读浮层')
      } else {
        const dispose = document.body ? run() : waitForBody(run)
        void dispose
      }
    }

    function waitForBody(run) {
      const onReady = () => {
        document.removeEventListener('DOMContentLoaded', onReady)
        run()
      }
      document.addEventListener('DOMContentLoaded', onReady)
      return () => document.removeEventListener('DOMContentLoaded', onReady)
    }

    return { inject: [], apply }
  },
})
