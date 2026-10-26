/**
 * Client half of the Session Remover bundle: one row in a session's "..." menu
 * and one confirmation dialog. Every user-visible string is English.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-remover',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/plugins/session-remover/delete'
    const CONFIRMATION_HEADER = 'x-session-remover-confirmation'
    const CONFIRMATION = 'delete-session'
    const DIALOG_TITLE_ID = 'session-remover-dialog-title'
    const DIALOG_DESCRIPTION_ID = 'session-remover-dialog-description'

    const CSS = `
.sr-item-wrap{position:relative}
.sr-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);text-align:left}
.sr-item-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:14px;height:14px;color:var(--dsw-alias-state-error-primary)}
.sr-item-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sr-item:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.12))}
.sr-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.12));outline:none}
.sr-root{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}
.sr-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32))}
.sr-dialog{position:relative;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:min(380px,100%);padding:0 24px 24px;border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.28));outline:none}
.sr-header{padding-top:22px}
.sr-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.sr-description{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.sr-target{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;overflow-wrap:anywhere}
.sr-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.sr-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
.sr-button{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:transparent;cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.sr-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.sr-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sr-button:disabled{opacity:.5;cursor:not-allowed}
.sr-button-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.sr-button-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.12))}
`

    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M4 7h16' }),
      h('path', { d: 'M9.5 7V5.6A1.6 1.6 0 0 1 11.1 4h1.8a1.6 1.6 0 0 1 1.6 1.6V7' }),
      h('path', { d: 'M6.4 7l.9 11a2.4 2.4 0 0 0 2.4 2.2h4.6a2.4 2.4 0 0 0 2.4-2.2l.9-11' }),
      h('path', { d: 'M10.6 11v5.4' }),
      h('path', { d: 'M13.4 11v5.4' }))
    }

    const messageOf = (error) => (error instanceof Error && error.message.length > 0 ? error.message : String(error))

    return {
      inject: ['slots'],
      apply(ctx) {
        const listeners = new Set()
        let state = { target: null, busy: false, error: '' }
        let disposed = false
        const controller = new AbortController()

        const subscribe = (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        }
        const snapshot = () => state
        const publish = (patch) => {
          if (disposed) return
          state = { ...state, ...patch }
          for (const listener of [...listeners]) listener()
        }
        const close = () => {
          if (state.busy) return
          publish({ target: null, error: '' })
        }

        const service = (key) => (typeof ctx.get === 'function' ? ctx.get(key) : undefined)

        async function confirmDeletion() {
          const target = state.target
          if (disposed || state.busy || target === null) return
          publish({ busy: true, error: '' })
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              signal: controller.signal,
              headers: { 'content-type': 'application/json', [CONFIRMATION_HEADER]: CONFIRMATION },
              body: JSON.stringify({ sessionId: target.id }),
            })
            const body = await response.json().catch(() => undefined)
            if (!response.ok || body?.ok !== true) {
              throw new Error(body?.error?.message || `Deletion failed (HTTP ${response.status}).`)
            }
            const uiWorkspace = service('uiWorkspace')
            if (uiWorkspace?.selection?.getSnapshot?.()?.sessionId === target.id) {
              if (typeof uiWorkspace.clearMain === 'function') uiWorkspace.clearMain()
              else service('layout')?.selectPanel?.(null)
            }
            service('sessions')?.refresh?.()
            publish({ target: null, error: '' })
          } catch (error) {
            if (!controller.signal.aborted) publish({ error: messageOf(error) })
          } finally {
            if (!disposed) publish({ busy: false })
          }
        }

        function DeleteRow(props) {
          const sessionId = props.sessionId
          const displayTitle = props.displayTitle
          const [, setMenuOpen] = props.useMenuOpenState()
          return h('div', { className: 'sr-item-wrap' },
            h('button', {
              type: 'button',
              role: 'menuitem',
              className: 'sr-item',
              onClick: () => {
                setMenuOpen(false)
                publish({ target: { id: sessionId, title: displayTitle || sessionId }, error: '' })
              },
            },
            h('span', { className: 'sr-item-icon' }, TrashIcon()),
            h('span', { className: 'sr-item-label' }, 'Delete session')))
        }

        function DeleteDialog() {
          const current = React.useSyncExternalStore(subscribe, snapshot, snapshot)
          const dialogRef = React.useRef(null)
          const cancelRef = React.useRef(null)
          const targetId = current.target?.id

          React.useEffect(() => {
            if (targetId === undefined) return undefined
            const previous = document.activeElement
            cancelRef.current?.focus()
            // The menu owner restores focus to its trigger while closing; take it back.
            const focusTimer = setTimeout(() => { cancelRef.current?.focus() }, 0)
            const onKeyDown = (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
                return
              }
              if (event.key !== 'Tab') return
              const dialog = dialogRef.current
              if (dialog === null) return
              const focusable = dialog.querySelectorAll('button:not([disabled])')
              if (focusable.length === 0) return
              const first = focusable[0]
              const last = focusable[focusable.length - 1]
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last.focus()
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
              }
            }
            document.addEventListener('keydown', onKeyDown, true)
            return () => {
              clearTimeout(focusTimer)
              document.removeEventListener('keydown', onKeyDown, true)
              if (previous !== null && typeof previous.focus === 'function') previous.focus()
            }
          }, [targetId])

          if (current.target === null) return null

          return h('div', { className: 'sr-root' },
            h('div', { className: 'sr-mask', 'aria-hidden': true, onClick: close }),
            h('div', {
              ref: dialogRef,
              className: 'sr-dialog',
              role: 'alertdialog',
              'aria-modal': 'true',
              'aria-labelledby': DIALOG_TITLE_ID,
              'aria-describedby': DIALOG_DESCRIPTION_ID,
              tabIndex: -1,
            },
            h('div', { className: 'sr-header' },
              h('h2', { id: DIALOG_TITLE_ID, className: 'sr-title' }, 'Delete this session permanently?')),
            h('p', { id: DIALOG_DESCRIPTION_ID, className: 'sr-description' },
              'The conversation and its local files on this PC will be removed. This cannot be undone.'),
            h('p', { className: 'sr-target' }, current.target.title),
            current.error !== '' && h('p', { className: 'sr-error', role: 'alert' }, current.error),
            h('div', { className: 'sr-footer' },
              h('button', {
                type: 'button',
                className: 'sr-button',
                ref: cancelRef,
                disabled: current.busy,
                onClick: close,
              }, 'Cancel'),
              h('button', {
                type: 'button',
                className: 'sr-button sr-button-danger',
                disabled: current.busy,
                onClick: confirmDeletion,
              }, current.busy ? 'Deleting…' : 'Delete permanently'))))
        }

        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'session-remover: dialog and menu styles')

        ctx.effect(() => () => {
          disposed = true
          controller.abort()
          listeners.clear()
        }, 'session-remover: dialog lifecycle')

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-remover.remove',
          order: 500,
        }, DeleteRow))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-remover.dialog',
        }, DeleteDialog))
      },
    }
  },
})
