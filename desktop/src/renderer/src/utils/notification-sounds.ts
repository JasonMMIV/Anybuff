/**
 * Renderer-local notification sounds (AnyBuff).
 *
 * Gentle Web-Audio chimes played when a conversation turn finishes, is
 * interrupted, or pauses to wait for the user (ask_user questions or an
 * approval_request for a terminal command). Renderer-only by design:
 *
 *   - No audio assets — every tone is synthesized with OscillatorNode, so the
 *     app ships zero extra files.
 *   - The on/off preference lives in localStorage beside the theme keys
 *     ('AnyBuff-*'), defaulting to ON.
 *   - Every entry point is best-effort: a missing AudioContext (SSR / odd
 *     webview) or a still-suspended context (autoplay policy) fails silently —
 *     audio must never throw into the run-event handler.
 */

const STORAGE_KEY = 'AnyBuff-notification-sound'

/* ─── Preference ─────────────────────────────────────────────────────── */

/** Sounds default to ON when the key is absent or unreadable. */
export function isNotificationSoundEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export function setNotificationSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Storage unavailable (private mode / sandboxed webview): the preference
    // just won't persist — playback inside this session still follows it.
  }
}

/* ─── Audio context (lazy singleton) ─────────────────────────────────── */

let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null
  if (!audioContext) {
    try {
      audioContext = new AudioContext()
    } catch {
      return null
    }
  }
  return audioContext
}

/**
 * Chromium's autoplay policy lets an AudioContext run only after a user
 * gesture. Runs normally start from a click anyway, but a run finishing while
 * the user is away must still be able to chime — so the first pointer/key/
 * touch event of the session wakes the context.
 */
function unlockAudioContext(): void {
  const audio = getAudioContext()
  if (audio && audio.state === 'suspended') {
    void audio.resume().catch(() => {})
  }
}

let unlockListenersInstalled = false
function installGestureUnlock(): void {
  if (unlockListenersInstalled || typeof document === 'undefined') return
  unlockListenersInstalled = true
  const onGesture = (): void => unlockAudioContext()
  // First gesture of any kind is enough — once the context is running the
  // per-play resume() below is a no-op, so the listeners can be one-shot.
  for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
    document.addEventListener(type, onGesture, { once: true, passive: true })
  }
}

/* ─── Tone synthesis ─────────────────────────────────────────────────── */

interface ToneNote {
  /** Oscillator frequency in Hz. */
  freq: number
  /** Seconds after playback start at which this note begins. */
  at: number
  /** Note length in seconds, decay tail included. */
  dur: number
  /** Peak gain. Kept low (~0.05-0.07) so the chimes stay gentle. */
  gain?: number
}

/**
 * Schedule a pattern immediately. All tones are pure sines with a short
 * linear attack and an exponential release — no harsh harmonics, no clicks.
 */
function scheduleNotes(notes: ToneNote[]): void {
  const audio = getAudioContext()
  if (!audio) return
  installGestureUnlock()
  unlockAudioContext()
  // Autoplay policy still blocking (no gesture seen yet): drop the chime
  // rather than queue it silently.
  if (audio.state !== 'running') return

  const startAt = audio.currentTime + 0.02
  const attack = 0.015
  for (const note of notes) {
    const peak = note.gain ?? 0.06
    const noteStart = startAt + note.at
    const noteEnd = noteStart + note.dur
    try {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(note.freq, noteStart)
      gain.gain.setValueAtTime(0.0001, noteStart)
      gain.gain.linearRampToValueAtTime(peak, noteStart + attack)
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd)
      osc.connect(gain)
      gain.connect(audio.destination)
      osc.start(noteStart)
      osc.stop(noteEnd + 0.02)
      osc.onended = () => {
        try {
          osc.disconnect()
          gain.disconnect()
        } catch {
          // already disconnected — nothing to reclaim
        }
      }
    } catch {
      // A failed note must never throw into the caller (run-event handler).
    }
  }
}

/* ─── Same-kind coalescing ────────────────────────────────────────────── */

/**
 * Don't replay the same kind of chime within this window. An agent that
 * serially requests command approvals (strict/balanced mode) fires one
 * approval_request per command — the user is already at the keyboard clicking
 * through them, so only the first knock should sound until the pause is over.
 */
const KIND_COOLDOWN_MS = 2500
const lastPlayedAt: Record<string, number> = {}

function playKind(kind: string, notes: ToneNote[]): void {
  if (!isNotificationSoundEnabled()) return
  const now = Date.now()
  if (now - (lastPlayedAt[kind] ?? 0) < KIND_COOLDOWN_MS) return
  lastPlayedAt[kind] = now
  scheduleNotes(notes)
}

/* ─── Curated patterns ───────────────────────────────────────────────── */

/** Rising C5-E5-G5 arpeggio — a conversation finished successfully. */
const FINISH_PATTERN: ToneNote[] = [
  { freq: 523.25, at: 0.0, dur: 0.42, gain: 0.07 }, // C5
  { freq: 659.25, at: 0.13, dur: 0.44, gain: 0.06 }, // E5
  { freq: 783.99, at: 0.26, dur: 0.6, gain: 0.05 } // G5
]

/** Soft G4-E4 descent — the run was interrupted (error / stopped). */
const INTERRUPT_PATTERN: ToneNote[] = [
  { freq: 392.0, at: 0.0, dur: 0.42, gain: 0.05 }, // G4
  { freq: 329.63, at: 0.2, dur: 0.55, gain: 0.045 } // E4
]

/** Two quiet knocks — the run is paused, waiting for user input. */
const PAUSED_PATTERN: ToneNote[] = [
  { freq: 659.25, at: 0.0, dur: 0.12, gain: 0.055 },
  { freq: 659.25, at: 0.16, dur: 0.12, gain: 0.055 }
]

export function playRunFinishedSound(): void {
  playKind('finish', FINISH_PATTERN)
}

export function playRunInterruptedSound(): void {
  playKind('interrupted', INTERRUPT_PATTERN)
}

export function playRunPausedSound(): void {
  playKind('paused', PAUSED_PATTERN)
}

/** Audition the finish chime — plays even while sounds are muted. */
export function previewNotificationSound(): void {
  scheduleNotes(FINISH_PATTERN)
}

// Wake the audio context on the app's first interaction (installGestureUnlock).
if (typeof document !== 'undefined') installGestureUnlock()
