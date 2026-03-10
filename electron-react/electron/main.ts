import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'

import { app, BrowserWindow, dialog, ipcMain } from 'electron'

import type {
  BackendConnectionInfo,
  BackendStatusSnapshot,
} from '../src/lib/types/backend'
import type {
  ConvertOpenAiConfigRequest,
  OpenAiConfigSummary,
  SaveOpenAiConfigRequest,
  UnlockOpenAiConfigRequest,
} from '../src/lib/types/openai-config'
import type {
  CreateWorkspaceRequest,
  LoadWorkspaceRequest,
  SaveWorkspaceRequest,
  WorkspaceRegistrySnapshot,
} from '../src/lib/types/workspace'
import type { VoiceBridgeEvent, VoiceState } from '../src/lib/types/voice'

const backendHealthPollIntervalMs = 250
const backendLoopbackHost = 'localhost'
const backendRequestTimeoutMs = 2_000
const backendShutdownTimeoutMs = 3_000
const backendStartupTimeoutMs = 10_000

/** Represents the minimal health payload returned by the Bun backend. */
interface ManagedBackendHealthPayload {
  activeWorkspaceHostPath?: string | null
  activeWorkspaceId?: string | null
  activeWorkspaceName?: string | null
  containerBaseUrl?: string | null
  containerError?: string | null
  containerId?: string | null
  containerImage?: string | null
  containerName?: string | null
  containerStartedAt?: string | null
  containerStatus?: string | null
  instanceId?: string | null
  ok?: true
  openCodeError?: string | null
  openCodeStatus?: string | null
  openCodeVersion?: string | null
  serverType?: string | null
  serverTypeHash?: string | null
  startedAt?: string | null
}

/** Represents the supervised local backend process managed by Electron. */
interface ManagedBackendSupervisor {
  child: ChildProcessWithoutNullStreams | null
  connectionInfo: BackendConnectionInfo
  desiredState: 'running' | 'stopped'
  lastError: string
  startPromise: Promise<void> | null
  state: 'running' | 'starting' | 'stopped'
  stopPromise: Promise<void> | null
}

/** Represents one configurable Electron boot option set used by tests and app startup. */
export interface ElectronBootOptions {
  rendererHtml?: string
  rendererUrl?: string
}

let mainWindow: BrowserWindow | null = null
let managedBackend: ManagedBackendSupervisor | null = null
let voiceState: VoiceState = 'idle'
let activateHandlerRegistered = false
let ipcHandlersRegistered = false

/** Sends a voice event to the renderer when the main window exists. */
function sendVoiceEvent(event: VoiceBridgeEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  mainWindow.webContents.send('vide:voice:event', event)
}

/** Returns whether Electron is running against the Vite development server. */
function isElectronDevMode(): boolean {
  return Boolean(process.env.VITE_DEV_SERVER_URL)
}

/** Returns the repository root containing both the React Electron app and server. */
function getRepositoryRoot(): string {
  return path.resolve(__dirname, '..', '..')
}

/** Returns the Bun server project root supervised by Electron. */
function getServerProjectRoot(): string {
  return path.resolve(getRepositoryRoot(), 'server')
}

/** Returns the config directory path the Bun backend should use for local settings files. */
function getBackendConfigDirectory(): string {
  return path.join(app.getPath('userData'), 'config')
}

/** Returns a promise that resolves after the provided delay. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Returns whether one backend-reported container status value is valid. */
function isManagedBackendContainerStatus(
  value: string | null | undefined,
): value is BackendStatusSnapshot['containerStatus'] {
  return value === 'starting' || value === 'ready' || value === 'stopped' || value === 'error'
}

/** Returns whether one backend-reported OpenCode status value is valid. */
function isManagedBackendOpenCodeStatus(
  value: string | null | undefined,
): value is BackendStatusSnapshot['openCodeStatus'] {
  return value === 'starting' || value === 'ready' || value === 'stopped' || value === 'error'
}

/** Returns an available local TCP port for one managed backend process. */
async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()

    server.once('error', rejectPort)
    server.listen(0, backendLoopbackHost, () => {
      const address = server.address()

      if (!address || typeof address === 'string') {
        rejectPort(new Error('The Electron app could not reserve a backend port.'))
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

/** Builds the renderer-facing connection URLs for the provided backend port. */
function createBackendConnectionInfo(port: number): BackendConnectionInfo {
  const baseUrl = `http://${backendLoopbackHost}:${port}`

  return {
    baseUrl,
    healthUrl: `${baseUrl}/health`,
    sessionServerUrl: `ws://${backendLoopbackHost}:${port}/ws`,
  }
}

/** Builds renderer-facing backend URLs from one externally provided base URL. */
function createBackendConnectionInfoFromBaseUrl(baseUrl: string): BackendConnectionInfo {
  const parsedBaseUrl = new URL(baseUrl)
  const normalizedBaseUrl = parsedBaseUrl.toString().replace(/\/$/, '')
  const sessionProtocol = parsedBaseUrl.protocol === 'https:' ? 'wss:' : 'ws:'

  return {
    baseUrl: normalizedBaseUrl,
    healthUrl: `${normalizedBaseUrl}/health`,
    sessionServerUrl: `${sessionProtocol}//${parsedBaseUrl.host}/ws`,
  }
}

/** Returns the externally managed backend base URL override used by integration tests. */
function getManagedBackendBaseUrlOverride(): string | null {
  const configuredBaseUrl = process.env.VIDE_TEST_BACKEND_BASE_URL?.trim()
  return configuredBaseUrl && configuredBaseUrl.length > 0 ? configuredBaseUrl : null
}

/** Returns whether Electron should connect to one externally managed backend. */
function usesExternalManagedBackend(): boolean {
  return getManagedBackendBaseUrlOverride() !== null
}

/** Returns a short renderer-safe message for one managed-backend failure. */
function toManagedBackendErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The managed backend failed.'
}

/** Fetches one managed-backend URL with a timeout so status checks cannot hang forever. */
async function fetchManagedBackend(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, backendRequestTimeoutMs)

  try {
    return await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The managed backend request timed out.')
    }

    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

/** Returns the renderer-safe message extracted from one backend API response body. */
async function getManagedBackendApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown }

    if (typeof body.message === 'string' && body.message.trim().length > 0) {
      return body.message
    }
  } catch {
    // Fall through to the generic error below when the body is not JSON.
  }

  return `The managed backend request failed with status ${response.status}.`
}

/** Fetches one JSON endpoint from the managed backend and throws renderer-safe errors. */
async function fetchManagedBackendJson<T>(
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  await startManagedBackend()

  const requestInit: RequestInit = {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  }
  let response: Response

  if (pathname.startsWith('/runtime-config/')) {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        response = await fetchManagedBackend(
          `${getManagedBackendConnectionInfo().baseUrl}${pathname}`,
          requestInit,
        )

        if (response.status !== 404) {
          if (!response.ok) {
            throw new Error(await getManagedBackendApiError(response))
          }

          return (await response.json()) as T
        }

        lastError = new Error(await getManagedBackendApiError(response))

        if (attempt === 0) {
          await restartManagedBackend()
        } else {
          await wait(250)
        }
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error('The managed backend request failed.')

        if (attempt === 0) {
          await restartManagedBackend()
        } else {
          await wait(250)
        }
      }
    }

    throw lastError ?? new Error('The managed backend runtime-config request failed.')
  }

  response = await fetchManagedBackend(
    `${getManagedBackendConnectionInfo().baseUrl}${pathname}`,
    requestInit,
  )

  if (!response.ok) {
    throw new Error(await getManagedBackendApiError(response))
  }

  return (await response.json()) as T
}

/** Returns the Bun command Electron should use to launch the backend process. */
function createManagedBackendCommand(): { args: string[]; command: string } {
  return {
    args: ['run', isElectronDevMode() ? 'dev' : 'start'],
    command: 'bun',
  }
}

/** Streams the managed backend stdout and stderr into the Electron terminal output. */
function attachManagedBackendLogging(child: ChildProcessWithoutNullStreams): void {
  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${String(chunk)}`)
  })

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend] ${String(chunk)}`)
  })
}

/** Initializes the managed backend supervisor and reserves its connection info. */
async function initializeManagedBackend(): Promise<ManagedBackendSupervisor> {
  if (managedBackend) {
    return managedBackend
  }

  const managedBackendBaseUrlOverride = getManagedBackendBaseUrlOverride()
  managedBackend = {
    child: null,
    connectionInfo: managedBackendBaseUrlOverride
      ? createBackendConnectionInfoFromBaseUrl(managedBackendBaseUrlOverride)
      : createBackendConnectionInfo(await getAvailablePort()),
    desiredState: 'stopped',
    lastError: '',
    startPromise: null,
    state: 'stopped',
    stopPromise: null,
  }

  return managedBackend
}

/** Waits until the managed backend health endpoint starts responding successfully. */
async function waitForManagedBackendHealth(healthUrl: string): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < backendStartupTimeoutMs) {
    try {
      const response = await fetchManagedBackend(healthUrl)

      if (!response.ok) {
        await wait(backendHealthPollIntervalMs)
        continue
      }

      const body = (await response.json()) as ManagedBackendHealthPayload

      if (body.ok === true) {
        return
      }
    } catch {
      // Keep polling until the managed backend is ready.
    }

    await wait(backendHealthPollIntervalMs)
  }

  throw new Error('The managed backend did not become healthy in time.')
}

/** Stops one managed backend child process and waits for it to exit. */
async function stopManagedBackendChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  await new Promise<void>((resolveExit) => {
    const timeoutId = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }, backendShutdownTimeoutMs)

    child.once('exit', () => {
      clearTimeout(timeoutId)
      resolveExit()
    })

    child.kill('SIGTERM')
  })
}

/** Handles one managed backend child-process exit against the current supervisor state. */
function handleManagedBackendExit(
  supervisor: ManagedBackendSupervisor,
  child: ChildProcessWithoutNullStreams,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (supervisor.child !== child) {
    return
  }

  supervisor.child = null
  supervisor.state = 'stopped'

  if (supervisor.desiredState === 'stopped') {
    return
  }

  supervisor.lastError =
    code === 0 || signal === 'SIGTERM'
      ? 'The managed backend stopped.'
      : `The managed backend exited unexpectedly${code === null ? '' : ` with code ${code}`}.`
}

/** Spawns one managed Bun backend child process using the current supervisor configuration. */
function spawnManagedBackend(supervisor: ManagedBackendSupervisor): ChildProcessWithoutNullStreams {
  const { args, command } = createManagedBackendCommand()
  const child = spawn(command, args, {
    cwd: getServerProjectRoot(),
    env: {
      ...process.env,
      VIDE_CONFIG_DIR: getBackendConfigDirectory(),
      VIDE_SERVER_PORT: String(new URL(supervisor.connectionInfo.baseUrl).port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  attachManagedBackendLogging(child)
  child.once('exit', (code, signal) => {
    handleManagedBackendExit(supervisor, child, code, signal)
  })

  return child
}

/** Starts the managed Bun backend if it is not already running. */
async function startManagedBackend(): Promise<void> {
  const supervisor = await initializeManagedBackend()
  supervisor.desiredState = 'running'

  if (supervisor.state === 'running' && (supervisor.child || usesExternalManagedBackend())) {
    return
  }

  if (supervisor.startPromise) {
    await supervisor.startPromise
    return
  }

  supervisor.lastError = ''
  supervisor.state = 'starting'
  supervisor.startPromise = (async () => {
    if (usesExternalManagedBackend()) {
      await waitForManagedBackendHealth(supervisor.connectionInfo.healthUrl)
      supervisor.state = 'running'
      return
    }

    const child = spawnManagedBackend(supervisor)
    supervisor.child = child

    try {
      await waitForManagedBackendHealth(supervisor.connectionInfo.healthUrl)

      if (supervisor.child === child) {
        supervisor.state = 'running'
      }
    } catch (error) {
      supervisor.lastError = toManagedBackendErrorMessage(error)

      if (supervisor.child === child) {
        await stopManagedBackendChild(child)
        supervisor.child = null
        supervisor.state = 'stopped'
      }

      throw error
    }
  })()

  try {
    await supervisor.startPromise
  } finally {
    supervisor.startPromise = null
  }
}

/** Stops the managed Bun backend when Electron no longer needs it. */
async function stopManagedBackend(): Promise<void> {
  const supervisor = managedBackend

  if (!supervisor) {
    return
  }

  supervisor.desiredState = 'stopped'
  supervisor.lastError = ''

  if (supervisor.stopPromise) {
    await supervisor.stopPromise
    return
  }

  const child = supervisor.child
  supervisor.state = 'stopped'

  if (!child) {
    return
  }

  supervisor.child = null
  supervisor.stopPromise = (async () => {
    await stopManagedBackendChild(child)
  })()

  try {
    await supervisor.stopPromise
  } finally {
    supervisor.stopPromise = null
  }
}

/** Restarts the managed Bun backend by replacing the supervised child process. */
async function restartManagedBackend(): Promise<void> {
  if (usesExternalManagedBackend()) {
    managedBackend = null
    await startManagedBackend()
    return
  }

  await stopManagedBackend()
  await startManagedBackend()
}

/** Returns the reserved renderer connection info for the managed Bun backend. */
function getManagedBackendConnectionInfo(): BackendConnectionInfo {
  if (!managedBackend) {
    throw new Error('The managed backend connection info is not ready yet.')
  }

  return managedBackend.connectionInfo
}

/** Returns the latest backend status snapshot for the renderer status panel. */
async function getManagedBackendStatus(): Promise<BackendStatusSnapshot> {
  const supervisor = await initializeManagedBackend()
  const managedByApp = !usesExternalManagedBackend()
  const hasChild = Boolean(supervisor.child)
  const baseSnapshot: BackendStatusSnapshot = {
    ...supervisor.connectionInfo,
    activeWorkspaceHostPath: null,
    activeWorkspaceId: null,
    activeWorkspaceName: null,
    containerBaseUrl: null,
    containerError: '',
    containerId: null,
    containerImage: null,
    containerName: null,
    containerStartedAt: null,
    containerStatus: 'stopped',
    error: supervisor.lastError,
    healthStatus: 'stopped',
    instanceId: null,
    managedByApp,
    openCodeError: '',
    openCodeStatus: 'stopped',
    openCodeVersion: null,
    processId: supervisor.child?.pid ?? null,
    serverType: null,
    serverTypeHash: null,
    startedAt: null,
    supportsRestart: managedByApp && hasChild,
    supportsStart: managedByApp && !hasChild,
    supportsStop: managedByApp && hasChild,
  }

  if (supervisor.state === 'starting') {
    return {
      ...baseSnapshot,
      healthStatus: 'starting',
      supportsRestart: false,
      supportsStart: false,
      supportsStop: false,
    }
  }

  if (!supervisor.child) {
    return baseSnapshot
  }

  try {
    const response = await fetchManagedBackend(supervisor.connectionInfo.healthUrl)

    if (!response.ok) {
      return {
        ...baseSnapshot,
        error: `Health check returned ${response.status}.`,
        healthStatus: 'unreachable',
      }
    }

    const body = (await response.json()) as ManagedBackendHealthPayload

    if (
      body.ok !== true ||
      typeof body.containerError !== 'string' ||
      typeof body.containerImage !== 'string' ||
      !isManagedBackendContainerStatus(body.containerStatus) ||
      typeof body.instanceId !== 'string' ||
      typeof body.openCodeError !== 'string' ||
      !isManagedBackendOpenCodeStatus(body.openCodeStatus) ||
      typeof body.serverType !== 'string' ||
      typeof body.serverTypeHash !== 'string' ||
      typeof body.startedAt !== 'string' ||
      (body.activeWorkspaceHostPath !== null && typeof body.activeWorkspaceHostPath !== 'string') ||
      (body.activeWorkspaceId !== null && typeof body.activeWorkspaceId !== 'string') ||
      (body.activeWorkspaceName !== null && typeof body.activeWorkspaceName !== 'string') ||
      (body.containerBaseUrl !== null && typeof body.containerBaseUrl !== 'string') ||
      (body.containerId !== null && typeof body.containerId !== 'string') ||
      (body.containerName !== null && typeof body.containerName !== 'string') ||
      (body.containerStartedAt !== null && typeof body.containerStartedAt !== 'string') ||
      (body.openCodeVersion !== null && typeof body.openCodeVersion !== 'string')
    ) {
      return {
        ...baseSnapshot,
        error: 'The backend returned an invalid health response.',
        healthStatus: 'unreachable',
      }
    }

    return {
      ...baseSnapshot,
      activeWorkspaceHostPath: body.activeWorkspaceHostPath ?? null,
      activeWorkspaceId: body.activeWorkspaceId ?? null,
      activeWorkspaceName: body.activeWorkspaceName ?? null,
      containerBaseUrl: body.containerBaseUrl ?? null,
      containerError: body.containerError,
      containerId: body.containerId ?? null,
      containerImage: body.containerImage,
      containerName: body.containerName ?? null,
      containerStartedAt: body.containerStartedAt ?? null,
      containerStatus: body.containerStatus,
      error: '',
      healthStatus: 'healthy',
      instanceId: body.instanceId,
      serverType: body.serverType,
      serverTypeHash: body.serverTypeHash,
      openCodeError: body.openCodeError,
      openCodeStatus: body.openCodeStatus,
      openCodeVersion: body.openCodeVersion ?? null,
      startedAt: body.startedAt,
    }
  } catch (error) {
    return {
      ...baseSnapshot,
      error: toManagedBackendErrorMessage(error),
      healthStatus: 'unreachable',
    }
  }
}

/** Emits a voice state transition only when the state actually changes. */
function setVoiceState(nextState: VoiceState): void {
  if (voiceState === nextState) {
    return
  }

  voiceState = nextState
  sendVoiceEvent({ type: 'state', state: nextState })
}

/** Starts the placeholder voice session used by the React migration shell. */
async function startVoice(): Promise<void> {
  setVoiceState('recording')
  sendVoiceEvent({ type: 'partial', text: '' })
}

/** Finalizes the placeholder voice session and returns an empty transcript. */
async function stopVoice(): Promise<string> {
  setVoiceState('processing')
  setVoiceState('idle')
  return ''
}

/** Cancels the placeholder voice session without producing transcript text. */
async function cancelVoice(): Promise<void> {
  setVoiceState('idle')
  sendVoiceEvent({ type: 'partial', text: '' })
}

/** Creates the main Electron browser window for the React renderer. */
function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#111111',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  return window
}

/** Returns the latest OpenAI config summary from the Bun backend. */
async function getOpenAiConfigSummary(): Promise<OpenAiConfigSummary> {
  return await fetchManagedBackendJson<OpenAiConfigSummary>('/runtime-config/openai')
}

/** Saves or updates the OpenAI API key using the Bun runtime config API. */
async function saveOpenAiConfig(request: SaveOpenAiConfigRequest): Promise<OpenAiConfigSummary> {
  return await fetchManagedBackendJson<OpenAiConfigSummary>('/runtime-config/openai', {
    body: JSON.stringify(request),
    method: 'PUT',
  })
}

/** Clears the saved OpenAI API key from the Bun runtime config store. */
async function clearOpenAiConfig(): Promise<OpenAiConfigSummary> {
  return await fetchManagedBackendJson<OpenAiConfigSummary>('/runtime-config/openai', {
    method: 'DELETE',
  })
}

/** Unlocks the encrypted OpenAI key store for the current Bun process. */
async function unlockOpenAiConfig(
  request: UnlockOpenAiConfigRequest,
): Promise<OpenAiConfigSummary> {
  return await fetchManagedBackendJson<OpenAiConfigSummary>('/runtime-config/openai/unlock', {
    body: JSON.stringify(request),
    method: 'POST',
  })
}

/** Converts the OpenAI key store between plaintext and encrypted modes. */
async function convertOpenAiConfig(
  request: ConvertOpenAiConfigRequest,
): Promise<OpenAiConfigSummary> {
  return await fetchManagedBackendJson<OpenAiConfigSummary>('/runtime-config/openai/convert', {
    body: JSON.stringify(request),
    method: 'POST',
  })
}

/** Applies the latest saved OpenAI key to the running OpenCode runtime. */
async function applyOpenAiConfig(): Promise<OpenAiConfigSummary> {
  return await fetchManagedBackendJson<OpenAiConfigSummary>('/runtime-config/openai/apply', {
    method: 'POST',
  })
}

/** Opens one native folder picker and returns the chosen host directory path. */
async function pickWorkspaceFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ['createDirectory', 'openDirectory'],
    title: 'Choose workspace folder',
  })

  if (result.canceled) {
    return null
  }

  return result.filePaths[0] ?? null
}

/** Returns the current workspace registry snapshot from the Bun backend. */
async function getWorkspaceSummary(): Promise<WorkspaceRegistrySnapshot> {
  return await fetchManagedBackendJson<WorkspaceRegistrySnapshot>('/workspaces')
}

/** Creates or reattaches one workspace from the provided host folder path. */
async function createWorkspace(
  request: CreateWorkspaceRequest,
): Promise<WorkspaceRegistrySnapshot> {
  return await fetchManagedBackendJson<WorkspaceRegistrySnapshot>('/workspaces/create', {
    body: JSON.stringify(request),
    method: 'POST',
  })
}

/** Persists metadata for the currently active workspace. */
async function saveWorkspace(request: SaveWorkspaceRequest): Promise<WorkspaceRegistrySnapshot> {
  return await fetchManagedBackendJson<WorkspaceRegistrySnapshot>('/workspaces/save', {
    body: JSON.stringify(request),
    method: 'POST',
  })
}

/** Loads one previously saved workspace and reattaches the runtime to it. */
async function loadWorkspace(request: LoadWorkspaceRequest): Promise<WorkspaceRegistrySnapshot> {
  return await fetchManagedBackendJson<WorkspaceRegistrySnapshot>('/workspaces/load', {
    body: JSON.stringify(request),
    method: 'POST',
  })
}

/** Registers the IPC handlers exposed through the preload bridge. */
function registerIpcHandlers(): void {
  ipcMain.handle('vide:ping', async () => 'pong')

  ipcMain.on('vide:backend:connection-info', (event) => {
    event.returnValue = getManagedBackendConnectionInfo()
  })

  ipcMain.handle('vide:backend:status', getManagedBackendStatus)
  ipcMain.handle('vide:backend:start', startManagedBackend)
  ipcMain.handle('vide:backend:stop', stopManagedBackend)
  ipcMain.handle('vide:backend:restart', restartManagedBackend)
  ipcMain.handle('vide:runtime-config:summary', getOpenAiConfigSummary)
  ipcMain.handle('vide:runtime-config:save', (_event, request: SaveOpenAiConfigRequest) =>
    saveOpenAiConfig(request),
  )
  ipcMain.handle('vide:runtime-config:clear', clearOpenAiConfig)
  ipcMain.handle(
    'vide:runtime-config:unlock',
    (_event, request: UnlockOpenAiConfigRequest) => unlockOpenAiConfig(request),
  )
  ipcMain.handle(
    'vide:runtime-config:convert',
    (_event, request: ConvertOpenAiConfigRequest) => convertOpenAiConfig(request),
  )
  ipcMain.handle('vide:runtime-config:apply', applyOpenAiConfig)
  ipcMain.handle('vide:workspace:pick-folder', pickWorkspaceFolder)
  ipcMain.handle('vide:workspace:summary', getWorkspaceSummary)
  ipcMain.handle('vide:workspace:create', (_event, request: CreateWorkspaceRequest) =>
    createWorkspace(request),
  )
  ipcMain.handle('vide:workspace:save', (_event, request: SaveWorkspaceRequest) =>
    saveWorkspace(request),
  )
  ipcMain.handle('vide:workspace:load', (_event, request: LoadWorkspaceRequest) =>
    loadWorkspace(request),
  )
  ipcMain.handle('vide:voice:start', startVoice)
  ipcMain.handle('vide:voice:stop', stopVoice)
  ipcMain.handle('vide:voice:cancel', cancelVoice)
  ipcMain.on('vide:voice:chunk', () => {})
}

/** Registers the preload and backend IPC handlers once for the current Electron process. */
function ensureIpcHandlersRegistered(): void {
  if (ipcHandlersRegistered) {
    return
  }

  registerIpcHandlers()
  ipcHandlersRegistered = true
}

/** Loads the requested renderer target into the provided Electron browser window. */
async function loadRendererTarget(
  window: BrowserWindow,
  options: ElectronBootOptions = {},
): Promise<void> {
  if (options.rendererUrl) {
    await window.loadURL(options.rendererUrl)
    return
  }

  if (typeof options.rendererHtml === 'string') {
    await window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(options.rendererHtml)}`)
    return
  }

  const devServerUrl = process.env.VITE_DEV_SERVER_URL

  if (devServerUrl) {
    await window.loadURL(devServerUrl)
    return
  }

  await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

/** Registers the macOS activate handler once for whichever renderer target boot chose first. */
function ensureActivateHandlerRegistered(options: ElectronBootOptions = {}): void {
  if (activateHandlerRegistered) {
    return
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) {
      return
    }

    mainWindow = createMainWindow()
    void loadRendererTarget(mainWindow, options)
  })
  activateHandlerRegistered = true
}

/** Boots Electron and returns the primary browser window after its renderer loads. */
export async function bootElectronApp(options: ElectronBootOptions = {}): Promise<BrowserWindow> {
  await app.whenReady()
  await initializeManagedBackend()
  ensureIpcHandlersRegistered()

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
  }

  await loadRendererTarget(mainWindow, options)
  ensureActivateHandlerRegistered(options)
  return mainWindow
}

/** Boots Electron and creates the first browser window for the React app. */
async function main(): Promise<void> {
  await bootElectronApp()
}

/** Stops the managed backend before Electron exits. */
function stopManagedBackendOnExit(): void {
  void stopManagedBackend()
}

app.on('before-quit', stopManagedBackendOnExit)
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    return
  }

  app.quit()
})

if (process.env.VIDE_SKIP_MAIN_AUTORUN !== 'true') {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'The Electron main process failed.')
    app.exit(1)
  })
}
