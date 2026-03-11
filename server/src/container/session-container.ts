import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Config as OpenCodeConfig } from '@opencode-ai/sdk'

import {
  createOpenCodeConfig,
  defaultSessionContainerAutoBuildImage,
  defaultSessionContainerBuildContext,
  defaultSessionContainerCommand,
  defaultSessionContainerDockerCommand,
  defaultSessionContainerDockerfilePath,
  defaultSessionContainerEntrypoint,
  defaultSessionContainerHealthPath,
  defaultSessionContainerHealthPollIntervalMs,
  defaultSessionContainerImage,
  defaultSessionContainerMountWorkspace,
  defaultSessionContainerPort,
  defaultSessionContainerStartupTimeoutMs,
  defaultSessionContainerWorkspaceMountTarget,
  defaultWorkspaceDirectory,
} from '../config'
import type { WorkspaceExecutionMode } from '../workspace/workspace-store'

/** Represents one lifecycle state surfaced for the coordinator-owned runtime. */
export type SessionRuntimeStatus = 'starting' | 'ready' | 'stopped' | 'error'

/** Represents one lifecycle state surfaced for the OpenCode server inside the container. */
export type SessionOpenCodeStatus = 'starting' | 'ready' | 'stopped' | 'error'

/** Represents one Docker-specific metadata block surfaced for Docker runtimes. */
export interface SessionDockerContainerMetadata {
  id: string | null
  image: string
  name: string | null
}

/** Represents one OpenCode health payload returned by the managed runtime. */
interface OpenCodeHealthPayload {
  healthy?: boolean
  version?: string
}

/** Represents one runtime snapshot included in backend health responses. */
export interface SessionRuntimeSnapshot {
  baseUrl: string | null
  dockerContainer: SessionDockerContainerMetadata | null
  error: string
  executionMode: WorkspaceExecutionMode | null
  openCodeError: string
  openCodeStatus: SessionOpenCodeStatus
  openCodeVersion: string | null
  startedAt: string | null
  status: SessionRuntimeStatus
}

/** Represents the contract the Bun server uses to manage its session runtime. */
export interface SessionRuntimeManager {
  getSnapshot(): SessionRuntimeSnapshot
  start(): Promise<void>
  stop(): Promise<void>
}

/** Represents one configurable option set for Docker-backed session runtimes. */
export interface DockerSessionRuntimeManagerOptions {
  autoBuildImage?: boolean
  buildContext?: string
  command?: string
  containerPort?: number
  dockerCommand?: string
  dockerfilePath?: string
  entrypoint?: string
  healthPath?: string
  healthPollIntervalMs?: number
  image?: string
  mountWorkspace?: boolean
  startupTimeoutMs?: number
  workspaceDirectory?: string
  workspaceMountTarget?: string
}

/** Represents one configurable option set for unsafe host-backed runtimes. */
export interface UnsafeHostSessionRuntimeManagerOptions {
  healthPath?: string
  healthPollIntervalMs?: number
  startupTimeoutMs?: number
}

/** Represents one compatibility alias for existing container terminology. */
export type SessionContainerStatus = SessionRuntimeStatus

/** Represents one compatibility alias for existing container terminology. */
export type SessionContainerSnapshot = SessionRuntimeSnapshot

/** Represents one compatibility alias for existing container terminology. */
export type SessionContainerManager = SessionRuntimeManager

/** Represents one compatibility alias for existing container terminology. */
export type DockerSessionContainerManagerOptions = DockerSessionRuntimeManagerOptions

/** Represents the collected output from one Docker CLI command. */
interface CommandResult {
  exitCode: number | null
  stderr: string
  stdout: string
}

/** Represents one isolated embedded OpenCode server handle for unsafe-host runtimes. */
interface UnsafeHostRuntimeServer {
  close(): void
  closed: Promise<void>
  runtimeDirectory: string
  url: string
}

const managedContainerLabel = 'vide.managed-by=vide'

/** Returns the normalized health path used for container readiness checks. */
function normalizeHealthPath(healthPath: string): string {
  return healthPath.startsWith('/') ? healthPath : `/${healthPath}`
}

/** Returns one promise that resolves after the provided delay. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Returns one available loopback TCP port for an embedded unsafe-host runtime. */
async function getAvailableTcpPort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()

    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()

      if (!address || typeof address === 'string') {
        rejectPort(new Error('The unsafe-host runtime could not reserve a TCP port.'))
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

/** Starts one isolated embedded OpenCode server rooted in a temporary VIde-owned directory. */
async function createUnsafeHostRuntimeServer(options: {
  config: OpenCodeConfig
  hostname: string
  port: number
  timeoutMs: number
}): Promise<UnsafeHostRuntimeServer> {
  const trimmedRuntimeDirectory = await mkdtemp(path.join(tmpdir(), 'vide-opencode-runtime-'))
  const configHome = path.join(trimmedRuntimeDirectory, 'config')
  const dataHome = path.join(trimmedRuntimeDirectory, 'data')
  const stateHome = path.join(trimmedRuntimeDirectory, 'state')
  const cacheHome = path.join(trimmedRuntimeDirectory, 'cache')

  await Promise.all([
    mkdir(path.join(configHome, 'opencode'), { recursive: true }),
    mkdir(path.join(dataHome, 'opencode'), { recursive: true }),
    mkdir(stateHome, { recursive: true }),
    mkdir(cacheHome, { recursive: true }),
  ])

  const args = ['serve', `--hostname=${options.hostname}`, `--port=${options.port}`]
  let output = ''
  const child = spawn('opencode', args, {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
      OPENCODE_CONFIG_DIR: path.join(configHome, 'opencode'),
      XDG_CACHE_HOME: cacheHome,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve()
    })
  })

  try {
    const url = await new Promise<string>((resolveUrl, rejectUrl) => {
      const timeoutId = setTimeout(() => {
        rejectUrl(new Error(`Timeout waiting for the unsafe-host runtime after ${options.timeoutMs}ms`))
      }, options.timeoutMs)
      let didResolve = false

      child.stdout?.on('data', (chunk) => {
        output += String(chunk)

        for (const line of output.split('\n')) {
          if (!line.startsWith('opencode server listening')) {
            continue
          }

          const match = line.match(/on\s+(https?:\/\/[^\s]+)/)

          if (!match) {
            clearTimeout(timeoutId)
            rejectUrl(new Error(`Failed to parse the unsafe-host runtime url from output: ${line}`))
            return
          }

          didResolve = true
          clearTimeout(timeoutId)
          resolveUrl(match[1])
          return
        }
      })
      child.stderr?.on('data', (chunk) => {
        output += String(chunk)
      })
      child.once('error', (error) => {
        clearTimeout(timeoutId)
        rejectUrl(error)
      })
      child.once('exit', (code) => {
        if (didResolve) {
          return
        }

        clearTimeout(timeoutId)
        let message = `Server exited with code ${code}`

        if (output.trim()) {
          message += `\nServer output: ${output}`
        }

        rejectUrl(new Error(message))
      })
    })

    return {
      close(): void {
        child.kill()
      },
      closed,
      runtimeDirectory: trimmedRuntimeDirectory,
      url,
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await closed
    }

    await rm(trimmedRuntimeDirectory, { force: true, recursive: true })
    throw error
  }
}

/** Returns one Docker metadata block for the provided image and container identity. */
function createDockerContainerMetadata(
  image: string,
  containerId: string | null = null,
  name: string | null = null,
): SessionDockerContainerMetadata {
  return {
    id: containerId,
    image,
    name,
  }
}

/** Returns one stopped runtime snapshot for the provided execution mode. */
function createStoppedRuntimeSnapshot(
  executionMode: WorkspaceExecutionMode | null,
  dockerContainer: SessionDockerContainerMetadata | null,
): SessionRuntimeSnapshot {
  return {
    baseUrl: null,
    dockerContainer,
    error: '',
    executionMode,
    openCodeError: '',
    openCodeStatus: 'stopped',
    openCodeVersion: null,
    startedAt: null,
    status: 'stopped',
  }
}

/** Returns one backend-safe error message for runtime lifecycle failures. */
function toSessionRuntimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The session runtime lifecycle failed.'
}

/** Returns one unique Docker container name for a coordinator-owned session runtime. */
function createSessionContainerName(): string {
  return `vide-session-${randomUUID().slice(0, 8)}`
}

/** Returns whether the provided Docker CLI output indicates a missing container. */
function isMissingContainerError(output: string): boolean {
  return output.toLowerCase().includes('no such container')
}

/** Returns the Docker label arguments applied to coordinator-owned containers. */
function getManagedContainerLabelArguments(): string[] {
  return ['--label', managedContainerLabel]
}

/** Runs one process and collects its stdout, stderr, and exit code. */
function runCommand(command: string, args: string[]): Promise<CommandResult> {
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

/** Runs one Docker CLI command and throws when it exits unsuccessfully. */
async function runDockerCommand(dockerCommand: string, args: string[]): Promise<string> {
  const result = await runCommand(dockerCommand, args)

  if (result.exitCode === 0) {
    return result.stdout
  }

  throw new Error(result.stderr || result.stdout || 'The Docker command failed.')
}

/** Returns whether the provided Docker image already exists locally. */
async function doesDockerImageExist(dockerCommand: string, image: string): Promise<boolean> {
  const result = await runCommand(dockerCommand, ['image', 'inspect', image])
  return result.exitCode === 0
}

/** Builds the provided Docker image from the repo-owned runtime Dockerfile. */
async function buildDockerImage(
  dockerCommand: string,
  image: string,
  dockerfilePath: string,
  buildContext: string,
): Promise<void> {
  await runDockerCommand(dockerCommand, ['build', '-t', image, '-f', dockerfilePath, buildContext])
}

/** Ensures the configured Docker image exists locally before starting a container. */
async function ensureDockerImageExists(
  dockerCommand: string,
  image: string,
  dockerfilePath: string,
  buildContext: string,
  autoBuildImage: boolean,
): Promise<void> {
  if (await doesDockerImageExist(dockerCommand, image)) {
    return
  }

  if (!autoBuildImage) {
    throw new Error(`The session container image "${image}" is not available locally.`)
  }

  await buildDockerImage(dockerCommand, image, dockerfilePath, buildContext)
}

/** Returns the published loopback URL for one running session container. */
async function getContainerBaseUrl(
  dockerCommand: string,
  containerId: string,
  containerPort: number,
): Promise<string> {
  const publishedPort = await runDockerCommand(dockerCommand, [
    'port',
    containerId,
    `${containerPort}/tcp`,
  ])
  const publishedAddress = publishedPort.split('\n')[0]?.trim() ?? ''
  const [host, port] = publishedAddress.split(':')

  if (!host || !port) {
    throw new Error('Docker did not report a published session container port.')
  }

  return `http://${host}:${port}`
}

/** Removes one session container by identifier and ignores missing-container errors. */
async function removeContainer(dockerCommand: string, containerId: string): Promise<void> {
  try {
    await runDockerCommand(dockerCommand, ['rm', '-f', containerId])
  } catch (error) {
    const message = toSessionRuntimeErrorMessage(error)

    if (isMissingContainerError(message)) {
      return
    }

    throw error
  }
}

/** Removes any stale coordinator-owned containers left behind by earlier runs. */
async function removeStaleSessionContainers(dockerCommand: string): Promise<void> {
  const containerIds = await runDockerCommand(dockerCommand, [
    'ps',
    '-aq',
    '--filter',
    `label=${managedContainerLabel}`,
  ])
  const staleContainerIds = containerIds
    .split('\n')
    .map((containerId) => containerId.trim())
    .filter((containerId) => containerId.length > 0)

  for (const containerId of staleContainerIds) {
    await removeContainer(dockerCommand, containerId)
  }
}

/** Waits until the managed OpenCode runtime health endpoint responds successfully. */
async function waitForRuntimeReadiness(
  baseUrl: string,
  healthPath: string,
  startupTimeoutMs: number,
  healthPollIntervalMs: number,
): Promise<OpenCodeHealthPayload> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < startupTimeoutMs) {
    try {
      const response = await fetch(`${baseUrl}${healthPath}`)

      if (response.ok) {
        return (await response.json()) as OpenCodeHealthPayload
      }
    } catch {
      // Keep polling until the container is ready or times out.
    }

    await wait(healthPollIntervalMs)
  }

  throw new Error('The session runtime did not become healthy in time.')
}

/** Creates one Docker-backed session runtime manager for the Bun coordinator. */
export function createDockerSessionRuntimeManager(
  options: DockerSessionRuntimeManagerOptions = {},
): SessionRuntimeManager {
  const command = options.command ?? defaultSessionContainerCommand
  const containerPort = options.containerPort ?? defaultSessionContainerPort
  const dockerCommand = options.dockerCommand ?? defaultSessionContainerDockerCommand
  const dockerfilePath = options.dockerfilePath ?? defaultSessionContainerDockerfilePath
  const entrypoint = options.entrypoint ?? defaultSessionContainerEntrypoint
  const healthPath = normalizeHealthPath(options.healthPath ?? defaultSessionContainerHealthPath)
  const healthPollIntervalMs =
    options.healthPollIntervalMs ?? defaultSessionContainerHealthPollIntervalMs
  const image = options.image ?? defaultSessionContainerImage
  const autoBuildImage = options.autoBuildImage ?? defaultSessionContainerAutoBuildImage
  const buildContext = options.buildContext ?? defaultSessionContainerBuildContext
  const mountWorkspace = options.mountWorkspace ?? defaultSessionContainerMountWorkspace
  const startupTimeoutMs = options.startupTimeoutMs ?? defaultSessionContainerStartupTimeoutMs
  const workspaceDirectory = options.workspaceDirectory ?? defaultWorkspaceDirectory
  const workspaceMountTarget =
    options.workspaceMountTarget ?? defaultSessionContainerWorkspaceMountTarget
  let snapshot = createStoppedRuntimeSnapshot('docker', createDockerContainerMetadata(image))
  let startPromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null

  /** Returns the latest session runtime snapshot for the health endpoint. */
  function getSnapshot(): SessionRuntimeSnapshot {
    return { ...snapshot }
  }

  /** Creates and waits for the Docker-backed session runtime. */
  async function start(): Promise<void> {
    if (startPromise) {
      await startPromise
      return
    }

    if (snapshot.status === 'ready' && snapshot.dockerContainer?.id) {
      return
    }

    const containerName = createSessionContainerName()
    snapshot = {
      ...snapshot,
      baseUrl: null,
      dockerContainer: createDockerContainerMetadata(image, null, containerName),
      error: '',
      openCodeError: '',
      openCodeStatus: 'starting',
      openCodeVersion: null,
      startedAt: null,
      status: 'starting',
    }
    startPromise = (async () => {
      let containerId: string | null = null

      try {
        await ensureDockerImageExists(
          dockerCommand,
          image,
          dockerfilePath,
          buildContext,
          autoBuildImage,
        )
        await removeStaleSessionContainers(dockerCommand)
        const workspaceArguments = mountWorkspace
          ? ['-w', workspaceMountTarget, '-v', `${workspaceDirectory}:${workspaceMountTarget}`]
          : []
        containerId = await runDockerCommand(dockerCommand, [
          'run',
          '-d',
          '--name',
          containerName,
          ...workspaceArguments,
          '-p',
          `127.0.0.1::${containerPort}`,
          ...getManagedContainerLabelArguments(),
          '--entrypoint',
          entrypoint,
          image,
          '-lc',
          command,
        ])
        const baseUrl = await getContainerBaseUrl(dockerCommand, containerId, containerPort)

        snapshot = {
          ...snapshot,
          baseUrl,
          dockerContainer: createDockerContainerMetadata(image, containerId, containerName),
        }
        const openCodeHealth = await waitForRuntimeReadiness(
          baseUrl,
          healthPath,
          startupTimeoutMs,
          healthPollIntervalMs,
        )
        snapshot = {
          ...snapshot,
          error: '',
          openCodeError: openCodeHealth.healthy === true ? '' : 'OpenCode reported an unhealthy state.',
          openCodeStatus: openCodeHealth.healthy === true ? 'ready' : 'error',
          openCodeVersion:
            typeof openCodeHealth.version === 'string' ? openCodeHealth.version : null,
          startedAt: new Date().toISOString(),
          status: openCodeHealth.healthy === true ? 'ready' : 'error',
        }
      } catch (error) {
        if (containerId) {
          try {
            await removeContainer(dockerCommand, containerId)
          } catch {
            // The original startup error is more actionable than cleanup noise here.
          }
        }

        snapshot = {
          ...snapshot,
          baseUrl: null,
          dockerContainer: createDockerContainerMetadata(image),
          error: toSessionRuntimeErrorMessage(error),
          openCodeError: toSessionRuntimeErrorMessage(error),
          openCodeStatus: 'error',
          openCodeVersion: null,
          startedAt: null,
          status: 'error',
        }
        throw error
      }
    })()

    try {
      await startPromise
    } finally {
      startPromise = null
    }
  }

  /** Stops and removes the current Docker-backed session runtime. */
  async function stop(): Promise<void> {
    if (stopPromise) {
      await stopPromise
      return
    }

    if (startPromise) {
      try {
        await startPromise
      } catch {
        // Stop should still attempt cleanup after a failed startup.
      }
    }

    const containerId = snapshot.dockerContainer?.id ?? null

    if (!containerId) {
      snapshot = createStoppedRuntimeSnapshot('docker', createDockerContainerMetadata(image))
      return
    }

    stopPromise = (async () => {
      await removeContainer(dockerCommand, containerId)
      snapshot = createStoppedRuntimeSnapshot('docker', createDockerContainerMetadata(image))
    })()

    try {
      await stopPromise
    } finally {
      stopPromise = null
    }
  }

  return {
    getSnapshot,
    start,
    stop,
  }
}

/** Creates one unsafe host-backed session runtime manager for the Bun coordinator. */
export function createUnsafeHostSessionRuntimeManager(
  options: UnsafeHostSessionRuntimeManagerOptions = {},
): SessionRuntimeManager {
  const healthPath = normalizeHealthPath(options.healthPath ?? defaultSessionContainerHealthPath)
  const healthPollIntervalMs =
    options.healthPollIntervalMs ?? defaultSessionContainerHealthPollIntervalMs
  const startupTimeoutMs = options.startupTimeoutMs ?? defaultSessionContainerStartupTimeoutMs
  let snapshot = createStoppedRuntimeSnapshot('unsafe-host', null)
  let runtimeServer: UnsafeHostRuntimeServer | null = null
  let startPromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null

  /** Returns the latest unsafe-host runtime snapshot for the health endpoint. */
  function getSnapshot(): SessionRuntimeSnapshot {
    return { ...snapshot }
  }

  /** Starts one embedded OpenCode server directly on the host. */
  async function start(): Promise<void> {
    if (startPromise) {
      await startPromise
      return
    }

    if (snapshot.status === 'ready' && snapshot.baseUrl) {
      return
    }

    snapshot = {
      ...snapshot,
      baseUrl: null,
      error: '',
      openCodeError: '',
      openCodeStatus: 'starting',
      openCodeVersion: null,
      startedAt: null,
      status: 'starting',
    }
    startPromise = (async () => {
      try {
        const port = await getAvailableTcpPort()
        const embeddedRuntime = await createUnsafeHostRuntimeServer({
          config: createOpenCodeConfig(),
          hostname: '127.0.0.1',
          port,
          timeoutMs: startupTimeoutMs,
        })

        runtimeServer = embeddedRuntime
        snapshot = {
          ...snapshot,
          baseUrl: embeddedRuntime.url,
        }
        const openCodeHealth = await waitForRuntimeReadiness(
          embeddedRuntime.url,
          healthPath,
          startupTimeoutMs,
          healthPollIntervalMs,
        )

        snapshot = {
          ...snapshot,
          error: '',
          openCodeError: openCodeHealth.healthy === true ? '' : 'OpenCode reported an unhealthy state.',
          openCodeStatus: openCodeHealth.healthy === true ? 'ready' : 'error',
          openCodeVersion:
            typeof openCodeHealth.version === 'string' ? openCodeHealth.version : null,
          startedAt: new Date().toISOString(),
          status: openCodeHealth.healthy === true ? 'ready' : 'error',
        }
      } catch (error) {
        runtimeServer?.close()
        await runtimeServer?.closed
        if (runtimeServer) {
          await rm(runtimeServer.runtimeDirectory, { force: true, recursive: true })
        }
        runtimeServer = null
        snapshot = {
          ...snapshot,
          baseUrl: null,
          error: toSessionRuntimeErrorMessage(error),
          openCodeError: toSessionRuntimeErrorMessage(error),
          openCodeStatus: 'error',
          openCodeVersion: null,
          startedAt: null,
          status: 'error',
        }
        throw error
      }
    })()

    try {
      await startPromise
    } finally {
      startPromise = null
    }
  }

  /** Stops the embedded OpenCode server running directly on the host. */
  async function stop(): Promise<void> {
    if (stopPromise) {
      await stopPromise
      return
    }

    if (startPromise) {
      try {
        await startPromise
      } catch {
        // Stop should still reset local state after a failed startup.
      }
    }

    if (!runtimeServer) {
      snapshot = createStoppedRuntimeSnapshot('unsafe-host', null)
      return
    }

    stopPromise = (async () => {
      runtimeServer?.close()
      await runtimeServer?.closed
      if (runtimeServer) {
        await rm(runtimeServer.runtimeDirectory, { force: true, recursive: true })
      }
      runtimeServer = null
      snapshot = createStoppedRuntimeSnapshot('unsafe-host', null)
    })()

    try {
      await stopPromise
    } finally {
      stopPromise = null
    }
  }

  return {
    getSnapshot,
    start,
    stop,
  }
}

/** Re-exports the Docker runtime factory under the older container terminology. */
export const createDockerSessionContainerManager = createDockerSessionRuntimeManager
