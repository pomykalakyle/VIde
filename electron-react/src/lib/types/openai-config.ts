/** Represents the supported local secret-storage modes for the OpenAI key. */
export type SecretStorageMode = 'plaintext' | 'encrypted'

/** Represents the renderer-safe OpenAI config summary returned by the Bun backend. */
export interface OpenAiConfigSummary {
  applyError: string
  defaultModel: string
  hasOpenAIKey: boolean
  lastAppliedSavedRevision: number | null
  locked: boolean
  needsApply: boolean
  runtimeAvailable: boolean
  secretStorageMode: SecretStorageMode
}

/** Represents the payload used to save or update the OpenAI API key. */
export interface SaveOpenAiConfigRequest {
  apiKey: string
}

/** Represents the payload used to unlock the encrypted OpenAI key store. */
export interface UnlockOpenAiConfigRequest {
  passphrase: string
}

/** Represents the payload used to convert between local secret-storage modes. */
export interface ConvertOpenAiConfigRequest {
  currentPassphrase?: string
  newPassphrase?: string
  targetMode: SecretStorageMode
}
