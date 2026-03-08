const targetSampleRate = 16_000
const processorBufferSize = 4_096

/** Represents an active microphone capture session in the renderer. */
export interface MicrophoneCaptureSession {
  stop: () => Promise<void>
}

/** Downsamples browser audio to the 16 kHz mono PCM expected by the spike. */
function downsampleToTargetRate(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === targetSampleRate) {
    return new Float32Array(input)
  }

  const sampleRateRatio = inputSampleRate / targetSampleRate
  const outputLength = Math.round(input.length / sampleRateRatio)
  const output = new Float32Array(outputLength)

  let outputIndex = 0
  let inputIndex = 0

  while (outputIndex < outputLength) {
    const nextInputIndex = Math.round((outputIndex + 1) * sampleRateRatio)
    let accumulator = 0
    let count = 0

    while (inputIndex < nextInputIndex && inputIndex < input.length) {
      accumulator += input[inputIndex]
      inputIndex += 1
      count += 1
    }

    output[outputIndex] = count > 0 ? accumulator / count : 0
    outputIndex += 1
  }

  return output
}

/** Starts microphone capture and emits 16 kHz mono PCM chunks to the callback. */
export async function startMicrophoneCapture(
  onChunk: (samples: Float32Array) => void,
): Promise<MicrophoneCaptureSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser session does not support microphone capture.')
  }

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

  const audioContext = new AudioContext()
  await audioContext.resume()

  const sourceNode = audioContext.createMediaStreamSource(mediaStream)
  const processorNode = audioContext.createScriptProcessor(processorBufferSize, 1, 1)
  const silenceNode = audioContext.createGain()
  silenceNode.gain.value = 0

  processorNode.onaudioprocess = (event) => {
    const inputSamples = event.inputBuffer.getChannelData(0)
    const downsampledSamples = downsampleToTargetRate(inputSamples, audioContext.sampleRate)

    if (downsampledSamples.length > 0) {
      onChunk(downsampledSamples)
    }
  }

  sourceNode.connect(processorNode)
  processorNode.connect(silenceNode)
  silenceNode.connect(audioContext.destination)

  return {
    /** Stops microphone capture and releases all browser audio resources. */
    stop: async (): Promise<void> => {
      processorNode.onaudioprocess = null
      processorNode.disconnect()
      silenceNode.disconnect()
      sourceNode.disconnect()

      for (const track of mediaStream.getTracks()) {
        track.stop()
      }

      await audioContext.close()
    },
  }
}
