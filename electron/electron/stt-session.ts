import path from 'node:path'

import type { VoiceBridgeEvent, VoiceState } from '../src/lib/types/voice'

type SherpaWaveform = {
  sampleRate: number
  samples: Float32Array
}

type SherpaOfflineRecognizerResult = {
  text: string
}

type SherpaOfflineStream = {
  acceptWaveform: (waveform: SherpaWaveform) => void
}

type SherpaOfflineRecognizer = {
  createStream: () => SherpaOfflineStream
  decodeAsync: (stream: SherpaOfflineStream) => Promise<SherpaOfflineRecognizerResult>
}

type SherpaOfflineRecognizerFactory = {
  createAsync: (config: SherpaOfflineRecognizerConfig) => Promise<SherpaOfflineRecognizer>
}

type SherpaOnnxModule = {
  OfflineRecognizer: SherpaOfflineRecognizerFactory
}

type SherpaOfflineRecognizerConfig = {
  featConfig: {
    sampleRate: number
    featureDim: number
  }
  modelConfig: {
    moonshine: {
      preprocessor: string
      encoder: string
      uncachedDecoder: string
      cachedDecoder: string
    }
    tokens: string
    numThreads: number
    provider: 'cpu'
    debug: number
  }
}

type VoiceEventListener = (event: VoiceBridgeEvent) => void

const sherpaOnnx = require('sherpa-onnx-node') as SherpaOnnxModule
const targetSampleRate = 16_000
const minimumPartialDurationMs = 350
const partialDecodeDelayMs = 225

/** Returns the local spike path for the Moonshine tiny model directory. */
function getModelDirectory(): string {
  return path.join(process.cwd(), 'models', 'sherpa-onnx-moonshine-tiny-en-int8')
}

/** Returns the sherpa-onnx configuration for the Moonshine tiny spike model. */
function createRecognizerConfig(): SherpaOfflineRecognizerConfig {
  const modelDirectory = getModelDirectory()

  return {
    featConfig: {
      sampleRate: targetSampleRate,
      featureDim: 80,
    },
    modelConfig: {
      moonshine: {
        preprocessor: path.join(modelDirectory, 'preprocess.onnx'),
        encoder: path.join(modelDirectory, 'encode.int8.onnx'),
        uncachedDecoder: path.join(modelDirectory, 'uncached_decode.int8.onnx'),
        cachedDecoder: path.join(modelDirectory, 'cached_decode.int8.onnx'),
      },
      tokens: path.join(modelDirectory, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  }
}

/** Merges buffered audio chunks into one contiguous waveform. */
function mergeChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Float32Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }

  return merged
}

/** Normalizes recognizer text so partial and final comparisons stay stable. */
function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Represents one temporary speech-to-text session owned by the main process. */
export class SherpaSttSession {
  private readonly recognizerPromise: Promise<SherpaOfflineRecognizer>
  private readonly emitEvent: VoiceEventListener
  private chunks: Float32Array[] = []
  private latestPartial = ''
  private state: VoiceState = 'idle'
  private partialTimer: ReturnType<typeof setTimeout> | null = null
  private partialDecodeInFlight = false
  private lastDecodedSampleCount = 0

  /** Creates the shared recognizer instance and stores the renderer event sink. */
  constructor(emitEvent: VoiceEventListener) {
    this.emitEvent = emitEvent
    this.recognizerPromise = sherpaOnnx.OfflineRecognizer.createAsync(createRecognizerConfig())
  }

  /** Starts a new recording session and clears any previous buffered audio. */
  async start(): Promise<void> {
    await this.recognizerPromise

    this.clearPartialTimer()
    this.chunks = []
    this.latestPartial = ''
    this.lastDecodedSampleCount = 0
    this.setState('recording')
    this.emitEvent({ type: 'partial', text: '' })
  }

  /** Buffers renderer audio chunks and schedules the next partial decode. */
  appendChunk(samples: Float32Array): void {
    if (this.state !== 'recording' || samples.length === 0) {
      return
    }

    this.chunks.push(new Float32Array(samples))
    this.schedulePartialDecode()
  }

  /** Finalizes the current session and returns the committed transcript text. */
  async stop(): Promise<string> {
    if (this.state !== 'recording') {
      return ''
    }

    this.clearPartialTimer()
    this.setState('processing')

    const transcript = await this.decodeCurrentBuffer()

    if (transcript) {
      this.emitEvent({ type: 'final', text: transcript })
    }

    this.resetSession()
    return transcript
  }

  /** Cancels the current session without committing a final transcript. */
  cancel(): void {
    this.clearPartialTimer()
    this.resetSession()
    this.emitEvent({ type: 'partial', text: '' })
  }

  /** Clears any active timers and transitions the session back to idle. */
  private resetSession(): void {
    this.chunks = []
    this.latestPartial = ''
    this.lastDecodedSampleCount = 0
    this.partialDecodeInFlight = false
    this.setState('idle')
  }

  /** Emits a state transition only when the state actually changes. */
  private setState(state: VoiceState): void {
    if (this.state === state) {
      return
    }

    this.state = state
    this.emitEvent({ type: 'state', state })
  }

  /** Schedules a throttled partial decode once enough speech has been buffered. */
  private schedulePartialDecode(): void {
    if (this.partialTimer || this.partialDecodeInFlight || this.state !== 'recording') {
      return
    }

    const minimumSamples = Math.floor((targetSampleRate * minimumPartialDurationMs) / 1000)
    const bufferedSamples = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)

    if (bufferedSamples < minimumSamples) {
      return
    }

    this.partialTimer = setTimeout(() => {
      this.partialTimer = null
      void this.emitLatestPartial()
    }, partialDecodeDelayMs)
  }

  /** Decodes the current buffer and emits a new partial transcript if it changed. */
  private async emitLatestPartial(): Promise<void> {
    if (this.partialDecodeInFlight || this.state !== 'recording') {
      return
    }

    this.partialDecodeInFlight = true

    try {
      const bufferedSamples = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)

      if (bufferedSamples === 0) {
        return
      }

      const transcript = await this.decodeCurrentBuffer()

      if (this.state !== 'recording' || !transcript || transcript === this.latestPartial) {
        return
      }

      this.latestPartial = transcript
      this.lastDecodedSampleCount = bufferedSamples
      this.emitEvent({ type: 'partial', text: transcript })
    } catch (error) {
      this.emitRecognizerError(error)
      this.cancel()
    } finally {
      this.partialDecodeInFlight = false

      const bufferedSamples = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      if (this.state === 'recording' && bufferedSamples > this.lastDecodedSampleCount) {
        this.schedulePartialDecode()
      }
    }
  }

  /** Decodes the currently buffered waveform and returns normalized text. */
  private async decodeCurrentBuffer(): Promise<string> {
    const waveform = mergeChunks(this.chunks)

    if (waveform.length === 0) {
      return ''
    }

    const recognizer = await this.recognizerPromise
    const stream = recognizer.createStream()
    stream.acceptWaveform({
      sampleRate: targetSampleRate,
      samples: waveform,
    })

    const result = await recognizer.decodeAsync(stream)
    return normalizeTranscript(result.text)
  }

  /** Clears any queued partial decode before the session transitions. */
  private clearPartialTimer(): void {
    if (!this.partialTimer) {
      return
    }

    clearTimeout(this.partialTimer)
    this.partialTimer = null
  }

  /** Emits a renderer-safe recognizer error message. */
  private emitRecognizerError(error: unknown): void {
    const message = error instanceof Error ? error.message : 'Speech recognition failed.'
    this.emitEvent({ type: 'error', message })
  }
}
