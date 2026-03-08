import { startMicrophoneCapture, type MicrophoneCaptureSession } from './microphone'
import { voiceSettings } from './voice-settings.svelte'
import type { VoiceBridgeEvent, VoiceInputMode, VoiceSettings, VoiceState } from '../types/voice'

/** Represents the renderer state needed by the conversation composer voice UI. */
export interface VoiceComposerState {
  draft: string
  inputMode: VoiceInputMode
  selectionEnd: number | null
  selectionRevision: number
  selectionStart: number | null
  voiceState: VoiceState
  voiceError: string
  isStartingVoice: boolean
}

/** Represents the label-relevant subset of voice composer state. */
export interface VoiceComposerStatusState {
  inputMode: VoiceInputMode
  voiceError: string
  voiceState: VoiceState
  isStartingVoice: boolean
}

/** Returns a user-facing voice status label for the current speech state. */
export function getVoiceStatusLabel(state: VoiceComposerStatusState): string {
  if (state.voiceError) {
    return 'Voice Error'
  }

  if (state.voiceState === 'recording') {
    return 'Listening'
  }

  if (state.voiceState === 'processing') {
    return 'Transcribing'
  }

  return 'Voice'
}

/** Returns the current push-to-talk button label. */
export function getVoiceButtonLabel(state: VoiceComposerStatusState): string {
  if (state.isStartingVoice) {
    return 'Start'
  }

  if (state.voiceState === 'recording') {
    return state.inputMode === 'toggle' ? 'Stop' : 'Release'
  }

  if (state.voiceState === 'processing') {
    return 'Wait'
  }

  return state.inputMode === 'toggle' ? 'Start' : 'Hold'
}

/** Combines the pre-voice draft and the latest transcript into one textarea value. */
function mergeDraftWithTranscript(baseDraft: string, transcript: string): string {
  if (!transcript) {
    return baseDraft
  }

  if (!baseDraft) {
    return transcript
  }

  if (/\s$/.test(baseDraft)) {
    return `${baseDraft}${transcript}`
  }

  return `${baseDraft} ${transcript}`
}

/** Returns the selection range for the newly appended transcript text. */
function getTranscriptSelectionRange(
  baseDraft: string,
  transcript: string,
): { selectionStart: number; selectionEnd: number } {
  if (!baseDraft) {
    return {
      selectionStart: 0,
      selectionEnd: transcript.length,
    }
  }

  const selectionStart = /\s$/.test(baseDraft) ? baseDraft.length : baseDraft.length + 1

  return {
    selectionStart,
    selectionEnd: selectionStart + transcript.length,
  }
}

/** Converts unknown errors into a short renderer-safe error message. */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Voice capture failed.'
}

/** Writes one voice shortcut debug message that can be mirrored into the Electron terminal. */
function logVoiceDebug(label: string, details: Record<string, boolean | number | string | null>): void {
  console.info(`[voice-debug] ${label} ${JSON.stringify(details)}`)
}

/** Controls the reactive voice-composer state and bridge lifecycle for the UI. */
export class VoiceComposerController {
  draft = $state('')
  selectionEnd = $state<number | null>(null)
  selectionRevision = $state(0)
  selectionStart = $state<number | null>(null)
  voiceState = $state<VoiceState>('idle')
  voiceError = $state('')
  isStartingVoice = $state(false)

  #draftBeforeVoice = ''
  #isDisabled = false
  #keyboardShortcutActive = false
  #shouldStopAfterStart = false
  #activePointerId: number | null = null
  #microphoneSession: MicrophoneCaptureSession | null = null
  #removeVoiceEventListener: (() => void) | null = null
  #keyDownListener = (event: KeyboardEvent) => {
    void this.handleKeyboardKeyDown(event)
  }
  #keyUpListener = (event: KeyboardEvent) => {
    void this.handleKeyboardKeyUp(event)
  }
  #blurListener = () => {
    void this.handleWindowBlur()
  }

  /** Returns the current voice interaction mode from persisted settings. */
  get inputMode(): VoiceInputMode {
    return voiceSettings.current.mode
  }

  /** Returns the latest controller state snapshot. */
  #currentState(): VoiceComposerState {
    return {
      draft: this.draft,
      inputMode: this.inputMode,
      selectionEnd: this.selectionEnd,
      selectionRevision: this.selectionRevision,
      selectionStart: this.selectionStart,
      voiceState: this.voiceState,
      voiceError: this.voiceError,
      isStartingVoice: this.isStartingVoice,
    }
  }

  /** Returns the latest persisted local voice settings snapshot. */
  #currentSettings(): VoiceSettings {
    return voiceSettings.current
  }

  /** Returns whether the current mode uses hold-style press semantics. */
  #isHoldMode(): boolean {
    return this.#currentSettings().mode === 'hold'
  }

  /** Returns the normalized configured shortcut parts for keyboard voice input. */
  #getKeyboardShortcutConfig(): {
    keyCode: string
    requiresCtrl: boolean
    requiresShift: boolean
    requiresAlt: boolean
    requiresMeta: boolean
  } {
    const shortcutParts = this.#currentSettings().keyboardShortcut.split('+')

    return {
      keyCode: shortcutParts[shortcutParts.length - 1],
      requiresCtrl: shortcutParts.includes('Ctrl'),
      requiresShift: shortcutParts.includes('Shift'),
      requiresAlt: shortcutParts.includes('Alt'),
      requiresMeta: shortcutParts.includes('Meta'),
    }
  }

  /** Returns whether a keyboard event matches the configured voice shortcut. */
  #isMatchingKeyboardShortcut(event: KeyboardEvent): boolean {
    const settings = this.#currentSettings()
    const { keyCode, requiresCtrl, requiresShift, requiresAlt, requiresMeta } =
      this.#getKeyboardShortcutConfig()

    return (
      settings.keyboardEnabled &&
      event.code === keyCode &&
      event.ctrlKey === requiresCtrl &&
      event.shiftKey === requiresShift &&
      event.altKey === requiresAlt &&
      event.metaKey === requiresMeta
    )
  }

  /** Returns whether releasing this key should stop an active hold-to-talk shortcut. */
  #isKeyboardShortcutRelease(event: KeyboardEvent): boolean {
    const settings = this.#currentSettings()
    const { keyCode, requiresCtrl, requiresShift, requiresAlt, requiresMeta } =
      this.#getKeyboardShortcutConfig()

    if (!settings.keyboardEnabled) {
      return false
    }

    return (
      event.code === keyCode ||
      (requiresCtrl && event.code.startsWith('Control')) ||
      (requiresShift && event.code.startsWith('Shift')) ||
      (requiresAlt && event.code.startsWith('Alt')) ||
      (requiresMeta && event.code.startsWith('Meta'))
    )
  }

  /** Stops the current browser microphone session and releases its resources. */
  async #stopMicrophoneSession(): Promise<void> {
    if (!this.#microphoneSession) {
      return
    }

    const session = this.#microphoneSession
    this.#microphoneSession = null
    await session.stop()
  }

  /** Starts push-to-talk capture and the matching main-process STT session. */
  async #startVoiceCapture(disabled: boolean): Promise<void> {
    const snapshot = this.#currentState()

    if (disabled || snapshot.isStartingVoice || snapshot.voiceState !== 'idle') {
      return
    }

    this.#draftBeforeVoice = snapshot.draft
    this.isStartingVoice = true
    this.voiceError = ''
    logVoiceDebug('start-capture', {
      disabled,
      isStartingVoice: snapshot.isStartingVoice,
      voiceState: snapshot.voiceState,
    })

    try {
      await window.videApi.startVoice()
      this.#microphoneSession = await startMicrophoneCapture((samples) => {
        window.videApi.sendVoiceChunk(samples)
      })
    } catch (error) {
      await this.#stopMicrophoneSession()
      await window.videApi.cancelVoice()
      this.draft = this.#draftBeforeVoice
      this.voiceError = getErrorMessage(error)
      this.voiceState = 'idle'
    } finally {
      this.isStartingVoice = false
    }
  }

  /** Stops the active push-to-talk session and asks the main process to finalize it. */
  async #stopVoiceCapture(): Promise<void> {
    logVoiceDebug('stop-capture', {
      hasMicrophoneSession: this.#microphoneSession !== null,
      voiceState: this.#currentState().voiceState,
    })
    await this.#stopMicrophoneSession()

    const snapshot = this.#currentState()
    if (snapshot.voiceState === 'recording' || snapshot.voiceState === 'processing') {
      await window.videApi.stopVoice()
    }
  }

  /** Cancels the active push-to-talk session without committing a final transcript. */
  async #cancelVoiceCapture(): Promise<void> {
    logVoiceDebug('cancel-capture', {
      hasMicrophoneSession: this.#microphoneSession !== null,
      keyboardShortcutActive: this.#keyboardShortcutActive,
      voiceState: this.#currentState().voiceState,
    })
    await this.#stopMicrophoneSession()
    await window.videApi.cancelVoice()
    this.draft = this.#draftBeforeVoice
    this.selectionEnd = null
    this.selectionStart = null
    this.voiceState = 'idle'
  }

  /** Starts capture for inputs that should behave like hold-to-talk. */
  async #handleHoldInputStart(disabled: boolean): Promise<void> {
    if (!this.#isHoldMode()) {
      return
    }

    await this.#startVoiceCapture(disabled)
  }

  /** Stops capture for inputs that should behave like hold-to-talk. */
  async #handleHoldInputEnd(): Promise<void> {
    if (!this.#isHoldMode()) {
      return
    }

    await this.#stopVoiceCapture()
  }

  /** Toggles capture for inputs that should behave like click-to-toggle. */
  async #handleToggleInput(disabled: boolean): Promise<void> {
    if (this.#isHoldMode()) {
      return
    }

    const snapshot = this.#currentState()

    if (disabled || snapshot.isStartingVoice || snapshot.voiceState === 'processing') {
      return
    }

    if (snapshot.voiceState === 'recording') {
      await this.#stopVoiceCapture()
      return
    }

    if (snapshot.voiceState === 'idle') {
      await this.#startVoiceCapture(disabled)
    }
  }

  /** Applies voice events from Electron to the local controller state. */
  handleVoiceEvent(event: VoiceBridgeEvent): void {
    logVoiceDebug('voice-event', {
      type: event.type,
      keyboardShortcutActive: this.#keyboardShortcutActive,
      voiceState: this.voiceState,
      isStartingVoice: this.isStartingVoice,
      textLength: 'text' in event ? event.text.length : null,
      hasMessage: 'message' in event ? event.message.length > 0 : null,
    })

    if (event.type === 'state') {
      this.voiceState = event.state
      return
    }

    if (event.type === 'partial') {
      this.draft = mergeDraftWithTranscript(this.#draftBeforeVoice, event.text)
      this.voiceError = ''
      this.selectionEnd = null
      this.selectionStart = null
      return
    }

    if (event.type === 'final') {
      if (event.text) {
        const mergedDraft = mergeDraftWithTranscript(this.#draftBeforeVoice, event.text)
        const { selectionStart, selectionEnd } = getTranscriptSelectionRange(this.#draftBeforeVoice, event.text)
        this.#draftBeforeVoice = mergedDraft
        this.draft = mergedDraft
        this.selectionEnd = selectionEnd
        this.selectionRevision += 1
        this.selectionStart = selectionStart
      }

      this.voiceError = ''
      return
    }

    this.draft = this.#draftBeforeVoice
    this.voiceError = event.message
  }

  /** Starts voice capture when the push-to-talk button is pressed down. */
  async handleVoicePointerDown(event: PointerEvent, disabled: boolean): Promise<void> {
    if (!this.#isHoldMode()) {
      return
    }

    if (this.#activePointerId !== null) {
      return
    }

    this.#activePointerId = event.pointerId
    this.#shouldStopAfterStart = false

    const button = event.currentTarget as HTMLButtonElement
    button.setPointerCapture(event.pointerId)

    await this.#handleHoldInputStart(disabled)

    if (this.#shouldStopAfterStart) {
      this.#shouldStopAfterStart = false
      await this.#handleHoldInputEnd()
    }
  }

  /** Stops voice capture when the push-to-talk button is released. */
  async handleVoicePointerUp(event: PointerEvent): Promise<void> {
    if (!this.#isHoldMode()) {
      return
    }

    if (this.#activePointerId !== event.pointerId) {
      return
    }

    const button = event.currentTarget as HTMLButtonElement
    if (button.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId)
    }

    this.#activePointerId = null

    if (this.isStartingVoice) {
      this.#shouldStopAfterStart = true
      return
    }

    await this.#handleHoldInputEnd()
  }

  /** Cancels the current pointer interaction when the browser aborts it. */
  async handleVoicePointerCancel(): Promise<void> {
    if (!this.#isHoldMode()) {
      return
    }

    this.#activePointerId = null
    this.#shouldStopAfterStart = false
    await this.#cancelVoiceCapture()
  }

  /** Routes a button click through the configured toggle input behavior. */
  async handleVoiceClick(disabled: boolean): Promise<void> {
    await this.#handleToggleInput(disabled)
  }

  /** Handles keyboard keydown events for hold-to-talk and toggle-to-talk voice input. */
  async handleKeyboardKeyDown(event: KeyboardEvent): Promise<void> {
    const matchesShortcut = this.#isMatchingKeyboardShortcut(event)
    logVoiceDebug('keydown', {
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      repeat: event.repeat,
      matchesShortcut,
      keyboardShortcutActive: this.#keyboardShortcutActive,
      voiceState: this.voiceState,
    })

    if (!matchesShortcut) {
      return
    }

    const settings = this.#currentSettings()

    if (this.#isDisabled) {
      return
    }

    event.preventDefault()

    if (settings.mode === 'hold') {
      if (event.repeat || this.#keyboardShortcutActive) {
        return
      }

      this.#keyboardShortcutActive = true
      await this.#handleHoldInputStart(false)
      return
    }

    if (event.repeat) {
      return
    }

    await this.#handleToggleInput(false)
  }

  /** Stops hold-to-talk capture when the configured keyboard shortcut is released. */
  async handleKeyboardKeyUp(event: KeyboardEvent): Promise<void> {
    const matchesShortcut = this.#isMatchingKeyboardShortcut(event)
    const releasesShortcut = this.#isKeyboardShortcutRelease(event)
    logVoiceDebug('keyup', {
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      matchesShortcut,
      releasesShortcut,
      keyboardShortcutActive: this.#keyboardShortcutActive,
      voiceState: this.voiceState,
    })

    if (!releasesShortcut || !this.#keyboardShortcutActive) {
      return
    }

    this.#keyboardShortcutActive = false
    event.preventDefault()

    await this.#handleHoldInputEnd()
  }

  /** Cancels an active hold-to-talk key session when the window loses focus. */
  async handleWindowBlur(): Promise<void> {
    logVoiceDebug('window-blur', {
      keyboardShortcutActive: this.#keyboardShortcutActive,
      voiceState: this.voiceState,
      isStartingVoice: this.isStartingVoice,
    })

    if (!this.#keyboardShortcutActive) {
      return
    }

    this.#keyboardShortcutActive = false
    await this.#cancelVoiceCapture()
  }

  /** Connects the controller to the Electron voice event stream. */
  connect(): void {
    if (this.#removeVoiceEventListener) {
      return
    }

    this.#removeVoiceEventListener = window.videApi.onVoiceEvent((event) => {
      this.handleVoiceEvent(event)
    })
    window.addEventListener('keydown', this.#keyDownListener)
    window.addEventListener('keyup', this.#keyUpListener)
    window.addEventListener('blur', this.#blurListener)
  }

  /** Disconnects the controller and tears down any active voice session. */
  async destroy(): Promise<void> {
    this.#removeVoiceEventListener?.()
    this.#removeVoiceEventListener = null
    window.removeEventListener('keydown', this.#keyDownListener)
    window.removeEventListener('keyup', this.#keyUpListener)
    window.removeEventListener('blur', this.#blurListener)
    await this.#cancelVoiceCapture()
  }

  /** Updates whether the controller should ignore new user input. */
  setDisabled(disabled: boolean): void {
    this.#isDisabled = disabled
  }

  /** Updates the current composer draft value. */
  setDraft(draft: string): void {
    this.draft = draft
  }
}

/** Creates the extracted voice/session controller for the conversation composer. */
export function createVoiceComposerController(): VoiceComposerController {
  return new VoiceComposerController()
}
