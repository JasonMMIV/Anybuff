#!/usr/bin/env bun
/**
 * M-C1 static touch-target scan (Android plan §4.2 — "最小觸控目標 44px 全面檢查").
 *
 * What it audits
 *   The SHARED renderer stylesheet (desktop/src/renderer/src/styles.css — the
 *   exact file the Android WebView renders; no renderer fork, plan §4.2 M-C1)
 *   against a 44px floor on both axes (WCAG 2.5.8 AAA / between Apple's 44pt
 *   and Android's 48dp minimum view guidance).
 *
 * How targets are identified
 *   A lightweight JSX tag scanner walks every renderer .ts/.tsx file and
 *   builds one audit TARGET per interactive element instance: <button>, <a>,
 *   <input>, <textarea>, <select>, role="button", or any element with an
 *   onClick handler — together with the class set that element carries.
 *   Auditing class SETS (not single classes) keeps modifier classes
 *   (.primary/.ghost/…) from reporting as phantom targets, and subject
 *   matching requires a rule's classes to be a subset of the element's —
 *   mirroring how the cascade actually applies.
 *
 * How the Android-effective floor is computed (cascade-aware, per axis)
 *   pin(axis) per rule = max(explicit width/height/min-* resolved through the
 *   stylesheet's custom properties, border-box content estimate for height:
 *   padding(axis) + 2×border + lines×font×line-height; the global
 *   `* { box-sizing: border-box }` makes explicit sizes border-box values).
 *   Full-stretch overlays (position:fixed/absolute with top+bottom or inset
 *   covering both axes) and width are NOT padding-derived: width pins come
 *   only from explicit width/min-width (padding-driven width is text-dependent).
 *   Mobile-scoped rules (`.is-webview` selector or `@media (max-width: 640px)`
 *   block) are the deciding pins for Android; base pins carry through as
 *   lower bounds. A target is a finding when its effective floor < 44px.
 *
 * Finding semantics (fix discipline, guide §6 note 8 — Windows zero-regression)
 *   - decidingScope "mobile": an Android-scoped rule already pins it too
 *     small → adjust the SCOPED value.
 *   - decidingScope "base": no mobile rule pins it → add a NEW `.is-webview`
 *     (or 640px media) scoped bump — NEVER edit the shared base value.
 *
 * Known blind spots (deterministic tool, not a browser)
 *   - flex/grid stretch, transform:scale hit areas, JS-toggled classes,
 *     calc()/clamp()/min()/max() chains, em/rem ≈ 16px, TSX inline styles,
 *     markdown-generated HTML beyond the hint list
 *   - the 640px media covers portrait only; landscape (>640px) falls back to
 *     base + `.is-webview` rules
 *   - min-width/min-height pins are floors; the real size can be larger —
 *     min-* ≤ 8px ("allow shrink" idiom) is treated as unpinned
 *
 * Output is REPORT-ONLY (never auto-fixes); exit code is always 0 — wire it
 * into CI as a gate only after the finding set has been drained.
 *
 * Usage:
 *   bun scripts/scan-touch-targets.ts             # human-readable report
 *   bun scripts/scan-touch-targets.ts --json      # machine-readable
 *   bun scripts/scan-touch-targets.ts --markdown  # md table for docs
 */

import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(import.meta.dir, '..')
const RENDERER_SRC = path.join(ROOT, 'desktop', 'src', 'renderer', 'src')
const TARGET_PX = 44
const SHRINK_IDIOM_PX = 8 // min-width:0/4/8px = "allow flex shrink", not a size pin

// ── Interactive element harvesting (JSX tag scanner) ────────────────────────

type InteractiveElement = { tag: string; classes: string[]; ref: string }

/** Interactive-element instances (tag + class set) across the renderer TSX. */
function harvestInteractiveElements(): InteractiveElement[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(tsx|ts)$/.test(entry.name)) files.push(p)
    }
  }
  walk(RENDERER_SRC)

  const elements: InteractiveElement[] = []
  const tmplHoleRe = /\$\{[^{}]*\}/g

  for (const file of files) {
    const rel = path.relative(ROOT, file).replaceAll('\\', '/')
    const text = fs.readFileSync(file, 'utf8')
    const lineStarts: number[] = [0]
    for (let c = 0; c < text.length; c++)
      if (text[c] === '\n') lineStarts.push(c + 1)
    const lineOf = (offset: number) => {
      let lo = 0
      let hi = lineStarts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (lineStarts[mid] <= offset) lo = mid
        else hi = mid - 1
      }
      return lo + 1
    }

    // Walk opening tags: <Name attrs…> — quoted strings and brace expressions
    // (nested braces included) are skipped so a `>` inside an expression
    // never terminates the tag early.
    const tagRe = /<([A-Za-z][\w.]*)/g
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(text))) {
      const tag = m[1]
      let i = m.index + m[0].length
      const n = text.length
      let classNameValue: string | null = null
      let interactive = /^(button|a|input|textarea|select)$/i.test(tag)
      let closed = false

      while (i < n) {
        const ch = text[i]
        if (ch === '"' || ch === "'" || ch === '`') {
          const quote = ch
          i++
          while (i < n && text[i] !== quote) {
            if (text[i] === '\\') i++
            i++
          }
          i++
          continue
        }
        if (ch === '{') {
          let depth = 1
          i++
          while (i < n && depth > 0) {
            const c2 = text[i]
            if (c2 === '"' || c2 === "'" || c2 === '`') {
              const quote = c2
              i++
              while (i < n && text[i] !== quote) {
                if (text[i] === '\\') i++
                i++
              }
              i++
              continue
            }
            if (c2 === '{') depth++
            else if (c2 === '}') depth--
            i++
          }
          continue
        }
        if (ch === '>') {
          closed = true
          i++
          break
        }
        if (ch === '/' && text[i + 1] === '>') {
          closed = true
          i += 2
          break
        }
        if (/[A-Za-z_]/.test(ch)) {
          const attrStart = i
          while (i < n && /[\w-]/.test(text[i])) i++
          const attr = text.slice(attrStart, i)
          let j = i
          while (j < n && /\s/.test(text[j])) j++
          if (text[j] !== '=') continue // boolean attribute
          j++
          while (j < n && /\s/.test(text[j])) j++
          let value: string
          if (text[j] === '"' || text[j] === "'" || text[j] === '{') {
            const open = text[j]
            const close = open === '{' ? '}' : open
            const valueStart = j + 1
            let depth = open === '{' ? 1 : 0
            j++
            while (j < n) {
              const c2 = text[j]
              if (open === '{') {
                if (c2 === '"' || c2 === "'" || c2 === '`') {
                  const quote = c2
                  j++
                  while (j < n && text[j] !== quote) {
                    if (text[j] === '\\') j++
                    j++
                  }
                  j++
                  continue
                }
                if (c2 === '{') depth++
                else if (c2 === '}') {
                  depth--
                  if (depth === 0) break
                }
              } else if (c2 === close) {
                break
              }
              j++
            }
            value = text.slice(valueStart, j)
            j++
          } else {
            const valueStart = j
            while (j < n && /[^\s>/]/.test(text[j])) j++
            value = text.slice(valueStart, j)
          }
          i = j
          if (attr === 'className' || attr === 'class') classNameValue = value
          // onClick that only stops propagation is a container guard, not an
          // interactive affordance (the real targets are its children).
          if (
            attr === 'onClick' &&
            value.trim() &&
            !/stopPropagation/.test(value)
          )
            interactive = true
          if (attr === 'role')
            interactive = interactive || /['"]button['"]/.test(value)
          continue
        }
        i++
      }
      if (!closed || !interactive || classNameValue == null) continue

      const line = lineOf(m.index)
      // Static fragments + all quoted strings inside the expression.
      const pieces: string[] =
        classNameValue.includes('{') || classNameValue.includes('?')
          ? [
              ...(classNameValue.match(/'([^']*)'|"([^"]*)"|`([^`]*)`/g) ?? []),
              classNameValue
                .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ')
                .replace(tmplHoleRe, ' '),
            ]
          : [classNameValue]
      const classes = [
        ...new Set(
          pieces
            .join(' ')
            .replace(/['"`,?:]/g, ' ')
            .split(/\s+/)
            .filter((c) => /^[A-Za-z][\w-]*$/.test(c)),
        ),
      ]
      elements.push({ tag, classes, ref: `${rel}:${line}` })
    }
  }
  return elements
}

/**
 * Targets that never appear as a className literal on an interactive TSX
 * element: markdown-generated delegated-click controls (renderMarkdown bakes
 * them into sanitized HTML) and the programmatic text link.
 */
const HINT_TARGET_ELEMENTS: InteractiveElement[] = [
  { tag: 'button', classes: ['link-btn'], ref: '(markdown/delegated)' },
  {
    tag: 'button',
    classes: ['code-block-action'],
    ref: '(markdown/delegated)',
  },
  { tag: 'button', classes: ['code-copy-btn'], ref: '(markdown/delegated)' },
]

/** Desktop-only window chrome; `.is-webview .titlebar { display: none }` removes it all on Android. */
const DESKTOP_CHROME_CLASSES = new Set([
  'titlebar',
  'titlebar-menu-btn',
  'window-control-btn',
  'window-close-btn',
  'menu-item',
])

/**
 * Delegated/dismiss-guard containers: clicks on the element itself are not
 * an affordance — `.markdown` delegates to generated children (its content
 * height is text flow, not a control); `.task-context-menu` only stops
 * propagation so taps inside don't close the menu (the items are the
 * targets).
 */
const DELEGATED_CONTAINER_CLASSES = new Set(['markdown', 'task-context-menu'])

// ── CSS parsing ─────────────────────────────────────────────────────────────

type CssScope = 'base' | 'is-webview' | 'mobile-640'

type CssRule = {
  selector: string
  /** Per comma-part: the compounds (combinator-split) of that selector. */
  compounds: string[][]
  decls: Map<string, string>
  scope: CssScope
  media?: string
}

/** Split one selector part into compounds on top-level combinators (space > + ~). */
function splitCompounds(part: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of part) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth === 0 && /[>+~\s]/.test(ch)) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

function parseCssRules(cssText: string): CssRule[] {
  // Comments → spaces (newline-preserving) so offsets stay stable.
  const src = cssText.replace(/\/\*[\s\S]*?\*\//g, (mm) =>
    mm.replace(/[^\n]/g, ' '),
  )
  const rules: CssRule[] = []
  const mediaStack: Array<{ media: string; closeAt: number }> = []
  let i = 0
  const n = src.length

  while (i < n) {
    while (mediaStack.length && i >= mediaStack[mediaStack.length - 1].closeAt)
      mediaStack.pop()

    // Stray closing braces (e.g. the `}` that closes an @media block, which
    // the block-skip below never consumes) must not leak into the next
    // rule's prelude — `} .is-webview .btn` would otherwise never match.
    // Skip whitespace before each brace (CRLF sits between them).
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++
      if (i < n && src[i] === '}') {
        i++
        continue
      }
      break
    }
    if (i >= n) break

    const brace = src.indexOf('{', i)
    if (brace === -1) break
    const prelude = src.slice(i, brace).trim()

    let depth = 0
    let j = brace
    for (; j < n; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') {
        depth--
        if (depth === 0) break
      }
    }

    if (prelude.startsWith('@media')) {
      mediaStack.push({ media: prelude.replace(/\s+/g, ' '), closeAt: j })
      i = brace + 1
      continue
    }
    if (prelude.startsWith('@')) {
      i = j + 1 // skip @keyframes/@supports/@font-face/… blocks
      continue
    }

    const body = src.slice(brace + 1, j)
    const decls = new Map<string, string>()
    for (const decl of body.split(';')) {
      const colon = decl.indexOf(':')
      if (colon === -1) continue
      const prop = decl.slice(0, colon).trim().toLowerCase()
      const value = decl.slice(colon + 1).trim()
      if (prop) decls.set(prop, value)
    }

    const innermost = mediaStack[mediaStack.length - 1]?.media
    const isWebview = /(^|[\s,.>+~])\.is-webview\b/.test(prelude)
    const scope: CssScope = isWebview
      ? 'is-webview'
      : innermost
        ? 'mobile-640'
        : 'base'

    const parts = prelude
      .replace(/\s+/g, ' ')
      .split(',')
      .map((p) => p.trim())
    rules.push({
      selector: parts.join(', '),
      compounds: parts.map(splitCompounds).map((cs) => cs.filter(Boolean)),
      decls,
      scope,
      media: innermost,
    })
    i = j + 1
  }
  return rules
}

// ── Length resolution (with custom-property substitution) ───────────────────

/**
 * Custom properties resolved per scope: `base` = root tokens + base-rule
 * declarations (last base rule wins); `any` = additionally every
 * mobile-scoped declaration. A base rule resolves var() against `base` so a
 * mobile override of `--btn-padding-y` cannot masquerade as the base size;
 * mobile-scoped rules resolve against `any`.
 */
type CustomProps = { base: Map<string, string>; any: Map<string, string> }

function collectCustomProps(rules: CssRule[]): CustomProps {
  const base = new Map<string, string>()
  const any = new Map<string, string>()
  for (const rule of rules) {
    for (const [prop, value] of rule.decls) {
      if (!prop.startsWith('--')) continue
      any.set(prop, value)
      if (rule.scope === 'base') base.set(prop, value)
    }
  }
  return { base, any }
}

function substituteVars(
  value: string,
  vars: Map<string, string>,
  depth = 0,
): string {
  if (depth > 8 || !value.includes('var(')) return value
  const replaced = value.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
    (_all, name: string, fallback: string | undefined) =>
      vars.get(name) ?? fallback ?? '0',
  )
  return substituteVars(replaced, vars, depth + 1)
}

/**
 * Resolve a CSS length to px, or null when it cannot pin a size (auto / % /
 * calc() / clamp() / min() / max() / dvh / fit-content / …). Composite values
 * (`1px solid red`) read their first token. rem/em ≈ 16px.
 */
function parseLen(
  raw: string | undefined,
  vars: Map<string, string>,
): number | null {
  if (!raw) return null
  const v = substituteVars(raw, vars)
    .replace(/!important/i, '')
    .trim()
  if (v === '0' || v === '0px') return 0
  const first = v.split(/\s+/)[0]
  const m = /^(-?[\d.]+)(px|rem|em|pt)$/.exec(first)
  if (!m) return null
  const num = Number.parseFloat(m[1])
  if (Number.isNaN(num)) return null
  switch (m[2]) {
    case 'px':
      return num
    case 'rem':
    case 'em':
      return num * 16
    case 'pt':
      return num * (96 / 72)
  }
  return null
}

/** One axis (0 = vertical/top, 1 = horizontal/left) of a padding shorthand. */
function paddingAxis(
  shorthand: string | undefined,
  vars: Map<string, string>,
  axis: 0 | 1,
): number {
  if (!shorthand) return 0
  // Shorthand values can carry a trailing !important (`padding: 6px 16px
  // !important`) — strip it before parsing, mirroring parseLen.
  const resolved = substituteVars(shorthand, vars)
    .replace(/!important/i, '')
    .trim()
  if (/%|calc\(/.test(resolved)) return 0
  const lens = resolved
    .trim()
    .split(/\s+/)
    .map((p) => parseLen(p, vars))
  if (lens.some((l) => l == null)) return 0
  const l = lens as number[]
  if (l.length === 1) return l[0]
  if (l.length === 2) return l[axis]
  if (l.length === 3) return axis === 0 ? l[0] : l[2]
  return axis === 0 ? l[0] : l[3]
}

/**
 * The size floor (px) a rule pins on `axis`, or null when the rule leaves the
 * axis unpinned. Explicit width/height/min-* win; otherwise the border-box
 * content estimate applies to HEIGHT only (padding + 2×border +
 * lines×font×line-height). Width is never padding-derived (text-dependent).
 * Full-stretch overlays (top+bottom / inset covering both axes) are treated
 * as unpinned in height. Custom properties resolve against the scope layer
 * this rule belongs to (base rules see base tokens only).
 */
function ruleFloor(
  decls: Map<string, string>,
  props: CustomProps,
  axis: 'w' | 'h',
  isMobileScope: boolean,
): number | null {
  if (decls.get('display') === 'none') return null // renders nothing — pins no size
  // Mobile-scoped rules may override the base tokens; base rules must not
  // see them (a mobile `--btn-padding-y` bump cannot fake a base size).
  const vars = isMobileScope ? props.any : props.base
  const minRaw = decls.get(axis === 'w' ? 'min-width' : 'min-height')
  const min = parseLen(minRaw, vars)
  const explicit = parseLen(decls.get(axis === 'w' ? 'width' : 'height'), vars)

  const padShorthand = decls.get('padding')
  const padMain =
    axis === 'h'
      ? (parseLen(decls.get('padding-top'), vars) ??
        paddingAxis(padShorthand, vars, 0))
      : Math.max(
          parseLen(decls.get('padding-left'), vars) ??
            paddingAxis(padShorthand, vars, 1),
          parseLen(decls.get('padding-right'), vars) ??
            paddingAxis(padShorthand, vars, 1),
        )

  const borderShorthand = decls.get('border') ?? decls.get('border-width')
  const borderWidth =
    parseLen(decls.get('border-width'), vars) ??
    parseLen(borderShorthand, vars) ??
    (borderShorthand && !/^(none|0)/.test(borderShorthand.trim()) ? 1 : 0)

  const candidates: number[] = []
  if (explicit != null) candidates.push(explicit)
  if (min != null && min > SHRINK_IDIOM_PX) candidates.push(min)

  if (axis === 'h' && explicit == null) {
    // Height content estimate — only when this rule visibly boxes the element
    // (sets display/position) or contributes box geometry (padding/border/
    // font). A bare property list (color, margin, …) must not invent a size.
    const display = decls.get('display')
    const position = decls.get('position')
    const boxes =
      display !== undefined ||
      position !== undefined ||
      decls.get('padding') !== undefined ||
      decls.get('padding-top') !== undefined ||
      decls.get('padding-bottom') !== undefined ||
      decls.get('border') !== undefined ||
      decls.get('font-size') !== undefined
    if (boxes) {
      // Fixed/absolute overlays spanning both axes are viewport-sized, not
      // content-sized: ANY non-auto inset (1 value = all sides), or a
      // declared top+bottom pair (env() values included), means full stretch.
      if (position === 'fixed' || position === 'absolute') {
        const nonAuto = (v: string | undefined) =>
          v !== undefined && !/auto|initial|unset/.test(v)
        const inset = decls.get('inset')
        const top = decls.get('top')
        const bottom = decls.get('bottom')
        if ((inset && nonAuto(inset)) || (nonAuto(top) && nonAuto(bottom)))
          return null
      }
      const fontSize = parseLen(decls.get('font-size'), vars) ?? 13 // body ≈13px
      let lhFactor = 1.2
      const lhRaw = decls.get('line-height')
      if (lhRaw) {
        const trimmed = substituteVars(lhRaw, vars).trim()
        if (/^[\d.]+$/.test(trimmed)) lhFactor = Number.parseFloat(trimmed)
        else {
          const lhPx = parseLen(trimmed, vars)
          if (lhPx != null && fontSize > 0) lhFactor = lhPx / fontSize
        }
      }
      const clampRaw = decls.get('-webkit-line-clamp')
      const clamp =
        clampRaw && /^\d+$/.test(clampRaw.trim())
          ? Number.parseInt(clampRaw, 10)
          : null
      const lines = clamp ?? 1
      const box = lines * fontSize * lhFactor + padMain * 2 + borderWidth * 2
      if (box > 0) candidates.push(box)
    }
  }

  if (!candidates.length) return null
  return Math.max(...candidates)
}

// ── Findings ────────────────────────────────────────────────────────────────

type Finding = {
  target: string
  tag: string
  decidingScope: 'base' | 'mobile'
  axis: 'width' | 'height'
  floorPx: number
  shortfallPx: number
  decidingRules: Array<{ selector: string; scope: CssScope; floor: number }>
  refs: string[]
}

function classesOfCompound(compound: string): string[] {
  return (compound.match(/\.([A-Za-z][\w-]*)/g) ?? []).map((t) => t.slice(1))
}

/**
 * A rule applies to the element when some comma-part's SUBJECT compound's
 * classes ⊆ element classes. Ancestors are only honored for shell-truth
 * compounds (`.is-webview …`, `:root…`): a descendant context like
 * `.cap-row-actions .btn` is only true for SOME buttons — treating it as
 * global would fabricate floors for unrelated buttons. Skipping such rules
 * under-reports (a conservative, documented blind spot) instead of
 * over-reporting phantom pins.
 */
function ruleAppliesTo(rule: CssRule, elementClasses: Set<string>): boolean {
  for (const part of rule.compounds) {
    if (!part.length) continue
    const ancestors = part.slice(0, -1)
    if (
      ancestors.length &&
      !ancestors.every(
        (a) =>
          a === '.is-webview' ||
          a.startsWith(':root') ||
          a === 'html' ||
          a === 'body',
      )
    )
      continue
    const subject = part[part.length - 1]
    if (
      subject.includes('[') ||
      /::?(before|after|placeholder|selection|first-line|first-letter)/.test(
        subject,
      )
    )
      continue
    const tokens = classesOfCompound(subject)
    if (!tokens.length) continue
    if (tokens.every((t) => elementClasses.has(t))) return true
  }
  return false
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const cssPath = path.join(RENDERER_SRC, 'styles.css')
  const rules = parseCssRules(fs.readFileSync(cssPath, 'utf8'))
  const customProps = collectCustomProps(rules)

  const elements = [...harvestInteractiveElements(), ...HINT_TARGET_ELEMENTS]

  // Deduplicate targets by tag+class-set, accumulating refs.
  type Target = { tag: string; classes: string[]; refs: string[] }
  const targetMap = new Map<string, Target>()
  for (const el of elements) {
    if (el.classes.some((c) => DESKTOP_CHROME_CLASSES.has(c))) continue
    if (el.classes.some((c) => DELEGATED_CONTAINER_CLASSES.has(c))) continue
    const key = `${el.tag}|${[...el.classes].sort().join('.')}`
    if (!targetMap.has(key))
      targetMap.set(key, { tag: el.tag, classes: el.classes, refs: [] })
    const t = targetMap.get(key)!
    if (!t.refs.includes(el.ref)) t.refs.push(el.ref)
  }

  const findings: Finding[] = []

  for (const target of targetMap.values()) {
    const classSet = new Set(target.classes)
    const relevant = rules.filter((r) => ruleAppliesTo(r, classSet))
    if (!relevant.length) continue

    for (const axis of ['w', 'h'] as const) {
      const mobilePins: Array<{ rule: CssRule; floor: number }> = []
      const basePins: Array<{ rule: CssRule; floor: number }> = []
      for (const rule of relevant) {
        const isMobile = rule.scope !== 'base'
        const floor = ruleFloor(rule.decls, customProps, axis, isMobile)
        if (floor == null) continue
        ;(isMobile ? mobilePins : basePins).push({ rule, floor })
      }
      // Target-level full-stretch detection: the element may be a viewport-
      // sized overlay whose stretch comes from ANOTHER class's fixed+inset
      // rule (e.g. `.file-preview-backdrop` shares its element with
      // `.modal-backdrop { position:fixed; inset:0 }`). If any applicable
      // rule makes the element a stretched overlay, height is viewport-
      // derived — ignore per-rule full-stretch-missed content estimates.
      const stretchesViewport = relevant.some((r) => {
        if (r.decls.get('position') !== 'fixed') return false
        const inset = r.decls.get('inset')
        if (inset && !/auto/.test(inset)) return true
        const nonAuto = (v: string | undefined) =>
          v !== undefined && !/auto|initial|unset/.test(v)
        return nonAuto(r.decls.get('top')) && nonAuto(r.decls.get('bottom'))
      })
      // Mobile rules decide Android size; base pins carry through as lower
      // bounds (a mobile rule cannot shrink below a base min-* it doesn't
      // re-declare, and explicit base sizes usually persist).
      const deciding = mobilePins.length ? mobilePins : basePins
      if (!deciding.length) continue
      const decidingScope: 'base' | 'mobile' = mobilePins.length
        ? 'mobile'
        : 'base'
      const allPins = [...mobilePins, ...basePins]
      const floor = Math.max(...allPins.map((p) => p.floor))
      if (floor >= TARGET_PX) continue
      // Stretched overlays: only report when a real min-* pin (not a padding
      // content estimate) keeps it below the floor.
      if (stretchesViewport) {
        const minKey = axis === 'w' ? 'min-width' : 'min-height'
        const hasRealMinPin = relevant.some((r) => {
          const v = parseLen(r.decls.get(minKey), customProps.base)
          return v != null && v > SHRINK_IDIOM_PX
        })
        if (!hasRealMinPin) continue
      }

      findings.push({
        target: target.classes.join('.'),
        tag: target.tag,
        decidingScope,
        axis: axis === 'w' ? 'width' : 'height',
        floorPx: Math.round(floor * 10) / 10,
        shortfallPx: Math.round((TARGET_PX - floor) * 10) / 10,
        decidingRules: allPins
          .sort((a, b) => b.floor - a.floor)
          .slice(0, 6)
          .map((p) => ({
            selector: p.rule.selector,
            scope: p.rule.scope,
            floor: Math.round(p.floor * 10) / 10,
          })),
        refs: target.refs,
      })
    }
  }

  findings.sort((a, b) => b.shortfallPx - a.shortfallPx)

  // ── Output ──
  const meta = {
    generatedAt: new Date().toISOString(),
    targetPx: TARGET_PX,
    stylesheet: path.relative(ROOT, cssPath).replaceAll('\\', '/'),
    rulesParsed: rules.length,
    interactiveElementsHarvested: elements.length,
    targetsAudited: targetMap.size,
    totalFindings: findings.length,
    byScope: {
      mobile: findings.filter((f) => f.decidingScope === 'mobile').length,
      base: findings.filter((f) => f.decidingScope === 'base').length,
    },
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...meta, findings }, null, 2))
    return
  }

  if (process.argv.includes('--markdown')) {
    console.log(`## M-C1 touch-target static scan — floor ${TARGET_PX}px`)
    console.log('')
    console.log(
      `\`${meta.stylesheet}\` · ${meta.rulesParsed} rules · ${meta.targetsAudited} interactive targets (from ${meta.interactiveElementsHarvested} TSX element instances)`,
    )
    console.log('')
    console.log(
      `**${meta.byScope.mobile}** mobile-scoped finding(s) (Android rule already pins it small — adjust the scoped value) · **${meta.byScope.base}** base finding(s) (add a NEW \`.is-webview\`-scoped bump — never touch the base value)`,
    )
    console.log('')
    console.log('| scope | target | axis | Android floor | shortfall |')
    console.log('|---|---|---|---|---|')
    for (const f of findings) {
      console.log(
        `| ${f.decidingScope} | \`${f.tag}.${f.target}\` | ${f.axis} | ${f.floorPx}px | −${f.shortfallPx}px |`,
      )
    }
    console.log('')
    console.log(
      '_Blind spots: flex/grid stretch, calc()/clamp() chains, TSX inline styles, JS-toggled classes, min-* floors can be exceeded by content; 640px media covers portrait only._',
    )
    return
  }

  console.log(`AnyBuff M-C1 — static touch-target scan (floor ${TARGET_PX}px)`)
  console.log(
    `${meta.stylesheet}: ${meta.rulesParsed} rules, ${meta.targetsAudited} interactive targets (from ${meta.interactiveElementsHarvested} element instances)`,
  )
  console.log(
    `findings: ${meta.totalFindings} (mobile-scoped ${meta.byScope.mobile} / base ${meta.byScope.base})`,
  )
  console.log('')
  for (const f of findings) {
    const scopeTag = f.decidingScope === 'mobile' ? 'mobile' : 'base   '
    console.log(
      `[${scopeTag}] ${f.axis.padEnd(6)} floor=${f.floorPx + 'px'.padEnd(5)} shortfall=-${f.shortfallPx}px  ${f.tag}.${f.target}`,
    )
    for (const r of f.decidingRules.slice(0, 3)) {
      console.log(
        `    ${r.scope.padEnd(11)} floor=${(r.floor + 'px').padStart(7)}  ${r.selector}`,
      )
    }
    if (f.refs.length)
      console.log(
        `    ↳ ${f.refs.slice(0, 3).join(', ')}${f.refs.length > 3 ? ` (+${f.refs.length - 3})` : ''}`,
      )
  }
  console.log('')
  console.log(
    'report-only — touch bumps must be .is-webview / 640px-scoped; desktop base values stay untouched.',
  )
}

main()
