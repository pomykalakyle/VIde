export {}

import type { VoiceBridgeEvent } from './lib/types/voice'

declare global {
  interface Window {
    videApi: {
      ping: () => Promise<string>
      startVoice: () => Promise<void>
      sendVoiceChunk: (samples: Float32Array) => void
      stopVoice: () => Promise<string>
      cancelVoice: () => Promise<void>
      onVoiceEvent: (listener: (event: VoiceBridgeEvent) => void) => () => void
    }
  }
}
