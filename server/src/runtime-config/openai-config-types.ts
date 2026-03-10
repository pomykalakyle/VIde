/** Represents the supported local secret-storage modes for the OpenAI key. */
export type SecretStorageMode = 'plaintext' | 'encrypted'

/** Represents the persisted config metadata stored alongside the OpenAI secrets. */
export interface OpenAiConfigFile {
  defaultModel: string
  openai: {
    savedRevision: number
  }
  secretStorageMode: SecretStorageMode
  version: 1
}

/** Represents the plaintext secrets file stored on disk for the OpenAI key. */
export interface OpenAiPlaintextSecretsFile {
  openaiApiKey: string
  version: 1
}

/** Represents the encrypted secrets envelope stored on disk for the OpenAI key. */
export interface OpenAiEncryptedSecretsFile {
  authTag: string
  ciphertext: string
  kdf: 'scrypt'
  nonce: string
  salt: string
  version: 1
}

/** Represents the renderer-safe summary returned by the Bun OpenAI config API. */
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
