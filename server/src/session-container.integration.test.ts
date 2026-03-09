import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'bun:test'

import { createStaticAgentRuntime } from './agent/fake-agent-runtime'
import { createDockerSessionContainerManager } from './container/session-container'
import { startServer, type ServerHandle, type ServerHealthPayload } from './lib'

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
