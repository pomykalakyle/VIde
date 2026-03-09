import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import {
  getSessionContainerAutoBuildImage,
  getSessionContainerBuildContext,
  getSessionContainerCommand,
  getSessionContainerDockerCommand,
  getSessionContainerDockerfilePath,
  getSessionContainerEntrypoint,
  getSessionContainerForwardedEnvNames,
  getSessionContainerHealthPath,
  getSessionContainerHealthPollIntervalMs,
  getSessionContainerImage,
  getSessionContainerMountWorkspace,
  getSessionContainerPort,
  getSessionContainerStartupTimeoutMs,
  getSessionContainerWorkspaceMountTarget,
  getWorkspaceDirectory,
} from '../config'

/** Represents one lifecycle state surfaced for the coordinator-owned container. */
export type SessionContainerStatus = 'starting' | 'ready' | 'stopped' | 'error'

/** Represents one lifecycle state surfaced for the OpenCode server inside the container. */
export type SessionOpenCodeStatus = 'starting' | 'ready' | 'stopped' | 'error'

/** Represents one OpenCode health payload returned by the runtime container. */
interface OpenCodeHealthPayload {
  healthy?: boolean
  version?: string
}

/** Represents one container snapshot included in backend health responses. */
export interface SessionContainerSnapshot {
  baseUrl: string | null
  containerId: string | null
  containerImage: string
  containerName: string | null
  error: string
  openCodeError: string
  openCodeStatus: SessionOpenCodeStatus
  openCodeVersion: string | null
  startedAt: string | null
  status: SessionContainerStatus
}

/** Represents the contract the Bun server uses to manage its session container. */
export interface SessionContainerManager {
  getSnapshot(): SessionContainerSnapshot
  start(): Promise<void>
  stop(): Promise<void>
}

/** Represents one configurable option set for Docker-backed session containers. */
export interface DockerSessionContainerManagerOptions {
  autoBuildImage?: boolean
  buildContext?: string
  command?: string
  containerPort?: number
  dockerCommand?: string
  dockerfilePath?: string
  entrypoint?: string
  forwardedEnvNames?: string[]
  healthPath?: string
  healthPollIntervalMs?: number
  image?: string
  mountWorkspace?: boolean
  startupTimeoutMs?: number
  workspaceDirectory?: string
  workspaceMountTarget?: string
}

/** Represents the collected output from one Docker CLI command. */
interface CommandResult {
  exitCode: number | null
  stderr: string
  stdout: string
}

const managedContainerLabel = 'vide.managed-by=vide'

/** Returns one promise that resolves after the provided delay. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Returns one backend-safe error message for container lifecycle failures. */
function toSessionContainerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The session container lifecycle failed.'
}

/** Returns one unique Docker container name for a coordinator-owned session container. */
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

/** Returns the Docker `-e` arguments for every forwarded environment variable. */
function getForwardedEnvironmentArguments(forwardedEnvNames: string[]): string[] {
  const forwardedArguments: string[] = []

  for (const envName of forwardedEnvNames) {
    if (typeof process.env[envName] !== 'string') {
      continue
    }

    forwardedArguments.push('-e', envName)
  }

  return forwardedArguments
}

/** Removes one session container by identifier and ignores missing-container errors. */
async function removeContainer(dockerCommand: string, containerId: string): Promise<void> {
  try {
    await runDockerCommand(dockerCommand, ['rm', '-f', containerId])
  } catch (error) {
    const message = toSessionContainerErrorMessage(error)

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

/** Waits until the session container health endpoint responds successfully. */
async function waitForContainerReadiness(
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

  throw new Error('The session container did not become healthy in time.')
}

/** Creates one Docker-backed session container manager for the Bun coordinator. */
export function createDockerSessionContainerManager(
  options: DockerSessionContainerManagerOptions = {},
): SessionContainerManager {
  const command = options.command ?? getSessionContainerCommand()
  const containerPort = options.containerPort ?? getSessionContainerPort()
  const dockerCommand = options.dockerCommand ?? getSessionContainerDockerCommand()
  const dockerfilePath = options.dockerfilePath ?? getSessionContainerDockerfilePath()
  const entrypoint = options.entrypoint ?? getSessionContainerEntrypoint()
  const forwardedEnvNames =
    options.forwardedEnvNames ?? getSessionContainerForwardedEnvNames()
  const healthPath = options.healthPath ?? getSessionContainerHealthPath()
  const healthPollIntervalMs =
    options.healthPollIntervalMs ?? getSessionContainerHealthPollIntervalMs()
  const image = options.image ?? getSessionContainerImage()
  const autoBuildImage = options.autoBuildImage ?? getSessionContainerAutoBuildImage()
  const buildContext = options.buildContext ?? getSessionContainerBuildContext()
  const mountWorkspace = options.mountWorkspace ?? getSessionContainerMountWorkspace()
  const startupTimeoutMs = options.startupTimeoutMs ?? getSessionContainerStartupTimeoutMs()
  const workspaceDirectory = options.workspaceDirectory ?? getWorkspaceDirectory()
  const workspaceMountTarget =
    options.workspaceMountTarget ?? getSessionContainerWorkspaceMountTarget()
  let snapshot: SessionContainerSnapshot = {
    baseUrl: null,
    containerId: null,
    containerImage: image,
    containerName: null,
    error: '',
    openCodeError: '',
    openCodeStatus: 'stopped',
    openCodeVersion: null,
    startedAt: null,
    status: 'stopped',
  }
  let startPromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null

  /** Returns the latest session container snapshot for the health endpoint. */
  function getSnapshot(): SessionContainerSnapshot {
    return { ...snapshot }
  }

  /** Creates and waits for the Docker-backed session container. */
  async function start(): Promise<void> {
    if (startPromise) {
      await startPromise
      return
    }

    if (snapshot.status === 'ready' && snapshot.containerId) {
      return
    }

    const containerName = createSessionContainerName()
    snapshot = {
      ...snapshot,
      baseUrl: null,
      containerId: null,
      containerName,
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
          ...getForwardedEnvironmentArguments(forwardedEnvNames),
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
          containerId,
        }
        const openCodeHealth = await waitForContainerReadiness(
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
          containerId: null,
          error: toSessionContainerErrorMessage(error),
          openCodeError: toSessionContainerErrorMessage(error),
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

  /** Stops and removes the current Docker-backed session container. */
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

    const containerId = snapshot.containerId

    if (!containerId) {
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
      return
    }

    stopPromise = (async () => {
      await removeContainer(dockerCommand, containerId)
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
