import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'bun:test'

import { createStaticAgentRuntime } from './agent/fake-agent-runtime'
import { createDockerSessionContainerManager } from './container/session-container'
import { startServer, type ServerHandle, type ServerHealthPayload } from './lib'
import type { SessionErrorMessage } from './session/session-types'

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

    if (body.containerStatus === 'ready' || body.containerStatus === 'error') {
      return body
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250)
    })
  }

  throw new Error('The integration test backend never reported a terminal container state.')
}

/** Returns whether the provided Docker container identifier still exists. */
async function doesContainerExist(containerId: string): Promise<boolean> {
  const result = await runCommand('docker', ['container', 'inspect', containerId])
  return result.exitCode === 0
}

/** Starts one integration server using the default OpenCode SDK client adapter path. */
async function startMessageFlowIntegrationServer(): Promise<{ handle: ServerHandle; port: number }> {
  await ensureRuntimeImageBuilt()
  const port = await getAvailablePort()
  const previousRuntimeMode = process.env.VIDE_AGENT_RUNTIME_MODE

  process.env.VIDE_AGENT_RUNTIME_MODE = 'opencode'

  try {
    const handle = startServer({
      port,
      sessionContainerManager: createDockerSessionContainerManager({
        autoBuildImage: false,
        buildContext: runtimeDockerDirectory,
        dockerfilePath: runtimeDockerfilePath,
        forwardedEnvNames: [],
        image: dockerTestImage,
        mountWorkspace: false,
      }),
    })

    return { handle, port }
  } finally {
    if (previousRuntimeMode === undefined) {
      delete process.env.VIDE_AGENT_RUNTIME_MODE
    } else {
      process.env.VIDE_AGENT_RUNTIME_MODE = previousRuntimeMode
    }
  }
}

/** Creates one real Docker-backed Bun server for container lifecycle integration tests. */
async function startIntegrationServer(): Promise<{ handle: ServerHandle; port: number }> {
  await ensureRuntimeImageBuilt()
  const port = await getAvailablePort()
  const handle = startServer({
    agentRuntime: createStaticAgentRuntime({
      assistantText: 'Fake OpenCode assistant reply.',
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

  return { handle, port }
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

  const { handle, port } = await startIntegrationServer()

  try {
    const body = await waitForContainerHealth(port)

    expect(body.containerStatus).toBe('ready')
    expect(body.containerId).toBeTruthy()
    expect(body.containerImage).toBe(dockerTestImage)
    expect(body.containerName).toContain('vide-session-')
    expect(body.containerBaseUrl).toBeTruthy()
    expect(body.openCodeStatus).toBe('ready')

    const containerId = body.containerId
    const containerBaseUrl = body.containerBaseUrl

    if (!containerId || !containerBaseUrl) {
      throw new Error('The health endpoint did not return container runtime details.')
    }

    const openCodeHealth = await getOpenCodeHealth(containerBaseUrl)

    expect(openCodeHealth.healthy).toBe(true)
    expect(typeof openCodeHealth.version).toBe('string')
    expect(body.openCodeVersion).toBe(openCodeHealth.version)
    expect(await doesContainerExist(containerId)).toBe(true)
    await handle.stop()
    expect(await doesContainerExist(containerId)).toBe(false)
  } finally {
    await handle.stop()
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

    const { handle, port } = await startMessageFlowIntegrationServer()
    const socket = await openWebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      const health = await waitForContainerHealth(port)

      expect(health.containerStatus).toBe('ready')
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

  const firstRun = await startIntegrationServer()
  let firstContainerId: string | null = null

  try {
    const firstHealth = await waitForContainerHealth(firstRun.port)

    firstContainerId = firstHealth.containerId
    expect(firstHealth.containerStatus).toBe('ready')
    expect(firstHealth.openCodeStatus).toBe('ready')
  } finally {
    await firstRun.handle.stop()
  }

  const secondRun = await startIntegrationServer()

  try {
    const secondHealth = await waitForContainerHealth(secondRun.port)

    expect(secondHealth.containerStatus).toBe('ready')
    expect(secondHealth.openCodeStatus).toBe('ready')
    expect(secondHealth.containerId).toBeTruthy()
    expect(secondHealth.containerId).not.toBe(firstContainerId)
  } finally {
    await secondRun.handle.stop()
  }
  },
)
