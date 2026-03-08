import { getDefaultSessionServerUrl } from './session-client'

export type BackendHealthStatus = 'idle' | 'checking' | 'healthy' | 'unreachable'

const healthCheckIntervalMs = 5000

/** Converts the default session WebSocket URL into the backend health-check URL. */
function getDefaultBackendHealthUrl(): string {
  const serverUrl = new URL(getDefaultSessionServerUrl())

  serverUrl.protocol = serverUrl.protocol === 'wss:' ? 'https:' : 'http:'
  serverUrl.pathname = '/health'
  serverUrl.search = ''
  serverUrl.hash = ''

  return serverUrl.toString()
}

/** Formats the current timestamp as the next recorded health-check time. */
function getCurrentTimestamp(): number {
  return Date.now()
}

/** Stores renderer-side reachability state for the Bun backend health endpoint. */
export class BackendStatusState {
  healthStatus = $state<BackendHealthStatus>('idle')
  error = $state('')
  lastCheckedAt = $state<number | null>(null)
  endpoint = getDefaultBackendHealthUrl()

  #pollTimer: ReturnType<typeof window.setInterval> | null = null
  #activeConsumers = 0

  /** Starts background health polling while at least one panel is using this state. */
  start(): void {
    this.#activeConsumers += 1

    if (this.#activeConsumers > 1) {
      return
    }

    void this.checkNow()
    this.#pollTimer = window.setInterval(() => {
      void this.checkNow()
    }, healthCheckIntervalMs)
  }

  /** Stops background health polling when no mounted panel still needs it. */
  stop(): void {
    this.#activeConsumers = Math.max(0, this.#activeConsumers - 1)

    if (this.#activeConsumers > 0) {
      return
    }

    if (this.#pollTimer !== null) {
      window.clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
  }

  /** Checks the Bun backend health endpoint once and stores the latest result. */
  async checkNow(): Promise<void> {
    this.healthStatus = this.lastCheckedAt === null ? 'checking' : this.healthStatus
    this.error = ''

    try {
      const response = await fetch(this.endpoint, {
        cache: 'no-store',
        mode: 'no-cors',
      })

      this.lastCheckedAt = getCurrentTimestamp()

      if (response.type === 'opaque') {
        this.healthStatus = 'healthy'
        return
      }

      if (!response.ok) {
        this.healthStatus = 'unreachable'
        this.error = `Health check returned ${response.status}.`
        return
      }

      const body = await response.text()

      if (body.trim() !== 'ok') {
        this.healthStatus = 'unreachable'
        this.error = 'Health check returned an unexpected response.'
        return
      }

      this.healthStatus = 'healthy'
    } catch (error) {
      this.lastCheckedAt = getCurrentTimestamp()
      this.healthStatus = 'unreachable'
      this.error = error instanceof Error ? error.message : 'The backend health check failed.'
    }
  }
}

/** Creates the shared renderer-side backend status state. */
export function createBackendStatusState(): BackendStatusState {
  return new BackendStatusState()
}

/** Represents the default backend status state shared across the renderer. */
export const backendStatusState = createBackendStatusState()
