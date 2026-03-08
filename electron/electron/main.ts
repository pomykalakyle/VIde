import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'

import { SherpaSttSession } from './stt-session'
import type { VoiceBridgeEvent } from '../src/lib/types/voice'

let mainWindow: BrowserWindow | null = null
let sttSession: SherpaSttSession | null = null

/** Sends a voice event to the renderer when the main window exists. */
function sendVoiceEvent(event: VoiceBridgeEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  mainWindow.webContents.send('vide:voice:event', event)
}

/** Mirrors renderer voice debug console messages into the Electron terminal output. */
function attachRendererDebugLogging(window: BrowserWindow): void {
  window.webContents.on('console-message', (_event, _level, message) => {
    if (!message.startsWith('[voice-debug]')) {
      return
    }

    console.log(message)
  })
}

/** Returns the active STT session, creating it on first use. */
function getSttSession(): SherpaSttSession {
  if (!sttSession) {
    sttSession = new SherpaSttSession(sendVoiceEvent)
  }

  return sttSession
}

/** Starts a new speech-to-text recording session in the main process. */
async function startVoiceSession(): Promise<void> {
  await getSttSession().start()
}

/** Finalizes the active speech-to-text recording session. */
async function stopVoiceSession(): Promise<string> {
  if (!sttSession) {
    return ''
  }

  return sttSession.stop()
}

/** Cancels the active speech-to-text recording session. */
function cancelVoiceSession(): void {
  sttSession?.cancel()
}

/** Converts renderer IPC audio payloads into Float32Array chunks. */
function coerceAudioChunk(payload: unknown): Float32Array | null {
  if (payload instanceof Float32Array) {
    return payload
  }

  if (payload instanceof ArrayBuffer) {
    return new Float32Array(payload)
  }

  if (ArrayBuffer.isView(payload)) {
    return new Float32Array(payload.buffer.slice(0))
  }

  return null
}

/**
 * Creates the main application window.
 */
function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow = window
  attachRendererDebugLogging(window)
  const devServerUrl = process.env.VITE_DEV_SERVER_URL

  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })
}

app.whenReady().then(() => {
  ipcMain.handle('vide:ping', () => {
    return 'Hello from the Electron main process.'
  })

  ipcMain.handle('vide:voice:start', async () => {
    await startVoiceSession()
  })

  ipcMain.on('vide:voice:chunk', (_event, payload: unknown) => {
    const chunk = coerceAudioChunk(payload)

    if (!chunk) {
      sendVoiceEvent({
        type: 'error',
        message: 'The renderer sent an invalid audio chunk.',
      })
      cancelVoiceSession()
      return
    }

    getSttSession().appendChunk(chunk)
  })

  ipcMain.handle('vide:voice:stop', async () => {
    return stopVoiceSession()
  })

  ipcMain.handle('vide:voice:cancel', () => {
    cancelVoiceSession()
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  cancelVoiceSession()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
