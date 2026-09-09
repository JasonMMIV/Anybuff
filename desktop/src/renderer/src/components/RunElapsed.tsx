import { useEffect, useState } from 'react'

/** m:ss（超過 1 小時改為 h:mm:ss）。 */
function formatRunElapsed(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const ss = String(s).padStart(2, '0')
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * #22 耗時計時：執行中 run 的即時耗時讀數（⏱ m:ss）。
 *
 * 自己維護 1 秒時脈並只 re-render 自己——不像把時脈放在 App state 那樣
 * 每 1 秒重繪整棵 UI 樹（長對話的 memo 化只擋得住 children，擋不住 parent
 * 每輪的 reconcile）。由父層決定掛載時機（run 進行中才掛載）。
 */
export default function RunElapsed({
  startedAt,
  className = 'run-elapsed'
}: {
  startedAt: number
  className?: string
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // 起點改變（新 run / resume）時立即校正一次，不用等第一個 interval。
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  return (
    <span className={className} title="Elapsed time">
      {formatRunElapsed(startedAt, now)}
    </span>
  )
}
