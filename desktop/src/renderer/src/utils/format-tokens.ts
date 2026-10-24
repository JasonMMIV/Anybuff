/** Compact token counts for dense rows: 128000 → 128K, 1048576 → 1.0M. */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000
    const rounded = Number(value.toFixed(value >= 10 ? 0 : 1))
    // 999_999 must promote to "1.0M", not "1000K".
    if (rounded >= 1_000) return `${(rounded / 1_000).toFixed(1)}M`
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}K`
  }
  return String(Math.floor(tokens))
}
