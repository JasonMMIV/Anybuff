/**
 * Pure comparison for the Capabilities editor.
 *
 * The editor pre-fills the EFFECTIVE values (settings → models.dev). Only
 * fields the user actually changed may be persisted — otherwise opening a row
 * and pressing Apply would turn inherited catalog values into declarations.
 */

export interface CapabilityEditValues {
  efforts: string
  defaultEffort: string
  wire: string
  budgetTokens: string
  windowTokens: string
  outputTokens: string
  paramsText: string
}

export interface CapabilityEditDiff {
  changed: boolean
  efforts: string[]
  effortsChanged: boolean
  defaultEffortChanged: boolean
  wireChanged: boolean
  budgetChanged: boolean
  windowChanged: boolean
  outputChanged: boolean
  paramsChanged: boolean
}

function parseRungs(text: string): string[] {
  return text
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export function diffCapabilityEdits(
  baseline: CapabilityEditValues,
  current: CapabilityEditValues
): CapabilityEditDiff {
  const efforts = parseRungs(current.efforts)
  const effortsChanged = efforts.join('\n') !== parseRungs(baseline.efforts).join('\n')
  const defaultEffortChanged = current.defaultEffort !== baseline.defaultEffort
  const wireChanged = current.wire !== baseline.wire
  const budgetChanged = current.budgetTokens.trim() !== baseline.budgetTokens.trim()
  const windowChanged = current.windowTokens.trim() !== baseline.windowTokens.trim()
  const outputChanged = current.outputTokens.trim() !== baseline.outputTokens.trim()
  const paramsChanged = current.paramsText.trim() !== baseline.paramsText.trim()
  return {
    changed:
      effortsChanged ||
      defaultEffortChanged ||
      wireChanged ||
      budgetChanged ||
      windowChanged ||
      outputChanged ||
      paramsChanged,
    efforts,
    effortsChanged,
    defaultEffortChanged,
    wireChanged,
    budgetChanged,
    windowChanged,
    outputChanged,
    paramsChanged,
  }
}
