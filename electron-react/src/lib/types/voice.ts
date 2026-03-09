/** Represents the speech-to-text session state exposed to the renderer. */
export type VoiceState = 'idle' | 'recording' | 'processing'

/** Represents the supported keyboard voice interaction modes. */
export type VoiceInputMode = 'hold' | 'toggle'

/** Represents the persisted voice input settings for the local client. */
export interface VoiceSettings {
  mode: VoiceInputMode
  keyboardEnabled: boolean
  keyboardShortcut: string
}

/** Represents a partial transcript update emitted while speech is in progress. */
export interface VoicePartialEvent {
  type: 'partial'
  text: string
}

/** Represents a finalized transcript emitted after speech capture ends. */
export interface VoiceFinalEvent {
  type: 'final'
  text: string
}

/** Represents a voice pipeline error surfaced to the renderer. */
export interface VoiceErrorEvent {
  type: 'error'
  message: string
}

/** Represents a voice session state transition emitted to the renderer. */
export interface VoiceStateEvent {
  type: 'state'
  state: VoiceState
}

/** Represents any voice event emitted across the Electron bridge. */
export type VoiceBridgeEvent =
  | VoicePartialEvent
  | VoiceFinalEvent
  | VoiceErrorEvent
  | VoiceStateEvent
