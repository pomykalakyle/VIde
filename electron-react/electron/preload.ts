import { contextBridge, ipcRenderer } from 'electron'

import type { BackendConnectionInfo, BackendStatusSnapshot } from '../src/lib/types/backend'
import type { VoiceBridgeEvent } from '../src/lib/types/voice'

/** Starts a new speech-to-text session in the main process. */
function startVoice(): Promise<void> {
  return ipcRenderer.invoke('vide:voice:start') as Promise<void>
}

/** Sends one PCM audio chunk from the renderer to the main process. */
function sendVoiceChunk(samples: Float32Array): void {
  ipcRenderer.send('vide:voice:chunk', samples)
}

/** Finalizes the current speech-to-text session in the main process. */
function stopVoice(): Promise<string> {
  return ipcRenderer.invoke('vide:voice:stop') as Promise<string>
}

/** Cancels the current speech-to-text session in the main process. */
function cancelVoice(): Promise<void> {
  return ipcRenderer.invoke('vide:voice:cancel') as Promise<void>
}

/** Returns the backend connection URLs chosen by the Electron supervisor. */
function getBackendConnectionInfo(): BackendConnectionInfo {
  return ipcRenderer.sendSync('vide:backend:connection-info') as BackendConnectionInfo
}

/** Returns the latest backend status snapshot from the main process bridge. */
function getBackendStatus(): Promise<BackendStatusSnapshot> {
  return ipcRenderer.invoke('vide:backend:status') as Promise<BackendStatusSnapshot>
}

/** Requests that the Electron supervisor start the managed Bun backend. */
function startBackend(): Promise<void> {
  return ipcRenderer.invoke('vide:backend:start') as Promise<void>
}

/** Requests that the Electron supervisor stop the managed Bun backend. */
function stopBackend(): Promise<void> {
  return ipcRenderer.invoke('vide:backend:stop') as Promise<void>
}

/** Requests that the Electron supervisor restart the managed Bun backend. */
function restartBackend(): Promise<void> {
  return ipcRenderer.invoke('vide:backend:restart') as Promise<void>
}

/** Registers a renderer listener for main-process voice events. */
function onVoiceEvent(listener: (event: VoiceBridgeEvent) => void): () => void {
  const wrappedListener = (_event: Electron.IpcRendererEvent, event: VoiceBridgeEvent) => {
    listener(event)
  }

  ipcRenderer.on('vide:voice:event', wrappedListener)

  return () => {
    ipcRenderer.removeListener('vide:voice:event', wrappedListener)
  }
}

/** Exposes the minimal Electron API to the renderer. */
contextBridge.exposeInMainWorld('videApi', {
  ping: () => ipcRenderer.invoke('vide:ping') as Promise<string>,
  startVoice,
  sendVoiceChunk,
  stopVoice,
  cancelVoice,
  getBackendConnectionInfo,
  getBackendStatus,
  startBackend,
  stopBackend,
  restartBackend,
  onVoiceEvent,
})
