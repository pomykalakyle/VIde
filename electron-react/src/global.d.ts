export {}

import type { BackendConnectionInfo, BackendStatusSnapshot } from './lib/types/backend'
import type { VoiceBridgeEvent } from './lib/types/voice'

declare global {
  interface Window {
    videApi: {
      ping: () => Promise<string>
      startVoice: () => Promise<void>
      sendVoiceChunk: (samples: Float32Array) => void
      stopVoice: () => Promise<string>
      cancelVoice: () => Promise<void>
      getBackendConnectionInfo: () => BackendConnectionInfo
      getBackendStatus: () => Promise<BackendStatusSnapshot>
      startBackend: () => Promise<void>
      stopBackend: () => Promise<void>
      restartBackend: () => Promise<void>
      onVoiceEvent: (listener: (event: VoiceBridgeEvent) => void) => () => void
    }
  }
}
