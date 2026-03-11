import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { createOpencodeClient } from '@opencode-ai/sdk'
import { expect, test } from 'bun:test'

import { createStaticAgentRuntime } from './agent/fake-agent-runtime'
import { createDockerSessionContainerManager } from './container/session-container'
import { createWorkspaceSessionContainerManager } from './container/workspace-session-container'
import { startServer, type ServerHandle, type ServerHealthPayload } from './lib'
import {
  createOpenAiConfigStore,
  type OpenAiConfigStore,
} from './runtime-config/openai-config-store'
import type {
  OpenAiConfigSummary,
  SecretStorageMode,
} from './runtime-config/openai-config-types'
import type { SessionErrorMessage } from './session/session-types'
import { createWorkspaceStore } from './workspace/workspace-store'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const runtimeDockerDirectory = resolve(sourceDirectory, '..', 'docker', 'opencode-runtime')
const runtimeDockerfilePath = resolve(runtimeDockerDirectory, 'Dockerfile')
const dockerTestImage = 'vide-opencode-runtime:test'
const integrationTestTimeoutMs = 180_000
let runtimeImageBuildPromise: Promise<void> | null = null

/** Returns an available TCP port for one temporary integration test server. */
async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()

    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()

      if (!address || typeof address === 'string') {
        rejectPort(new Error('The integration test could not reserve a TCP port.'))
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

/** Represents one collected process result used by Docker integration helpers. */
interface ProcessResult {
  exitCode: number | null
  stderr: string
  stdout: string
}

/** Represents the OpenCode health payload returned by the runtime-only image. */
interface OpenCodeHealthPayload {
  healthy?: boolean
  version?: string
}

/** Represents the persisted config metadata written by the runtime-config integration tests. */
interface PersistedOpenAiConfigFile {
  defaultModel: string
  openai: {
    savedRevision: number
  }
  secretStorageMode: SecretStorageMode
  version: 1
}

/** Represents one Docker mount entry returned by container inspection. */
interface DockerMount {
  Destination?: string
  Source?: string
  Type?: string
}

/** Runs one process and collects its complete stdout and stderr output. */
function runCommand(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('close', (exitCode) => {
      resolve({
        exitCode,
        stderr: stderr.trim(),
        stdout: stdout.trim(),
      })
    })
  })
}

/** Returns whether the current machine can run Docker-backed integration tests. */
async function canUseDocker(): Promise<boolean> {
  const result = await runCommand('docker', ['version', '--format', '{{.Server.Version}}'])
  return result.exitCode === 0 && result.stdout.length > 0
}

/** Ensures the repo-owned OpenCode runtime image is built before server startup tests run. */
async function ensureRuntimeImageBuilt(): Promise<void> {
  if (runtimeImageBuildPromise) {
    await runtimeImageBuildPromise
    return
  }

  runtimeImageBuildPromise = (async () => {
    const result = await runCommand('docker', [
      'build',
      '-t',
      dockerTestImage,
      '-f',
      runtimeDockerfilePath,
      runtimeDockerDirectory,
    ])

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || 'The OpenCode runtime image build failed.')
    }
  })()

  await runtimeImageBuildPromise
}

/** Returns the OpenCode runtime health payload served by the active container. */
async function getOpenCodeHealth(baseUrl: string): Promise<OpenCodeHealthPayload> {
  const response = await fetch(`${baseUrl}/global/health`)

  if (!response.ok) {
    throw new Error(`The OpenCode health endpoint returned ${response.status}.`)
  }

  return (await response.json()) as OpenCodeHealthPayload
}

/** Returns whether the provided file path currently exists on disk. */
async function doesFileExist(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

/** Returns one new temporary config directory reserved for a single integration test. */
async function createTemporaryConfigDirectory(): Promise<string> {
  return await mkdtemp(resolve(tmpdir(), 'vide-openai-config-test-'))
}

/** Returns one connected-provider list from the running OpenCode container. */
async function getConnectedProviderIds(baseUrl: string): Promise<string[]> {
  const client = createOpencodeClient({
    baseUrl,
    responseStyle: 'data',
    throwOnError: true,
  })
  const providerList = await client.provider.list()

  return providerList.connected
}

/** Waits until the running OpenCode container reports one connected provider identifier. */
async function waitForConnectedProvider(baseUrl: string, providerId: string): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 10_000) {
    if ((await getConnectedProviderIds(baseUrl)).includes(providerId)) {
      return
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250)
    })
  }

  throw new Error(`The integration test never observed the "${providerId}" provider connection.`)
}

/** Returns one runtime-config API response or throws when the request fails. */
async function fetchRuntimeConfig<T>(
  port: number,
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

  if (!response.ok) {
    const body = (await response.json()) as { message?: unknown }
    const message =
      typeof body.message === 'string'
        ? body.message
        : `The runtime-config request failed with status ${response.status}.`

    throw new Error(message)
  }

  return (await response.json()) as T
}

/** Saves one fake OpenAI API key through the Bun runtime-config HTTP API. */
async function saveOpenAiKey(port: number, apiKey: string): Promise<OpenAiConfigSummary> {
  return await fetchRuntimeConfig<OpenAiConfigSummary>(port, '/runtime-config/openai', {
    body: JSON.stringify({ apiKey }),
    method: 'PUT',
  })
}

/** Applies the latest saved OpenAI API key to the running OpenCode runtime. */
async function applyOpenAiKey(port: number): Promise<OpenAiConfigSummary> {
  return await fetchRuntimeConfig<OpenAiConfigSummary>(port, '/runtime-config/openai/apply', {
    method: 'POST',
  })
}

/** Converts the current OpenAI key store to encrypted storage with the provided passphrase. */
async function convertToEncrypted(
  port: number,
  passphrase: string,
): Promise<OpenAiConfigSummary> {
  return await fetchRuntimeConfig<OpenAiConfigSummary>(port, '/runtime-config/openai/convert', {
    body: JSON.stringify({
      newPassphrase: passphrase,
      targetMode: 'encrypted',
    }),
    method: 'POST',
  })
}

/** Converts the current OpenAI key store back to plaintext storage. */
async function convertToPlaintext(
  port: number,
  currentPassphrase?: string,
): Promise<OpenAiConfigSummary> {
  return await fetchRuntimeConfig<OpenAiConfigSummary>(port, '/runtime-config/openai/convert', {
    body: JSON.stringify({
      currentPassphrase,
      targetMode: 'plaintext',
    }),
    method: 'POST',
  })
}

/** Opens one WebSocket connection to the provided integration test server URL. */
async function openWebSocket(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url)

    socket.addEventListener(
      'open',
      () => {
        resolveSocket(socket)
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        rejectSocket(new Error('The integration test WebSocket connection failed to open.'))
      },
      { once: true },
    )
  })
}

/** Waits for the next text message emitted by the integration test WebSocket. */
async function waitForSocketMessage(socket: WebSocket): Promise<string> {
  return await new Promise<string>((resolveMessage, rejectMessage) => {
    const handleMessage = (event: MessageEvent) => {
      cleanup()
      resolveMessage(String(event.data))
    }
    const handleError = () => {
      cleanup()
      rejectMessage(new Error('The integration test WebSocket failed before a message arrived.'))
    }
    const handleClose = () => {
      cleanup()
      rejectMessage(new Error('The integration test WebSocket closed before a message arrived.'))
    }
    const cleanup = () => {
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('error', handleError)
      socket.removeEventListener('close', handleClose)
    }

    socket.addEventListener('message', handleMessage, { once: true })
    socket.addEventListener('error', handleError, { once: true })
    socket.addEventListener('close', handleClose, { once: true })
  })
}

/** Waits until the integration test socket emits one session_error payload. */
async function waitForSessionErrorMessage(socket: WebSocket): Promise<SessionErrorMessage> {
  while (true) {
    const rawMessage = await waitForSocketMessage(socket)
    const message = JSON.parse(rawMessage) as { type?: string }

    if (message.type === 'session_error') {
      return message as SessionErrorMessage
    }
  }
}

/** Waits until the backend health endpoint reports a ready or failed container. */
async function waitForContainerHealth(port: number): Promise<ServerHealthPayload> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 20_000) {
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    const body = (await response.json()) as ServerHealthPayload

    if (body.runtimeStatus === 'ready' || body.runtimeStatus === 'error') {
      return body
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250)
    })
  }

  throw new Error('The integration test backend never reported a terminal runtime state.')
}

/** Returns whether the provided Docker container identifier still exists. */
async function doesContainerExist(containerId: string): Promise<boolean> {
  const result = await runCommand('docker', ['container', 'inspect', containerId])
  return result.exitCode === 0
}

/** Returns the current Docker mount list for the provided container identifier. */
async function getContainerMounts(containerId: string): Promise<DockerMount[]> {
  const result = await runCommand('docker', [
    'container',
    'inspect',
    '--format',
    '{{json .Mounts}}',
    containerId,
  ])

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'The Docker mount inspection failed.')
  }

  return JSON.parse(result.stdout) as DockerMount[]
}

/** Starts one integration server using the default OpenCode SDK client adapter path. */
async function startMessageFlowIntegrationServer(): Promise<{
  configDirectory: string
  handle: ServerHandle
  port: number
}> {
  await ensureRuntimeImageBuilt()
  const configDirectory = await createTemporaryConfigDirectory()
  const port = await getAvailablePort()
  const handle = startServer({
    agentRuntimeMode: 'opencode',
    openAiConfigStore: createOpenAiConfigStore({
      configDirectory,
      defaultModel: 'openai/gpt-5',
      defaultSecretStorageMode: 'plaintext',
    }),
    port,
    sessionContainerManager: createDockerSessionContainerManager({
      autoBuildImage: false,
      buildContext: runtimeDockerDirectory,
      dockerfilePath: runtimeDockerfilePath,
      image: dockerTestImage,
      mountWorkspace: false,
    }),
  })

  return { configDirectory, handle, port }
}

/** Represents the options accepted by the Docker-backed integration server helper. */
interface IntegrationServerOptions {
  configDirectory?: string
  defaultSecretStorageMode?: SecretStorageMode
}

/** Creates one Bun-owned local OpenAI config store for Docker integration tests. */
function createIntegrationConfigStore(
  configDirectory: string,
  defaultSecretStorageMode: SecretStorageMode,
): OpenAiConfigStore {
  return createOpenAiConfigStore({
    configDirectory,
    defaultModel: 'openai/gpt-5',
    defaultSecretStorageMode,
  })
}

/** Creates one real Docker-backed Bun server for container lifecycle integration tests. */
async function startIntegrationServer(
  options: IntegrationServerOptions = {},
): Promise<{ configDirectory: string; handle: ServerHandle; port: number }> {
  await ensureRuntimeImageBuilt()
  const configDirectory = options.configDirectory ?? (await createTemporaryConfigDirectory())
  const port = await getAvailablePort()
  const handle = startServer({
    agentRuntime: createStaticAgentRuntime({
      assistantText: 'Fake OpenCode assistant reply.',
    }),
    openAiConfigStore: createIntegrationConfigStore(
      configDirectory,
      options.defaultSecretStorageMode ?? 'plaintext',
    ),
    port,
    sessionContainerManager: createDockerSessionContainerManager({
      autoBuildImage: false,
      buildContext: runtimeDockerDirectory,
      dockerfilePath: runtimeDockerfilePath,
      image: dockerTestImage,
      mountWorkspace: false,
    }),
  })

  return { configDirectory, handle, port }
}

/** Starts one workspace-aware Docker-backed Bun server for bind-mount integration tests. */
async function startWorkspaceIntegrationServer(workspaceDirectory: string): Promise<{
  configDirectory: string
  handle: ServerHandle
  port: number
}> {
  await ensureRuntimeImageBuilt()
  const configDirectory = await createTemporaryConfigDirectory()
  const port = await getAvailablePort()
  const workspaceStore = createWorkspaceStore(configDirectory)

  await workspaceStore.createWorkspace({
    executionMode: 'docker',
    hostPath: workspaceDirectory,
  })

  const handle = startServer({
    agentRuntime: createStaticAgentRuntime({
      assistantText: 'Fake OpenCode assistant reply.',
    }),
    openAiConfigStore: createIntegrationConfigStore(configDirectory, 'plaintext'),
    port,
    sessionContainerManager: createWorkspaceSessionContainerManager({
      autoBuildImage: false,
      buildContext: runtimeDockerDirectory,
      dockerfilePath: runtimeDockerfilePath,
      image: dockerTestImage,
    }),
    workspaceStore,
  })

  return { configDirectory, handle, port }
}

/** Verifies backend startup creates the repo-owned OpenCode container and shutdown removes it. */
test(
  'server creates and removes the repo-owned OpenCode runtime container',
  { timeout: integrationTestTimeoutMs },
  async () => {
  if (!(await canUseDocker())) {
    console.warn('Skipping Docker integration test because Docker is unavailable.')
    return
  }

  const { configDirectory, handle, port } = await startIntegrationServer()

  try {
    const body = await waitForContainerHealth(port)

    expect(body.runtimeStatus).toBe('ready')
    expect(body.executionMode).toBe('docker')
    expect(body.dockerContainer?.id).toBeTruthy()
    expect(body.dockerContainer?.image).toBe(dockerTestImage)
    expect(body.dockerContainer?.name).toContain('vide-session-')
    expect(body.runtimeBaseUrl).toBeTruthy()
    expect(body.openCodeStatus).toBe('ready')

    const containerId = body.dockerContainer?.id ?? null
    const containerBaseUrl = body.runtimeBaseUrl

    if (!containerId || !containerBaseUrl) {
      throw new Error('The health endpoint did not return container runtime details.')
    }

    const openCodeHealth = await getOpenCodeHealth(containerBaseUrl)
    const openCodeVersion = openCodeHealth.version

    expect(openCodeHealth.healthy).toBe(true)
    expect(typeof openCodeVersion).toBe('string')
    expect(body.openCodeVersion).toBe(openCodeVersion ?? null)
    expect(await doesContainerExist(containerId)).toBe(true)
    await handle.stop()
    expect(await doesContainerExist(containerId)).toBe(false)
  } finally {
    await handle.stop()
    await rm(configDirectory, { force: true, recursive: true })
  }
  },
)

/** Verifies workspace-backed containers bind-mount the selected host folder by default. */
test(
  'workspace-backed runtime containers bind-mount the selected host workspace directory',
  { timeout: integrationTestTimeoutMs },
  async () => {
    if (!(await canUseDocker())) {
      console.warn('Skipping Docker integration test because Docker is unavailable.')
      return
    }

    const workspaceDirectory = await mkdtemp(resolve(tmpdir(), 'vide-workspace-mount-test-'))
    const { configDirectory, handle, port } = await startWorkspaceIntegrationServer(workspaceDirectory)

    try {
      const body = await waitForContainerHealth(port)

      expect(body.runtimeStatus).toBe('ready')
      expect(body.dockerContainer?.id).toBeTruthy()

      const containerId = body.dockerContainer?.id ?? null

      if (!containerId) {
        throw new Error('The health endpoint did not return a workspace container identifier.')
      }

      const mounts = await getContainerMounts(containerId)
      const workspaceMount = mounts.find((mount) => mount.Destination === '/workspace')

      expect(workspaceMount?.Type).toBe('bind')
      expect(workspaceMount?.Source).toBe(workspaceDirectory)
    } finally {
      await handle.stop()
      await rm(configDirectory, { force: true, recursive: true })
      await rm(workspaceDirectory, { force: true, recursive: true })
    }
  },
)

/** Verifies session-manager chat messages reach containerized OpenCode and surface provider errors. */
test(
  'server websocket forwards user messages to containerized OpenCode and returns OpenCode errors',
  { timeout: integrationTestTimeoutMs },
  async () => {
    if (!(await canUseDocker())) {
      console.warn('Skipping Docker integration test because Docker is unavailable.')
      return
    }

    const { configDirectory, handle, port } = await startMessageFlowIntegrationServer()
    const socket = await openWebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      const health = await waitForContainerHealth(port)

      expect(health.runtimeStatus).toBe('ready')
      expect(health.openCodeStatus).toBe('ready')

      socket.send(
        JSON.stringify({
          type: 'connect',
          sessionId: 'integration-session',
        }),
      )
      socket.send(
        JSON.stringify({
          type: 'user_message',
          sessionId: 'integration-session',
          text: 'Please say hello.',
        }),
      )

      const message = await waitForSessionErrorMessage(socket)

      expect(message.type).toBe('session_error')
      expect(message.message.length).toBeGreaterThan(0)
      expect(message.message).toContain('Model not found:')
      expect(message.message).toContain('openai/gpt-5')
      expect(message.message).not.toContain('undefined is not an object')
      expect(message.message).not.toContain('info.error')
      expect(message.message).not.toContain('malformed prompt response')
    } finally {
      socket.close()
      await handle.stop()
      await rm(configDirectory, { force: true, recursive: true })
    }
  },
)

/** Verifies restarting the backend creates a fresh repo-owned OpenCode runtime container. */
test(
  'server restart creates a fresh repo-owned OpenCode runtime container',
  { timeout: integrationTestTimeoutMs },
  async () => {
  if (!(await canUseDocker())) {
    console.warn('Skipping Docker integration test because Docker is unavailable.')
    return
  }

  const configDirectory = await createTemporaryConfigDirectory()
  const firstRun = await startIntegrationServer({ configDirectory })
  let firstContainerId: string | null = null

  try {
    const firstHealth = await waitForContainerHealth(firstRun.port)

    firstContainerId = firstHealth.dockerContainer?.id ?? null
    expect(firstHealth.runtimeStatus).toBe('ready')
    expect(firstHealth.openCodeStatus).toBe('ready')
  } finally {
    await firstRun.handle.stop()
  }

  const secondRun = await startIntegrationServer({ configDirectory })

  try {
    const secondHealth = await waitForContainerHealth(secondRun.port)

    expect(secondHealth.runtimeStatus).toBe('ready')
    expect(secondHealth.openCodeStatus).toBe('ready')
    expect(secondHealth.dockerContainer?.id).toBeTruthy()
    expect(secondHealth.dockerContainer?.id).not.toBe(firstContainerId)
  } finally {
    await secondRun.handle.stop()
    await rm(configDirectory, { force: true, recursive: true })
  }
  },
)

/** Verifies saving the OpenAI key persists disk state and marks the runtime as needing apply. */
test(
  'runtime config save persists the OpenAI key and leaves the runtime needing apply',
  { timeout: integrationTestTimeoutMs },
  async () => {
    if (!(await canUseDocker())) {
      console.warn('Skipping Docker integration test because Docker is unavailable.')
      return
    }

    const { configDirectory, handle, port } = await startIntegrationServer({
      defaultSecretStorageMode: 'plaintext',
    })

    try {
      const health = await waitForContainerHealth(port)

      expect(health.runtimeStatus).toBe('ready')

      const summary = await saveOpenAiKey(port, 'sk-test-save')
      const configFile = JSON.parse(
        await readFile(resolve(configDirectory, 'config.json'), 'utf8'),
      ) as PersistedOpenAiConfigFile
      const secretsFile = JSON.parse(
        await readFile(resolve(configDirectory, 'secrets.json'), 'utf8'),
      ) as { openaiApiKey?: string }

      expect(summary.secretStorageMode).toBe('plaintext')
      expect(summary.hasOpenAIKey).toBe(true)
      expect(summary.runtimeAvailable).toBe(true)
      expect(summary.needsApply).toBe(true)
      expect(summary.lastAppliedSavedRevision).toBe(0)
      expect(configFile.secretStorageMode).toBe('plaintext')
      expect(configFile.openai.savedRevision).toBe(1)
      expect(secretsFile.openaiApiKey).toBe('sk-test-save')
    } finally {
      await handle.stop()
      await rm(configDirectory, { force: true, recursive: true })
    }
  },
)

/** Verifies applying the saved OpenAI key reaches the running OpenCode container. */
test(
  'runtime config apply reconciles the saved OpenAI key with the running OpenCode container',
  { timeout: integrationTestTimeoutMs },
  async () => {
    if (!(await canUseDocker())) {
      console.warn('Skipping Docker integration test because Docker is unavailable.')
      return
    }

    const { configDirectory, handle, port } = await startIntegrationServer({
      defaultSecretStorageMode: 'plaintext',
    })

    try {
      const health = await waitForContainerHealth(port)
      const containerBaseUrl = health.runtimeBaseUrl

      if (!containerBaseUrl) {
        throw new Error('The health endpoint did not return the OpenCode base URL.')
      }

      await saveOpenAiKey(port, 'sk-test-apply')
      const summary = await applyOpenAiKey(port)

      expect(summary.needsApply).toBe(false)
      expect(summary.lastAppliedSavedRevision).toBe(1)
      await waitForConnectedProvider(containerBaseUrl, 'openai')
      expect(await getConnectedProviderIds(containerBaseUrl)).toContain('openai')
    } finally {
      await handle.stop()
      await rm(configDirectory, { force: true, recursive: true })
    }
  },
)

/** Verifies converting the saved OpenAI key between plaintext and encrypted storage modes. */
test(
  'runtime config convert moves the saved OpenAI key between plaintext and encrypted storage',
  { timeout: integrationTestTimeoutMs },
  async () => {
    if (!(await canUseDocker())) {
      console.warn('Skipping Docker integration test because Docker is unavailable.')
      return
    }

    const { configDirectory, handle, port } = await startIntegrationServer({
      defaultSecretStorageMode: 'plaintext',
    })
    const plaintextSecretsPath = resolve(configDirectory, 'secrets.json')
    const encryptedSecretsPath = resolve(configDirectory, 'secrets.enc')

    try {
      await waitForContainerHealth(port)
      await saveOpenAiKey(port, 'sk-test-convert')

      const encryptedSummary = await convertToEncrypted(port, 'correct horse battery staple')

      expect(encryptedSummary.secretStorageMode).toBe('encrypted')
      expect(encryptedSummary.hasOpenAIKey).toBe(true)
      expect(encryptedSummary.locked).toBe(false)
      expect(await doesFileExist(plaintextSecretsPath)).toBe(false)
      expect(await doesFileExist(encryptedSecretsPath)).toBe(true)

      const plaintextSummary = await convertToPlaintext(port)

      expect(plaintextSummary.secretStorageMode).toBe('plaintext')
      expect(plaintextSummary.hasOpenAIKey).toBe(true)
      expect(await doesFileExist(plaintextSecretsPath)).toBe(true)
      expect(await doesFileExist(encryptedSecretsPath)).toBe(false)
    } finally {
      await handle.stop()
      await rm(configDirectory, { force: true, recursive: true })
    }
  },
)

/** Verifies restarting the backend reapplies the saved OpenAI key to the fresh runtime. */
test(
  'runtime config restart reapplies the saved OpenAI key to a fresh OpenCode container',
  { timeout: integrationTestTimeoutMs },
  async () => {
    if (!(await canUseDocker())) {
      console.warn('Skipping Docker integration test because Docker is unavailable.')
      return
    }

    const configDirectory = await createTemporaryConfigDirectory()
    const firstRun = await startIntegrationServer({
      configDirectory,
      defaultSecretStorageMode: 'plaintext',
    })

    try {
      const firstHealth = await waitForContainerHealth(firstRun.port)
      const firstContainerBaseUrl = firstHealth.runtimeBaseUrl

      if (!firstContainerBaseUrl) {
        throw new Error('The first run did not report the OpenCode base URL.')
      }

      await saveOpenAiKey(firstRun.port, 'sk-test-restart')
      await applyOpenAiKey(firstRun.port)
      await waitForConnectedProvider(firstContainerBaseUrl, 'openai')
    } finally {
      await firstRun.handle.stop()
    }

    const secondRun = await startIntegrationServer({
      configDirectory,
      defaultSecretStorageMode: 'plaintext',
    })

    try {
      const secondHealth = await waitForContainerHealth(secondRun.port)
      const secondContainerBaseUrl = secondHealth.runtimeBaseUrl

      if (!secondContainerBaseUrl) {
        throw new Error('The second run did not report the OpenCode base URL.')
      }

      await waitForConnectedProvider(secondContainerBaseUrl, 'openai')
      const summary = await fetchRuntimeConfig<OpenAiConfigSummary>(
        secondRun.port,
        '/runtime-config/openai',
      )

      expect(summary.runtimeAvailable).toBe(true)
      expect(summary.needsApply).toBe(false)
      expect(summary.lastAppliedSavedRevision).toBe(1)
      expect(await getConnectedProviderIds(secondContainerBaseUrl)).toContain('openai')
    } finally {
      await secondRun.handle.stop()
      await rm(configDirectory, { force: true, recursive: true })
    }
  },
)
