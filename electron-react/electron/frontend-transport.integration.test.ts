import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'bun:test'
import electronBinaryPath from 'electron'

import {
  createStaticAgentRuntime,
  createStreamingAgentRuntime,
} from '../../server/src/agent/fake-agent-runtime'
import type { AgentRuntime } from '../../server/src/agent/agent-runtime'
import { createWorkspaceSessionContainerManager } from '../../server/src/container/workspace-session-container'
import type {
  SessionContainerManager,
  SessionContainerSnapshot,
} from '../../server/src/container/session-container'
import { startServer, type ServerHandle } from '../../server/src/lib'
import { createOpenAiConfigStore } from '../../server/src/runtime-config/openai-config-store'
import { createWorkspaceStore } from '../../server/src/workspace/workspace-store'
import type { OpenAiConfigSummary } from '../src/lib/types/openai-config'
import type { WorkspaceRegistrySnapshot } from '../src/lib/types/workspace'

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
      const child = spawn('bun', ['run', 'build'], {
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
  rendererUrl?: string
  useRealRenderer?: boolean
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
          VIDE_TEST_RENDERER_URL: options.rendererUrl ?? '',
          VIDE_TEST_USE_REAL_RENDERER: options.useRealRenderer === true ? 'true' : 'false',
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
  return await startFrontendTransportServerWithRuntime(
    createStaticAgentRuntime({
      assistantText: 'Frontend transport integration test assistant reply.',
    }),
  )
}

/** Starts one real Bun server for Electron transport tests with the provided agent runtime. */
async function startFrontendTransportServerWithRuntime(
  agentRuntime: AgentRuntime,
): Promise<{
  configDirectory: string
  handle: ServerHandle
  port: number
}> {
  const configDirectory = await createTemporaryConfigDirectory()
  const workspaceDirectory = path.join(configDirectory, 'default-workspace')
  const port = await getAvailablePort()
  const workspaceStore = createWorkspaceStore(configDirectory)

  await mkdir(workspaceDirectory, { recursive: true })
  await workspaceStore.createWorkspace({
    hostPath: workspaceDirectory,
  })
  const handle = startServer({
    agentRuntime,
    openAiConfigStore: createOpenAiConfigStore({
      configDirectory,
      defaultModel: 'openai/gpt-5',
      defaultSecretStorageMode: 'plaintext',
    }),
    port,
    sessionContainerManager: createTestSessionContainerManager(),
    workspaceStore,
  })

  return {
    configDirectory,
    handle,
    port,
  }
}

/** Starts one Bun server for Electron workspace transport tests using a temporary config directory. */
async function startFrontendWorkspaceTransportServer(): Promise<{
  configDirectory: string
  handle: ServerHandle
  port: number
}> {
  const configDirectory = await createTemporaryConfigDirectory()
  const port = await getAvailablePort()
  const handle = startServer({
    agentRuntime: createStaticAgentRuntime({
      assistantText: 'Frontend workspace transport integration test assistant reply.',
    }),
    openAiConfigStore: createOpenAiConfigStore({
      configDirectory,
      defaultModel: 'openai/gpt-5',
      defaultSecretStorageMode: 'plaintext',
    }),
    port,
    sessionContainerManager: createWorkspaceSessionContainerManager({
      managerFactory: () => createTestSessionContainerManager(),
    }),
    workspaceStore: createWorkspaceStore(configDirectory),
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

/** Returns the content type served for one static Electron renderer asset path. */
function getStaticContentType(filePath: string): string {
  if (filePath.endsWith('.css')) {
    return 'text/css; charset=utf-8'
  }

  if (filePath.endsWith('.js')) {
    return 'text/javascript; charset=utf-8'
  }

  return 'text/html; charset=utf-8'
}

/** Starts one static HTTP server that serves the built Electron renderer dist directory. */
async function startRendererStaticServer(): Promise<{ server: HttpServer; url: string }> {
  await ensureElectronArtifactsBuilt()
  const port = await getAvailablePort()
  const distDirectory = path.join(electronProjectRoot, 'dist')
  const server = createHttpServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    const relativePath =
      requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname.replace(/^\//, '')
    const filePath = path.join(distDirectory, relativePath)

    try {
      const fileContents = await readFile(filePath)

      response.writeHead(200, {
        'Content-Type': getStaticContentType(filePath),
      })
      response.end(fileContents)
    } catch {
      response.writeHead(404)
      response.end('Not found.')
    }
  })

  await new Promise<void>((resolveServer, rejectServer) => {
    server.once('error', rejectServer)
    server.listen(port, '127.0.0.1', () => {
      resolveServer()
    })
  })

  return {
    server,
    url: `http://127.0.0.1:${port}`,
  }
}

/** Returns one renderer script that exercises the real conversation UI and captures streamed text. */
function createConversationStreamingRendererScript(): string {
  return createRendererEvaluationScript(`(async () => {
    const waitFor = async (factory, label, timeoutMs = 15000) => {
      const startedAt = Date.now()

      while (Date.now() - startedAt < timeoutMs) {
        const value = factory()

        if (value) {
          return value
        }

        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      throw new Error('Timed out while waiting for: ' + label)
    }
    const getMessageTexts = () =>
      Array.from(document.querySelectorAll('article p.whitespace-pre-wrap')).map((node) => node.textContent ?? '')
    const finalAssistantText = 'Hello there from the streaming backend.'

    const textarea = await waitFor(
      () => document.querySelector('#conversation-pane-composer'),
      'conversation composer textarea',
    )

    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error('The conversation composer textarea was not available.')
    }

    const textareaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set

    if (!textareaValueSetter) {
      throw new Error('The conversation composer value setter was not available.')
    }

    textareaValueSetter.call(textarea, 'Please stream a long reply.')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))

    const sendButton = await waitFor(() =>
      Array.from(document.querySelectorAll('button')).find((button) => {
        return button instanceof HTMLButtonElement && button.textContent?.trim() === 'Send' && !button.disabled
      }),
      'enabled conversation send button',
    )

    if (!(sendButton instanceof HTMLButtonElement)) {
      throw new Error('The conversation send button was not available.')
    }

    sendButton.click()

    const observedAssistantTexts = []
    const startedAt = Date.now()
    let finalTexts = null

    while (Date.now() - startedAt < 15000) {
      const texts = getMessageTexts()
      const assistantText = texts.find((text) => text !== 'Please stream a long reply.')

      if (assistantText && observedAssistantTexts.at(-1) !== assistantText) {
        observedAssistantTexts.push(assistantText)
      }

      if (texts.includes(finalAssistantText)) {
        finalTexts = texts
        break
      }

      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    if (!finalTexts) {
      throw new Error(
        'Timed out while waiting for the final streamed assistant reply. Observed snapshots: ' +
          JSON.stringify(observedAssistantTexts),
      )
    }

    return {
      finalTexts,
      observedAssistantTexts,
    }
  })()`)
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

/** Verifies the real conversation UI shows streamed assistant text before completion. */
test(
  'renderer conversation UI streams assistant text progressively',
  { timeout: electronIntegrationTimeoutMs },
  async () => {
    const { configDirectory, handle, port } = await startFrontendTransportServerWithRuntime(
      createStreamingAgentRuntime({
        assistantTextSnapshots: ['Hello', 'Hello there'],
        delayMs: 750,
        finalAssistantText: 'Hello there from the streaming backend.',
      }),
    )
    const rendererServer = await startRendererStaticServer()

    try {
      const result = await runRendererScriptThroughElectron({
        backendBaseUrl: `http://127.0.0.1:${port}`,
        rendererScript: createConversationStreamingRendererScript(),
        rendererUrl: rendererServer.url,
        useRealRenderer: true,
      })
      const value = getSuccessfulRunnerValue<{
        finalTexts: string[]
        observedAssistantTexts: string[]
      }>(result)

      expect(value.finalTexts).toContain('Please stream a long reply.')
      expect(value.finalTexts).toContain('Hello there from the streaming backend.')
      expect(value.finalTexts.length).toBe(2)
      expect(value.observedAssistantTexts.length).toBeGreaterThan(1)
      expect(value.observedAssistantTexts.at(-1)).toBe('Hello there from the streaming backend.')
    } finally {
      await new Promise<void>((resolveServer) => {
        rendererServer.server.close(() => {
          resolveServer()
        })
      })
      await handle.stop()
      await rm(configDirectory, { force: true, recursive: true })
    }
  },
)

/** Verifies workspace create, save, and load calls cross preload and IPC correctly. */
test(
  'renderer workspace APIs create save and load workspaces through Electron transport',
  { timeout: electronIntegrationTimeoutMs },
  async () => {
    const { configDirectory, handle, port } = await startFrontendWorkspaceTransportServer()
    const firstWorkspaceDirectory = path.join(configDirectory, 'workspace-one')
    const secondWorkspaceDirectory = path.join(configDirectory, 'workspace-two')

    try {
      await mkdir(firstWorkspaceDirectory, { recursive: true })
      await mkdir(secondWorkspaceDirectory, { recursive: true })

      const result = await runRendererScriptThroughElectron({
        backendBaseUrl: `http://127.0.0.1:${port}`,
        rendererScript: createRendererEvaluationScript(`(async () => {
          const firstSnapshot = await window.videApi.createWorkspace({
            hostPath: ${JSON.stringify(firstWorkspaceDirectory)},
          })
          const savedSnapshot = await window.videApi.saveWorkspace({
            name: "Workspace One Renamed",
          })
          const secondSnapshot = await window.videApi.createWorkspace({
            hostPath: ${JSON.stringify(secondWorkspaceDirectory)},
          })
          const reloadedSnapshot = await window.videApi.loadWorkspace({
            workspaceId: firstSnapshot.activeWorkspace.id,
          })

          return {
            firstSnapshot,
            reloadedSnapshot,
            savedSnapshot,
            secondSnapshot,
          }
        })()`),
      })
      const value = getSuccessfulRunnerValue<{
        firstSnapshot: WorkspaceRegistrySnapshot
        reloadedSnapshot: WorkspaceRegistrySnapshot
        savedSnapshot: WorkspaceRegistrySnapshot
        secondSnapshot: WorkspaceRegistrySnapshot
      }>(result)

      expect(value.firstSnapshot.activeWorkspace?.hostPath).toBe(firstWorkspaceDirectory)
      expect(value.savedSnapshot.activeWorkspace?.name).toBe('Workspace One Renamed')
      expect(value.secondSnapshot.activeWorkspace?.hostPath).toBe(secondWorkspaceDirectory)
      expect(value.reloadedSnapshot.activeWorkspace?.name).toBe('Workspace One Renamed')
      expect(value.reloadedSnapshot.activeWorkspace?.hostPath).toBe(firstWorkspaceDirectory)
    } finally {
      await handle.stop()
      await rm(configDirectory, { force: true, recursive: true })
    }
  },
)
