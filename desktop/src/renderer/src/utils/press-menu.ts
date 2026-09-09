import type { MouseEvent, PointerEvent } from 'react'

export interface PressHandlers {
  onClick?: (e: MouseEvent) => void
  onContextMenu?: (e: MouseEvent) => void
  onPointerDown?: (e: PointerEvent) => void
  onPointerMove?: (e: PointerEvent) => void
  onPointerUp?: (e: PointerEvent) => void
  onPointerLeave?: (e: PointerEvent) => void
  onPointerCancel?: (e: PointerEvent) => void
}

const LONG_PRESS_DELAY = 550
const LONG_PRESS_MOVE_TOLERANCE = 12

/**
 * Gap #14 檔案列互動 helper — one prop bag for both interaction models:
 *
 *   - Desktop: right-click (contextmenu) opens the action menu; left-click
 *     activates the row (file preview).
 *   - Android WebView / coarse pointers: a ~550ms press without significant
 *     movement opens the action menu. The finger-lift click that immediately
 *     follows is suppressed on the ROW itself (the caller additionally guards
 *     the menu with its own long-press swallow — see App's menu item action).
 *
 * Deliberately a factory (not a hook): rows are rendered in recursive maps
 * where hooks are awkward, and a press sequence never survives a re-render
 * anyway. Never preventDefault() on pointerdown — that would kill scrolling.
 */
export function createPressHandlers(opts: {
  onActivate: () => void
  onMenu: (x: number, y: number, longPress: boolean) => void
  longPressEnabled: boolean
}): PressHandlers {
  const { onActivate, onMenu, longPressEnabled } = opts
  let timer: ReturnType<typeof setTimeout> | null = null
  let startX = 0
  let startY = 0
  let suppressClickUntil = 0

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    onClick(e) {
      if (e.button !== 0) return
      if (Date.now() < suppressClickUntil) return
      onActivate()
    },
    onContextMenu(e) {
      // Desktop right-click; also blocks the WebView's native menu when a
      // contextmenu event ever fires on touch.
      e.preventDefault()
      if (e.button === 2) onMenu(e.clientX, e.clientY, false)
    },
    onPointerDown(e) {
      if (!longPressEnabled || e.pointerType === 'mouse') return
      clearTimer()
      startX = e.clientX
      startY = e.clientY
      timer = setTimeout(() => {
        timer = null
        suppressClickUntil = Date.now() + 700
        onMenu(e.clientX, e.clientY, true)
      }, LONG_PRESS_DELAY)
    },
    onPointerMove(e) {
      if (timer === null) return
      if (
        Math.abs(e.clientX - startX) > LONG_PRESS_MOVE_TOLERANCE ||
        Math.abs(e.clientY - startY) > LONG_PRESS_MOVE_TOLERANCE
      ) {
        clearTimer()
      }
    },
    onPointerUp() {
      clearTimer()
    },
    onPointerLeave() {
      clearTimer()
    },
    onPointerCancel() {
      clearTimer()
    }
  }
}
