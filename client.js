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
    const VERSION = '0.2.1'
    // 每轮回答底部的操作行所在容器（DSH chat 的 TurnTailNodeView 带这个属性）。
    const TAIL_ATTR = 'data-turn-tail'
    // 16px 对角双箭头（放大/展开），药丸与操作行按钮共用；stroke 用 currentColor 跟随主题。
    const EXPAND_ICON =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M9.9 2.4h3.7v3.7M13.3 2.7 9.2 6.8M6.1 13.6H2.4V9.9M2.7 13.3l4.1-4.1"/></svg>'

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
      /* 悬停时浮出的「放大」药丸 */
      '.dshzr-pill{position:fixed;z-index:2147482000;display:inline-flex;align-items:center;gap:4px;',
      'box-sizing:border-box;height:24px;padding:0 8px;border-radius:999px;cursor:pointer;',
      'font:500 12px/1 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-secondary,#6b6b71);',
      'background:var(--dsw-alias-bg-layer-3,#ffffff);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'box-shadow:0 2px 10px rgba(0,0,0,.10);',
      'opacity:0;transform:translateY(2px);pointer-events:none;',
      'transition:opacity .12s ease,transform .12s ease,background-color .12s ease,color .12s ease;',
      'user-select:none;-webkit-user-select:none}',
      '.dshzr-pill[data-on]{opacity:1;transform:none;pointer-events:auto}',
      '.dshzr-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));',
      'color:var(--dsw-alias-label-primary,#191919)}',
      '.dshzr-pill svg{width:12px;height:12px;display:block;flex:none}',

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
      '.dshzr-panel{display:flex;flex-direction:column;width:min(1040px,94vw);max-height:94vh;',
      'box-sizing:border-box;overflow:hidden;',
      'border-radius:var(--dsw-radius-panel,16px);',
      'background:var(--dsw-alias-bg-layer-2,#ffffff);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));',
      'box-shadow:var(--dsw-shadow-lv3,0 24px 64px rgba(0,0,0,.28))}',
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
      '.dshzr-scroller{flex:1 1 auto;overflow:auto;overscroll-behavior:contain;',
      'padding:24px 32px 48px;box-sizing:border-box}',
      '.dshzr-content{zoom:1.4;transform-origin:top left}',
      '.dshzr-content .katex-display{overflow-x:auto;overflow-y:hidden;max-width:100%;padding:2px 0}',
      '.dshzr-content table{max-width:100%}',
      '.dshzr-content button,.dshzr-content [role="button"]{display:none!important}',
      '.dshzr-content *{max-width:100%;box-sizing:border-box}',
      '.dshzr-content [class*="actions"]{display:none!important}',
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

    function settledMessages() {
      const blocks = document.querySelectorAll('[' + HOST_ATTR + '][class*="markdown"]')
      const result = []
      for (const block of blocks) {
        const message = messageFor(block)
        if (message === null) continue
        if (result.indexOf(message) === -1) result.push(message)
      }
      return result
    }

    function isVisible(rect) {
      return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
    }

    /** 视口里最靠下的一条已完成回答；都不在视口里就取 DOM 里最后一条。 */
    function nearestMessage() {
      const all = settledMessages()
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

    /** 操作行属于哪一轮回答：取 DOM 中位于该行之前、且离它最近的那条回答。 */
    function messageBefore(tail) {
      const all = settledMessages()
      let found = null
      for (const message of all) {
        if (isBefore(message.root, tail)) found = message
        else break
      }
      return found
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
              const message = messageBefore(tail)
              if (message === null) {
                dbg('tailClick', 'no-message')
                return
              }
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

    function installZoomOverlay(options) {
      const state = { open: false, backdrop: null, content: null, zoomLabel: null, zoom: readZoom(), prevFocus: null, disposeKey: null }

      function applyZoom() {
        if (state.content) state.content.style.zoom = String(state.zoom)
        if (state.zoomLabel) state.zoomLabel.textContent = Math.round(state.zoom * 100) + '%'
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

      function open(message) {
        if (!message || !message.body || !message.body.isConnected) return false
        if (state.open) close()
        state.prevFocus = document.activeElement
        const zoom = readZoom()
        state.zoom = zoom

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
        hint.textContent = 'Esc 或点空白关闭 · Ctrl+滚轮缩放'

        const spacer = document.createElement('div')
        spacer.className = 'dshzr-spacer'

        const minus = makeButton('A−', '减小字号')
        const zoomLabel = makeButton('', '恢复到 140%')
        zoomLabel.className = 'dshzr-btn dshzr-zoom'
        const plus = makeButton('A+', '增大字号')
        const copy = makeButton('复制文字', '复制这条回答的纯文本')
        const closeButton = makeButton('关闭', '关闭放大阅读（Esc）')
        closeButton.className = 'dshzr-btn dshzr-close'

        minus.addEventListener('click', () => setZoom(state.zoom - STEP))
        plus.addEventListener('click', () => setZoom(state.zoom + STEP))
        zoomLabel.addEventListener('click', () => setZoom(DEFAULT_ZOOM))
        closeButton.addEventListener('click', () => close())

        copy.addEventListener('click', () => {
          const text = textOf(message.body)
          const done = () => toast('已复制这条回答的纯文本')
          if (text === '') {
            toast('这条回答没有可复制的文字')
            return
          }
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(done, () => toast('复制失败：浏览器拒绝了剪贴板写入'))
            return
          }
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          try {
            document.execCommand('copy')
            done()
          } catch (error) {
            toast('复制失败：浏览器拒绝了剪贴板写入')
          }
          area.remove()
        })

        const scroller = document.createElement('div')
        scroller.className = 'dshzr-scroller'

        const content = document.createElement('div')
        content.className = 'dshzr-content'
        content.appendChild(sanitizeClone(message.body.cloneNode(true)))
        scroller.appendChild(content)

        head.appendChild(title)
        head.appendChild(hint)
        head.appendChild(spacer)
        head.appendChild(minus)
        head.appendChild(zoomLabel)
        head.appendChild(plus)
        head.appendChild(copy)
        head.appendChild(closeButton)
        panel.appendChild(head)
        panel.appendChild(scroller)
        backdrop.appendChild(panel)
        document.body.appendChild(backdrop)

        state.open = true
        state.backdrop = backdrop
        state.content = content
        state.zoomLabel = zoomLabel
        applyZoom()
        document.body.classList.add('dshzr-noscroll')

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
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          close()
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
