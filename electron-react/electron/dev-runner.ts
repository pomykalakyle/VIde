import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

const electronProjectRoot = path.resolve(import.meta.dir, '..')
const electronDistDirectory = path.join(electronProjectRoot, 'electron-dist')
const electronMainEntryPath = path.join(electronDistDirectory, 'main.js')
const electronPreloadEntryPath = path.join(electronDistDirectory, 'preload.js')
const electronRestartDebounceMs = 150
const electronStartupPollIntervalMs = 150
const electronStartupTimeoutMs = 15_000
const viteDevServerUrl = 'http://localhost:5174'

/** Represents the mutable state tracked by the Electron development runner. */
interface DevRunnerState {
  child: ChildProcess | null
  exitRequested: boolean
  launchPromise: Promise<void> | null
  restartPending: boolean
  restartTimer: ReturnType<typeof setTimeout> | null
  restartTriggeredByWatcher: boolean
  watcher: FSWatcher | null
}

/** Waits for the provided delay before continuing. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Returns whether the Electron entrypoints and Vite dev server are both ready. */
async function isElectronAppReady(): Promise<boolean> {
  if (!existsSync(electronMainEntryPath) || !existsSync(electronPreloadEntryPath)) {
    return false
  }

  try {
    const response = await fetch(viteDevServerUrl)
    return response.ok
  } catch {
    return false
  }
}

/** Waits until the development renderer and Electron bundles are ready to launch. */
async function waitForElectronAppReady(): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < electronStartupTimeoutMs) {
    if (await isElectronAppReady()) {
      return
    }

    await wait(electronStartupPollIntervalMs)
  }

  throw new Error('The Electron dev runner timed out waiting for Vite or electron-dist output.')
}

/** Clears the pending restart debounce timer when one exists. */
function clearRestartTimer(state: DevRunnerState): void {
  if (!state.restartTimer) {
    return
  }

  clearTimeout(state.restartTimer)
  state.restartTimer = null
}

/** Stops the current Electron child process when one is still running. */
function stopElectronChild(state: DevRunnerState): void {
  if (!state.child || state.child.exitCode !== null || state.child.signalCode !== null) {
    return
  }

  state.child.kill('SIGTERM')
}

/** Launches a fresh Electron child process for the current dev session. */
function launchElectronChild(state: DevRunnerState): void {
  const child = spawn('electron', [electronMainEntryPath], {
    cwd: electronProjectRoot,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: viteDevServerUrl,
    },
    stdio: 'inherit',
  })

  state.child = child
  child.once('exit', (code, signal) => {
    if (state.child === child) {
      state.child = null
    }

    if (state.exitRequested) {
      process.exit(0)
    }

    if (state.restartPending || state.restartTriggeredByWatcher) {
      state.restartPending = false
      state.restartTriggeredByWatcher = false
      void ensureElectronRunning(state)
      return
    }

    if (signal) {
      process.exit(1)
      return
    }

    process.exit(code ?? 0)
  })
}

/** Ensures one Electron child is running after the inputs become ready. */
async function ensureElectronRunning(state: DevRunnerState): Promise<void> {
  if (state.launchPromise) {
    await state.launchPromise
    return
  }

  state.launchPromise = (async () => {
    await waitForElectronAppReady()

    if (state.exitRequested || state.child) {
      return
    }

    launchElectronChild(state)
  })()

  try {
    await state.launchPromise
  } finally {
    state.launchPromise = null
  }
}

/** Schedules one Electron restart after a watched bundle file changes. */
function scheduleElectronRestart(state: DevRunnerState): void {
  clearRestartTimer(state)
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null
    state.restartPending = true

    if (state.child) {
      state.restartTriggeredByWatcher = true
      stopElectronChild(state)
      return
    }

    state.restartPending = false
    void ensureElectronRunning(state)
  }, electronRestartDebounceMs)
}

/** Starts watching the built Electron entry files for restart-triggering changes. */
function startElectronWatcher(state: DevRunnerState): void {
  if (state.watcher) {
    return
  }

  state.watcher = watch(electronDistDirectory, (_eventType, filename) => {
    if (!filename || (filename !== 'main.js' && filename !== 'preload.js')) {
      return
    }

    scheduleElectronRestart(state)
  })
}

/** Stops the dev runner and any active Electron child process. */
function shutdownDevRunner(state: DevRunnerState, exitCode = 0): void {
  state.exitRequested = true
  clearRestartTimer(state)
  state.watcher?.close()
  state.watcher = null

  if (!state.child) {
    process.exit(exitCode)
    return
  }

  state.child.once('exit', () => {
    process.exit(exitCode)
  })
  stopElectronChild(state)
}

/** Runs the Electron development process supervisor until the app exits cleanly. */
async function main(): Promise<void> {
  const state: DevRunnerState = {
    child: null,
    exitRequested: false,
    launchPromise: null,
    restartPending: false,
    restartTimer: null,
    restartTriggeredByWatcher: false,
    watcher: null,
  }

  process.once('SIGINT', () => {
    shutdownDevRunner(state, 0)
  })

  process.once('SIGTERM', () => {
    shutdownDevRunner(state, 0)
  })

  await waitForElectronAppReady()
  startElectronWatcher(state)
  await ensureElectronRunning(state)
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'The Electron dev runner failed.')
  process.exit(1)
})
