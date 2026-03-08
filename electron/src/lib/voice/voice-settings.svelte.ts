import type { VoiceInputMode, VoiceSettings } from '../types/voice'

const storageKey = 'vide.voiceSettings'
const defaultKeyboardShortcut = 'Ctrl+Shift+Space'
const legacyDefaultKeyboardShortcuts = new Set(['Backquote', 'Ctrl+Shift+KeyO'])
const defaultVoiceSettings: VoiceSettings = {
  mode: 'hold',
  keyboardEnabled: true,
  keyboardShortcut: defaultKeyboardShortcut,
}

/** Returns whether a value matches a supported voice interaction mode. */
function isVoiceInputMode(value: string): value is VoiceInputMode {
  return value === 'hold' || value === 'toggle'
}

/** Merges unknown stored data into a valid voice settings object. */
function normalizeVoiceSettings(value: unknown): VoiceSettings {
  if (!value || typeof value !== 'object') {
    return defaultVoiceSettings
  }

  const partialSettings = value as Partial<VoiceSettings>
  let mode: VoiceInputMode = defaultVoiceSettings.mode
  if (isVoiceInputMode(partialSettings.mode ?? '')) {
    mode = partialSettings.mode as VoiceInputMode
  }
  const keyboardShortcut =
    typeof partialSettings.keyboardShortcut === 'string' && partialSettings.keyboardShortcut.length > 0
      ? legacyDefaultKeyboardShortcuts.has(partialSettings.keyboardShortcut)
        ? defaultKeyboardShortcut
        : partialSettings.keyboardShortcut
      : defaultVoiceSettings.keyboardShortcut

  return {
    mode,
    keyboardEnabled:
      typeof partialSettings.keyboardEnabled === 'boolean'
        ? partialSettings.keyboardEnabled
        : defaultVoiceSettings.keyboardEnabled,
    keyboardShortcut,
  }
}

/** Reads the persisted voice settings from local storage. */
function readStoredVoiceSettings(): VoiceSettings {
  if (typeof window === 'undefined') {
    return defaultVoiceSettings
  }

  const rawValue = window.localStorage.getItem(storageKey)

  if (!rawValue) {
    return defaultVoiceSettings
  }

  try {
    return normalizeVoiceSettings(JSON.parse(rawValue))
  } catch {
    return defaultVoiceSettings
  }
}

/** Persists the provided voice settings object to local storage. */
function persistVoiceSettings(settings: VoiceSettings): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(storageKey, JSON.stringify(settings))
}

/** Stores the persisted local voice interaction settings for the renderer. */
class VoiceSettingsState {
  current = $state.raw(readStoredVoiceSettings())

  /** Replaces the current settings with a normalized persisted value. */
  set(settings: VoiceSettings): void {
    const normalizedSettings = normalizeVoiceSettings(settings)
    this.current = normalizedSettings
    persistVoiceSettings(normalizedSettings)
  }

  /** Applies a functional update to the current settings and persists the result. */
  update(updater: (settings: VoiceSettings) => VoiceSettings): void {
    const nextSettings = normalizeVoiceSettings(updater(this.current))
    this.current = nextSettings
    persistVoiceSettings(nextSettings)
  }

  /** Restores the default local voice settings. */
  reset(): void {
    this.current = defaultVoiceSettings
    persistVoiceSettings(defaultVoiceSettings)
  }
}

/** Stores the persisted local voice interaction settings. */
export const voiceSettings = new VoiceSettingsState()
