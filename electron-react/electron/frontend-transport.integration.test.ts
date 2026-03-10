import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'bun:test'
import electronBinaryPath from 'electron'

import { createStaticAgentRuntime } from '../../server/src/agent/fake-agent-runtime'
import type {
  SessionContainerManager,
  SessionContainerSnapshot,
} from '../../server/src/container/session-container'
import { startServer, type ServerHandle } from '../../server/src/lib'
import { createOpenAiConfigStore } from '../../server/src/runtime-config/openai-config-store'
import type { OpenAiConfigSummary } from '../src/lib/types/openai-config'

const electronIntegrationTimeoutMs = 20_000
const electronProjectRoot = path.resolve(import.meta.dir, '..')
const electronRunnerEntryPath = path.join(electronProjectRoot, 'electron-dist', 'integration-runner.js')

/** Represents one serialized result returned by the dedicated Electron integration runner. */
interface ElectronIntegrationRunnerResult {
  error?: string
  ok: boolean
  value?: unknown
}

/** Returns an available TCP port for a temporary Bun integration server. */
async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()

    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()

      if (!address || typeof address === 'string') {
        rejectPort(new Error('The Electron integration test could not reserve a TCP port.'))
        return
      }

      server.close((error) => {
        if (error) {
          rejectPort(error)
          return
        }

        resolvePort(address.port)
      })
    })
  })
}

/** Returns one ready session-container snapshot suitable for frontend transport tests. */
function createTestSessionContainerSnapshot(
  overrides: Partial<SessionContainerSnapshot> = {},
): SessionContainerSnapshot {
  return {
    baseUrl: 'http://127.0.0.1:4096',
    containerId: 'frontend-test-container-id',
    containerImage: 'frontend-test-image:latest',
    containerName: 'frontend-test-container',
    error: '',
    openCodeError: '',
    openCodeStatus: 'ready',
    openCodeVersion: '1.2.22',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'ready',
    ...overrides,
  }
}

/** Returns one fake session-container manager so Electron transport tests stay Docker-free. */
function createTestSessionContainerManager(
  overrides: Partial<SessionContainerSnapshot> = {},
): SessionContainerManager {
  let snapshot = createTestSessionContainerSnapshot(overrides)

  return {
    getSnapshot(): SessionContainerSnapshot {
      return { ...snapshot }
    },
    async start(): Promise<void> {
      snapshot = {
        ...snapshot,
        status: 'ready',
      }
    },
    async stop(): Promise<void> {
      snapshot = {
        ...snapshot,
        baseUrl: null,
        containerId: null,
        containerName: null,
        error: '',
        openCodeError: '',
        openCodeStatus: 'stopped',
        openCodeVersion: null,
        startedAt: null,
        status: 'stopped',
      }
    },
  }
}

/** Returns one fresh temporary config directory for the Bun runtime-config store. */
async function createTemporaryConfigDirectory(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'vide-electron-transport-'))
}

/** Returns whether the provided file path exists on disk. */
async function doesFileExist(filePath: string): Promise<boolean> {
  return existsSync(filePath)
}

let electronBuildPromise: Promise<void> | null = null

/** Builds the Electron main, preload, and integration-runner bundles once per test process. */
async function ensureElectronArtifactsBuilt(): Promise<void> {
  if (electronBuildPromise) {
    await electronBuildPromise
    return
  }

  electronBuildPromise = (async () => {
    await new Promise<void>((resolveBuild, rejectBuild) => {
      const child = spawn('bun', ['run', 'build:electron'], {
        cwd: electronProjectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''

      child.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        output += String(chunk)
      })
      child.once('exit', (code) => {
        if (code === 0) {
          resolveBuild()
          return
        }

        rejectBuild(
          new Error(
            `Electron integration artifacts failed to build.${output.length > 0 ? `\n${output}` : ''}`,
          ),
        )
      })
      child.once('error', rejectBuild)
    })
  })()

  await electronBuildPromise
}

/** Returns one self-invoking renderer script that resolves the provided expression result. */
function createRendererEvaluationScript(expression: string): string {
  return `(async () => (${expression}))()`
}

/** Launches Electron, runs one renderer script through preload and IPC, and returns its result. */
async function runRendererScriptThroughElectron(options: {
  backendBaseUrl: string
  rendererScript: string
}): Promise<ElectronIntegrationRunnerResult> {
  await ensureElectronArtifactsBuilt()

  const resultDirectory = await mkdtemp(path.join(tmpdir(), 'vide-electron-runner-'))
  const resultPath = path.join(resultDirectory, 'result.json')

  try {
    const result = await new Promise<ElectronIntegrationRunnerResult>((resolveResult, rejectResult) => {
      const child: ChildProcessWithoutNullStreams = spawn(String(electronBinaryPath), [electronRunnerEntryPath], {
        cwd: electronProjectRoot,
        env: {
          ...process.env,
          VIDE_SKIP_MAIN_AUTORUN: 'true',
          VIDE_TEST_BACKEND_BASE_URL: options.backendBaseUrl,
          VIDE_TEST_RENDERER_SCRIPT: options.rendererScript,
          VIDE_TEST_RESULT_FILE: resultPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const timeoutId = setTimeout(() => {
        child.kill('SIGKILL')
        rejectResult(new Error('The Electron integration runner timed out.'))
      }, electronIntegrationTimeoutMs)

      child.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        output += String(chunk)
      })
      child.once('error', (error) => {
        clearTimeout(timeoutId)
        rejectResult(error)
      })
      child.once('exit', async (code) => {
        clearTimeout(timeoutId)

        try {
          const resultFile = JSON.parse(
            await readFile(resultPath, 'utf8'),
          ) as ElectronIntegrationRunnerResult

          if (code !== 0 && !resultFile.ok && output.length > 0) {
            resultFile.error = `${resultFile.error ?? 'Electron integration runner failed.'}\n${output}`
          }

          resolveResult(resultFile)
        } catch (error) {
          rejectResult(
            new Error(
              error instanceof Error
                ? error.message
                : `The Electron integration runner exited without a readable result.${output.length > 0 ? `\n${output}` : ''}`,
            ),
          )
        }
      })
    })

    return result
  } finally {
    await rm(resultDirectory, { force: true, recursive: true })
  }
}

/** Starts one real Bun server for Electron transport tests using a temporary config directory. */
async function startFrontendTransportTestServer(): Promise<{
  configDirectory: string
  handle: ServerHandle
  port: number
}> {
  const configDirectory = await createTemporaryConfigDirectory()
  const port = await getAvailablePort()
  const handle = startServer({
    agentRuntime: createStaticAgentRuntime({
      assistantText: 'Frontend transport integration test assistant reply.',
    }),
    openAiConfigStore: createOpenAiConfigStore({
      configDirectory,
      defaultModel: 'openai/gpt-5',
      defaultSecretStorageMode: 'plaintext',
    }),
    port,
    sessionContainerManager: createTestSessionContainerManager(),
  })

  return {
    configDirectory,
    handle,
    port,
  }
}

/** Returns the typed renderer summary result or throws when the runner reported failure. */
function getSuccessfulRunnerValue<T>(result: ElectronIntegrationRunnerResult): T {
  if (!result.ok) {
    throw new Error(result.error ?? 'The Electron integration runner reported a failure.')
  }

  return result.value as T
}

/** Verifies renderer-triggered save persists the OpenAI key through Electron transport. */
test(
  'renderer saveOpenAiConfig persists plaintext disk state through Electron transport',
  { timeout: electronIntegrationTimeoutMs },
  async () => {
    const { configDirectory, handle, port } = await startFrontendTransportTestServer()

    try {
      const result = await runRendererScriptThroughElectron({
        backendBaseUrl: `http://127.0.0.1:${port}`,
        rendererScript: createRendererEvaluationScript(
          `window.videApi.saveOpenAiConfig({ apiKey: "sk-electron-save" })`,
        ),
      })
      const summary = getSuccessfulRunnerValue<OpenAiConfigSummary>(result)
      const configFile = JSON.parse(
        await readFile(path.join(configDirectory, 'config.json'), 'utf8'),
      ) as { openai: { savedRevision: number }; secretStorageMode: string }
      const secretsFile = JSON.parse(
        await readFile(path.join(configDirectory, 'secrets.json'), 'utf8'),
      ) as { openaiApiKey?: string }

      expect(summary.hasOpenAIKey).toBe(true)
      expect(summary.needsApply).toBe(true)
      expect(configFile.secretStorageMode).toBe('plaintext')
      expect(configFile.openai.savedRevision).toBe(1)
      expect(secretsFile.openaiApiKey).toBe('sk-electron-save')
    } finally {
      await handle.stop()
      await rm(configDirectory, { force: true, recursive: true })
    }
  },
)

/** Verifies renderer-triggered convert uses POST bodies and flips encrypted/plaintext disk state. */
test(
  'renderer convertOpenAiConfig flips encrypted and plaintext files through Electron transport',
  { timeout: electronIntegrationTimeoutMs },
  async () => {
    const { configDirectory, handle, port } = await startFrontendTransportTestServer()
    const plaintextSecretsPath = path.join(configDirectory, 'secrets.json')
    const encryptedSecretsPath = path.join(configDirectory, 'secrets.enc')

    try {
      const encryptedResult = await runRendererScriptThroughElectron({
        backendBaseUrl: `http://127.0.0.1:${port}`,
        rendererScript: createRendererEvaluationScript(`(async () => {
          await window.videApi.saveOpenAiConfig({ apiKey: "sk-electron-convert" })
          return await window.videApi.convertOpenAiConfig({
            newPassphrase: "transport-passphrase",
            targetMode: "encrypted",
          })
        })()`),
      })
      const encryptedSummary = getSuccessfulRunnerValue<OpenAiConfigSummary>(encryptedResult)
      const encryptedConfigFile = JSON.parse(
        await readFile(path.join(configDirectory, 'config.json'), 'utf8'),
      ) as { secretStorageMode: string }

      expect(encryptedSummary.secretStorageMode).toBe('encrypted')
      expect(encryptedConfigFile.secretStorageMode).toBe('encrypted')
      expect(await doesFileExist(plaintextSecretsPath)).toBe(false)
      expect(await doesFileExist(encryptedSecretsPath)).toBe(true)

      const plaintextResult = await runRendererScriptThroughElectron({
        backendBaseUrl: `http://127.0.0.1:${port}`,
        rendererScript: createRendererEvaluationScript(`window.videApi.convertOpenAiConfig({
          currentPassphrase: "transport-passphrase",
          targetMode: "plaintext",
        })`),
      })
      const plaintextSummary = getSuccessfulRunnerValue<OpenAiConfigSummary>(plaintextResult)
      const plaintextConfigFile = JSON.parse(
        await readFile(path.join(configDirectory, 'config.json'), 'utf8'),
      ) as { secretStorageMode: string }
      const plaintextSecretsFile = JSON.parse(
        await readFile(plaintextSecretsPath, 'utf8'),
      ) as { openaiApiKey?: string }

      expect(plaintextSummary.secretStorageMode).toBe('plaintext')
      expect(plaintextConfigFile.secretStorageMode).toBe('plaintext')
      expect(plaintextSecretsFile.openaiApiKey).toBe('sk-electron-convert')
      expect(await doesFileExist(encryptedSecretsPath)).toBe(false)
    } finally {
      await handle.stop()
      await rm(configDirectory, { force: true, recursive: true })
    }
  },
)

/** Verifies backend validation errors reject the renderer promise across preload and IPC. */
test(
  'renderer saveOpenAiConfig surfaces backend validation errors through Electron transport',
  { timeout: electronIntegrationTimeoutMs },
  async () => {
    const { configDirectory, handle, port } = await startFrontendTransportTestServer()

    try {
      const result = await runRendererScriptThroughElectron({
        backendBaseUrl: `http://127.0.0.1:${port}`,
        rendererScript: createRendererEvaluationScript(
          `window.videApi.saveOpenAiConfig({ apiKey: "   " })`,
        ),
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('The OpenAI API key cannot be empty.')
    } finally {
      await handle.stop()
      await rm(configDirectory, { force: true, recursive: true })
    }
  },
)
