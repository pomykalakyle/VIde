import { contextBridge, ipcRenderer } from 'electron'

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

/**
 * Exposes the minimal Electron API to the renderer.
 */
contextBridge.exposeInMainWorld('videApi', {
  ping: () => ipcRenderer.invoke('vide:ping') as Promise<string>,
  startVoice,
  sendVoiceChunk,
  stopVoice,
  cancelVoice,
  onVoiceEvent,
})
