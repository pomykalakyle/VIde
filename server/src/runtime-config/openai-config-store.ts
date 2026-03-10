import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type {
  ConvertOpenAiConfigRequest,
  OpenAiConfigFile,
  OpenAiConfigSummary,
  OpenAiEncryptedSecretsFile,
  OpenAiPlaintextSecretsFile,
  SaveOpenAiConfigRequest,
  SecretStorageMode,
} from './openai-config-types'

const configFileName = 'config.json'
const encryptedSecretsFileName = 'secrets.enc'
const plaintextSecretsFileName = 'secrets.json'
const encryptionKeyLength = 32

/** Represents one custom error surfaced by the local OpenAI config store. */
export class OpenAiConfigStoreError extends Error {
  readonly statusCode: number

  /** Stores the renderer-safe error message and matching HTTP status code. */
  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'OpenAiConfigStoreError'
    this.statusCode = statusCode
  }
}

/** Represents one decrypted OpenAI secrets payload kept only in process memory. */
interface OpenAiSecretsPayload {
  openaiApiKey: string
}

/** Represents one saved OpenAI credential revision resolved from local storage. */
export interface SavedOpenAiCredential {
  apiKey: string | null
  savedRevision: number
}

/** Represents the Bun-owned local store used to manage OpenAI runtime credentials. */
export interface OpenAiConfigStore {
  applySavedCredentialToRuntimeResult(errorMessage: string): Promise<void>
  clearOpenAiKey(): Promise<OpenAiConfigSummary>
  convertSecretStorage(request: ConvertOpenAiConfigRequest): Promise<OpenAiConfigSummary>
  getSavedCredentialForApply(): Promise<SavedOpenAiCredential>
  getSummary(): Promise<OpenAiConfigSummary>
  markRuntimeStarted(): Promise<void>
  markRuntimeStopped(): void
  saveOpenAiKey(request: SaveOpenAiConfigRequest): Promise<OpenAiConfigSummary>
  setRuntimeApplySuccess(savedRevision: number): Promise<void>
  unlockEncryptedStore(passphrase: string): Promise<OpenAiConfigSummary>
}

/** Returns whether the provided unknown value is a non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Returns the parsed JSON contents of one file path or null when it is missing. */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const fileContents = await readFile(filePath, 'utf8')
    return JSON.parse(fileContents) as T
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

/** Writes one UTF-8 file atomically by renaming a temporary file into place. */
async function writeFileAtomically(filePath: string, fileContents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`

  await writeFile(temporaryPath, fileContents, 'utf8')
  await rename(temporaryPath, filePath)
}

/** Writes one JSON file atomically using stable indentation. */
async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

/** Removes one file path and ignores the case where it is already missing. */
async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    await rm(filePath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return
    }

    throw error
  }
}

/** Returns the validated persisted config metadata or throws for invalid JSON shape. */
function parseConfigFile(
  value: unknown,
  defaultModel: string,
  defaultSecretStorageMode: SecretStorageMode,
): OpenAiConfigFile {
  if (!isRecord(value)) {
    return {
      defaultModel,
      openai: { savedRevision: 0 },
      secretStorageMode: defaultSecretStorageMode,
      version: 1,
    }
  }

  const openaiValue = isRecord(value.openai) ? value.openai : {}
  const savedRevision = typeof openaiValue.savedRevision === 'number' ? openaiValue.savedRevision : 0

  return {
    defaultModel: typeof value.defaultModel === 'string' && value.defaultModel.length > 0
      ? value.defaultModel
      : defaultModel,
    openai: {
      savedRevision: Number.isInteger(savedRevision) && savedRevision >= 0 ? savedRevision : 0,
    },
    secretStorageMode:
      value.secretStorageMode === 'encrypted' || value.secretStorageMode === 'plaintext'
        ? value.secretStorageMode
        : defaultSecretStorageMode,
    version: 1,
  }
}

/** Returns the validated plaintext OpenAI secrets payload or throws for invalid JSON shape. */
function parsePlaintextSecretsFile(value: unknown): OpenAiPlaintextSecretsFile | null {
  if (!isRecord(value)) {
    return null
  }

  if (value.version !== 1 || typeof value.openaiApiKey !== 'string') {
    throw new OpenAiConfigStoreError('The plaintext OpenAI secrets file is invalid.', 500)
  }

  return {
    openaiApiKey: value.openaiApiKey,
    version: 1,
  }
}

/** Returns the validated encrypted OpenAI secrets envelope or throws for invalid JSON shape. */
function parseEncryptedSecretsFile(value: unknown): OpenAiEncryptedSecretsFile | null {
  if (!isRecord(value)) {
    return null
  }

  if (
    value.version !== 1 ||
    value.kdf !== 'scrypt' ||
    typeof value.salt !== 'string' ||
    typeof value.nonce !== 'string' ||
    typeof value.authTag !== 'string' ||
    typeof value.ciphertext !== 'string'
  ) {
    throw new OpenAiConfigStoreError('The encrypted OpenAI secrets file is invalid.', 500)
  }

  return {
    authTag: value.authTag,
    ciphertext: value.ciphertext,
    kdf: 'scrypt',
    nonce: value.nonce,
    salt: value.salt,
    version: 1,
  }
}

/** Derives the symmetric encryption key for one passphrase and salt pair. */
function deriveEncryptionKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, encryptionKeyLength)
}

/** Encrypts one OpenAI secrets payload into a file-safe JSON envelope. */
function encryptSecretsPayload(
  payload: OpenAiSecretsPayload,
  passphrase: string,
): OpenAiEncryptedSecretsFile {
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveEncryptionKey(passphrase, salt), nonce)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return {
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    kdf: 'scrypt',
    nonce: nonce.toString('base64'),
    salt: salt.toString('base64'),
    version: 1,
  }
}

/** Decrypts one OpenAI secrets envelope using the provided passphrase. */
function decryptSecretsPayload(
  encryptedSecrets: OpenAiEncryptedSecretsFile,
  passphrase: string,
): OpenAiSecretsPayload {
  try {
    const salt = Buffer.from(encryptedSecrets.salt, 'base64')
    const nonce = Buffer.from(encryptedSecrets.nonce, 'base64')
    const authTag = Buffer.from(encryptedSecrets.authTag, 'base64')
    const ciphertext = Buffer.from(encryptedSecrets.ciphertext, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', deriveEncryptionKey(passphrase, salt), nonce)

    decipher.setAuthTag(authTag)

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    const parsed = JSON.parse(plaintext) as Partial<OpenAiSecretsPayload>

    if (typeof parsed.openaiApiKey !== 'string') {
      throw new Error('The decrypted OpenAI key payload is invalid.')
    }

    return {
      openaiApiKey: parsed.openaiApiKey,
    }
  } catch {
    throw new OpenAiConfigStoreError('The encrypted OpenAI key store could not be unlocked.', 401)
  }
}

/** Creates one Bun-owned local OpenAI credential store backed by config files on disk. */
export function createOpenAiConfigStore(options: {
  configDirectory: string
  defaultModel: string
  defaultSecretStorageMode?: SecretStorageMode
}): OpenAiConfigStore {
  const configDirectory = options.configDirectory
  const defaultModel = options.defaultModel
  const defaultSecretStorageMode = options.defaultSecretStorageMode ?? 'plaintext'
  const configFilePath = path.join(configDirectory, configFileName)
  const plaintextSecretsFilePath = path.join(configDirectory, plaintextSecretsFileName)
  const encryptedSecretsFilePath = path.join(configDirectory, encryptedSecretsFileName)
  let appliedRevision: number | null = null
  let applyError = ''
  let runtimeAvailable = false
  let unlockedPassphrase: string | null = null

  /** Returns the persisted config metadata or the default initial config. */
  async function readConfigFile(): Promise<OpenAiConfigFile> {
    return parseConfigFile(
      await readJsonFile<unknown>(configFilePath),
      defaultModel,
      defaultSecretStorageMode,
    )
  }

  /** Writes the persisted config metadata to disk. */
  async function writeConfigFile(configFile: OpenAiConfigFile): Promise<void> {
    await writeJsonFileAtomically(configFilePath, configFile)
  }

  /** Returns the plaintext OpenAI secrets file when it exists. */
  async function readPlaintextSecretsFile(): Promise<OpenAiPlaintextSecretsFile | null> {
    return parsePlaintextSecretsFile(await readJsonFile<unknown>(plaintextSecretsFilePath))
  }

  /** Returns the encrypted OpenAI secrets file when it exists. */
  async function readEncryptedSecretsFile(): Promise<OpenAiEncryptedSecretsFile | null> {
    return parseEncryptedSecretsFile(await readJsonFile<unknown>(encryptedSecretsFilePath))
  }

  /** Returns whether the current encrypted store requires an unlock passphrase. */
  async function isEncryptedStoreLocked(configFile: OpenAiConfigFile): Promise<boolean> {
    if (configFile.secretStorageMode !== 'encrypted') {
      return false
    }

    const encryptedSecretsFile = await readEncryptedSecretsFile()

    return encryptedSecretsFile !== null && unlockedPassphrase === null
  }

  /** Returns whether the local store currently has a saved OpenAI key on disk. */
  async function hasStoredOpenAiKey(configFile: OpenAiConfigFile): Promise<boolean> {
    if (configFile.secretStorageMode === 'plaintext') {
      return (await readPlaintextSecretsFile()) !== null
    }

    return (await readEncryptedSecretsFile()) !== null
  }

  /** Returns the current saved revision from the config metadata. */
  async function getSavedRevision(): Promise<number> {
    return (await readConfigFile()).openai.savedRevision
  }

  /** Returns the decrypted OpenAI secrets payload or null when no key is stored. */
  async function readSecretsPayload(configFile: OpenAiConfigFile): Promise<OpenAiSecretsPayload | null> {
    if (configFile.secretStorageMode === 'plaintext') {
      const plaintextSecretsFile = await readPlaintextSecretsFile()
      return plaintextSecretsFile
        ? {
            openaiApiKey: plaintextSecretsFile.openaiApiKey,
          }
        : null
    }

    const encryptedSecretsFile = await readEncryptedSecretsFile()

    if (!encryptedSecretsFile) {
      return null
    }

    if (!unlockedPassphrase) {
      throw new OpenAiConfigStoreError('The encrypted OpenAI key store is locked.', 409)
    }

    return decryptSecretsPayload(encryptedSecretsFile, unlockedPassphrase)
  }

  /** Returns one renderer-safe summary combining disk state and runtime apply state. */
  async function getSummary(): Promise<OpenAiConfigSummary> {
    const configFile = await readConfigFile()
    const hasOpenAiKey = await hasStoredOpenAiKey(configFile)

    return {
      applyError,
      defaultModel: configFile.defaultModel,
      hasOpenAIKey: hasOpenAiKey,
      lastAppliedSavedRevision: appliedRevision,
      locked: await isEncryptedStoreLocked(configFile),
      needsApply: appliedRevision !== configFile.openai.savedRevision,
      runtimeAvailable,
      secretStorageMode: configFile.secretStorageMode,
    }
  }

  /** Returns the currently saved OpenAI credential for the next runtime apply operation. */
  async function getSavedCredentialForApply(): Promise<SavedOpenAiCredential> {
    const configFile = await readConfigFile()
    const secretsPayload = await readSecretsPayload(configFile)

    return {
      apiKey: secretsPayload?.openaiApiKey ?? null,
      savedRevision: configFile.openai.savedRevision,
    }
  }

  /** Marks the runtime state as ready for a fresh OpenCode instance. */
  async function markRuntimeStarted(): Promise<void> {
    const configFile = await readConfigFile()
    const hasOpenAiKey = await hasStoredOpenAiKey(configFile)

    runtimeAvailable = true
    applyError = ''
    appliedRevision = hasOpenAiKey ? null : configFile.openai.savedRevision
  }

  /** Marks the runtime state as unavailable because the OpenCode container stopped. */
  function markRuntimeStopped(): void {
    runtimeAvailable = false
    applyError = ''
    appliedRevision = null
  }

  /** Marks the latest saved credential revision as successfully applied to OpenCode. */
  async function setRuntimeApplySuccess(savedRevision: number): Promise<void> {
    const currentSavedRevision = await getSavedRevision()

    if (savedRevision !== currentSavedRevision) {
      return
    }

    applyError = ''
    appliedRevision = savedRevision
  }

  /** Records the latest runtime apply failure without mutating saved disk state. */
  async function applySavedCredentialToRuntimeResult(errorMessage: string): Promise<void> {
    applyError = errorMessage
  }

  /** Saves or updates the OpenAI key in the current storage mode. */
  async function saveOpenAiKey(request: SaveOpenAiConfigRequest): Promise<OpenAiConfigSummary> {
    const nextApiKey = request.apiKey.trim()

    if (nextApiKey.length === 0) {
      throw new OpenAiConfigStoreError('The OpenAI API key cannot be empty.', 400)
    }

    const configFile = await readConfigFile()
    const nextConfigFile: OpenAiConfigFile = {
      ...configFile,
      openai: {
        savedRevision: configFile.openai.savedRevision + 1,
      },
    }

    if (configFile.secretStorageMode === 'plaintext') {
      const plaintextSecretsFile: OpenAiPlaintextSecretsFile = {
        openaiApiKey: nextApiKey,
        version: 1,
      }

      await writeJsonFileAtomically(plaintextSecretsFilePath, plaintextSecretsFile)
      await writeConfigFile(nextConfigFile)
      return await getSummary()
    }

    if (!unlockedPassphrase) {
      throw new OpenAiConfigStoreError('Unlock the encrypted OpenAI key store before saving.', 409)
    }

    await writeJsonFileAtomically(
      encryptedSecretsFilePath,
      encryptSecretsPayload({ openaiApiKey: nextApiKey }, unlockedPassphrase),
    )
    await writeConfigFile(nextConfigFile)
    return await getSummary()
  }

  /** Removes the saved OpenAI key from disk while leaving runtime apply state unchanged. */
  async function clearOpenAiKey(): Promise<OpenAiConfigSummary> {
    const configFile = await readConfigFile()

    if (configFile.secretStorageMode === 'encrypted' && (await readEncryptedSecretsFile()) && !unlockedPassphrase) {
      throw new OpenAiConfigStoreError('Unlock the encrypted OpenAI key store before clearing it.', 409)
    }

    const nextConfigFile: OpenAiConfigFile = {
      ...configFile,
      openai: {
        savedRevision: configFile.openai.savedRevision + 1,
      },
    }

    if (configFile.secretStorageMode === 'plaintext') {
      await removeFileIfPresent(plaintextSecretsFilePath)
    } else {
      await removeFileIfPresent(encryptedSecretsFilePath)
    }

    await writeConfigFile(nextConfigFile)
    return await getSummary()
  }

  /** Unlocks the encrypted OpenAI key store for the current Bun process. */
  async function unlockEncryptedStore(passphrase: string): Promise<OpenAiConfigSummary> {
    const nextPassphrase = passphrase.trim()

    if (nextPassphrase.length === 0) {
      throw new OpenAiConfigStoreError('The unlock passphrase cannot be empty.', 400)
    }

    const configFile = await readConfigFile()

    if (configFile.secretStorageMode !== 'encrypted') {
      throw new OpenAiConfigStoreError('The OpenAI key store is not using encrypted mode.', 409)
    }

    const encryptedSecretsFile = await readEncryptedSecretsFile()

    if (!encryptedSecretsFile) {
      throw new OpenAiConfigStoreError('There is no encrypted OpenAI key store to unlock.', 409)
    }

    decryptSecretsPayload(encryptedSecretsFile, nextPassphrase)
    unlockedPassphrase = nextPassphrase
    return await getSummary()
  }

  /** Converts the local OpenAI secret storage between plaintext and encrypted modes. */
  async function convertSecretStorage(
    request: ConvertOpenAiConfigRequest,
  ): Promise<OpenAiConfigSummary> {
    const configFile = await readConfigFile()

    if (request.targetMode === configFile.secretStorageMode) {
      if (request.targetMode === 'encrypted' && (await readEncryptedSecretsFile()) === null) {
        const nextPassphrase = request.newPassphrase?.trim() ?? ''

        if (nextPassphrase.length === 0) {
          throw new OpenAiConfigStoreError(
            'Provide a passphrase before initializing encrypted mode.',
            400,
          )
        }

        unlockedPassphrase = nextPassphrase
      }

      return await getSummary()
    }

    if (request.targetMode === 'encrypted') {
      const nextPassphrase = request.newPassphrase?.trim() ?? ''

      if (nextPassphrase.length === 0) {
        throw new OpenAiConfigStoreError('Provide a passphrase before converting to encrypted mode.', 400)
      }

      const plaintextSecretsFile = await readPlaintextSecretsFile()

      if (plaintextSecretsFile) {
        await writeJsonFileAtomically(
          encryptedSecretsFilePath,
          encryptSecretsPayload({ openaiApiKey: plaintextSecretsFile.openaiApiKey }, nextPassphrase),
        )
      }

      await writeConfigFile({
        ...configFile,
        secretStorageMode: 'encrypted',
      })
      await removeFileIfPresent(plaintextSecretsFilePath)
      unlockedPassphrase = nextPassphrase
      return await getSummary()
    }

    const encryptedSecretsFile = await readEncryptedSecretsFile()
    const effectivePassphrase = unlockedPassphrase ?? request.currentPassphrase?.trim() ?? ''

    if (encryptedSecretsFile && effectivePassphrase.length === 0) {
      throw new OpenAiConfigStoreError(
        'Unlock the encrypted OpenAI key store before converting to plaintext mode.',
        409,
      )
    }

    if (encryptedSecretsFile && effectivePassphrase.length > 0) {
      const decryptedSecretsPayload = decryptSecretsPayload(encryptedSecretsFile, effectivePassphrase)

      await writeJsonFileAtomically(plaintextSecretsFilePath, {
        openaiApiKey: decryptedSecretsPayload.openaiApiKey,
        version: 1,
      } satisfies OpenAiPlaintextSecretsFile)
    }

    await writeConfigFile({
      ...configFile,
      secretStorageMode: 'plaintext',
    })
    await removeFileIfPresent(encryptedSecretsFilePath)
    unlockedPassphrase = null
    return await getSummary()
  }

  return {
    applySavedCredentialToRuntimeResult,
    clearOpenAiKey,
    convertSecretStorage,
    getSavedCredentialForApply,
    getSummary,
    markRuntimeStarted,
    markRuntimeStopped,
    saveOpenAiKey,
    setRuntimeApplySuccess,
    unlockEncryptedStore,
  }
}
