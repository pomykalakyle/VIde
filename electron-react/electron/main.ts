import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'

import { app, BrowserWindow, ipcMain } from 'electron'

import type {
  BackendConnectionInfo,
  BackendStatusSnapshot,
} from '../src/lib/types/backend'
import type { VoiceBridgeEvent, VoiceState } from '../src/lib/types/voice'

const backendHealthPollIntervalMs = 250
const backendLoopbackHost = 'localhost'
const backendRequestTimeoutMs = 2_000
const backendShutdownTimeoutMs = 3_000
const backendStartupTimeoutMs = 10_000

/** Represents the minimal health payload returned by the Bun backend. */
interface ManagedBackendHealthPayload {
  instanceId?: string | null
  ok?: true
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

let mainWindow: BrowserWindow | null = null
let managedBackend: ManagedBackendSupervisor | null = null
let voiceState: VoiceState = 'idle'

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

/** Returns a promise that resolves after the provided delay. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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

/** Returns a short renderer-safe message for one managed-backend failure. */
function toManagedBackendErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The managed backend failed.'
}

/** Fetches one managed-backend URL with a timeout so status checks cannot hang forever. */
async function fetchManagedBackend(url: string): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, backendRequestTimeoutMs)

  try {
    return await fetch(url, {
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

  managedBackend = {
    child: null,
    connectionInfo: createBackendConnectionInfo(await getAvailablePort()),
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

  if (supervisor.state === 'running' && supervisor.child) {
    return
  }

  if (supervisor.startPromise) {
    await supervisor.startPromise
    return
  }

  supervisor.lastError = ''
  supervisor.state = 'starting'
  supervisor.startPromise = (async () => {
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
  const hasChild = Boolean(supervisor.child)
  const baseSnapshot: BackendStatusSnapshot = {
    ...supervisor.connectionInfo,
    error: supervisor.lastError,
    healthStatus: 'stopped',
    instanceId: null,
    managedByApp: true,
    processId: supervisor.child?.pid ?? null,
    serverType: null,
    serverTypeHash: null,
    startedAt: null,
    supportsRestart: hasChild,
    supportsStart: !hasChild,
    supportsStop: hasChild,
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
      typeof body.instanceId !== 'string' ||
      typeof body.serverType !== 'string' ||
      typeof body.serverTypeHash !== 'string' ||
      typeof body.startedAt !== 'string'
    ) {
      return {
        ...baseSnapshot,
        error: 'The backend returned an invalid health response.',
        healthStatus: 'unreachable',
      }
    }

    return {
      ...baseSnapshot,
      error: '',
      healthStatus: 'healthy',
      instanceId: body.instanceId,
      serverType: body.serverType,
      serverTypeHash: body.serverTypeHash,
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

  const devServerUrl = process.env.VITE_DEV_SERVER_URL

  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  return window
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
  ipcMain.handle('vide:voice:start', startVoice)
  ipcMain.handle('vide:voice:stop', stopVoice)
  ipcMain.handle('vide:voice:cancel', cancelVoice)
  ipcMain.on('vide:voice:chunk', () => {})
}

/** Boots Electron and creates the first browser window for the React app. */
async function main(): Promise<void> {
  await app.whenReady()
  await initializeManagedBackend()
  registerIpcHandlers()
  mainWindow = createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) {
      return
    }

    mainWindow = createMainWindow()
  })
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

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'The Electron main process failed.')
  app.exit(1)
})
