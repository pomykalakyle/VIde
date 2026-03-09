/** Represents the connection URLs for one backend managed by Electron. */
export interface BackendConnectionInfo {
  baseUrl: string
  healthUrl: string
  sessionServerUrl: string
}

/** Represents one backend health state surfaced by the Electron supervisor. */
export type BackendHealthStatus = 'stopped' | 'starting' | 'healthy' | 'unreachable'

/** Represents one session-container lifecycle state surfaced by the backend. */
export type BackendContainerStatus = 'starting' | 'ready' | 'stopped' | 'error'

/** Represents one OpenCode lifecycle state surfaced by the backend. */
export type BackendOpenCodeStatus = 'starting' | 'ready' | 'stopped' | 'error'

/** Represents one backend status snapshot returned to the Electron renderer. */
export interface BackendStatusSnapshot extends BackendConnectionInfo {
  containerBaseUrl: string | null
  containerError: string
  containerId: string | null
  containerImage: string | null
  containerName: string | null
  containerStartedAt: string | null
  containerStatus: BackendContainerStatus
  error: string
  healthStatus: BackendHealthStatus
  instanceId: string | null
  managedByApp: boolean
  openCodeError: string
  openCodeStatus: BackendOpenCodeStatus
  openCodeVersion: string | null
  processId: number | null
  serverType: string | null
  serverTypeHash: string | null
  startedAt: string | null
  supportsRestart: boolean
  supportsStart: boolean
  supportsStop: boolean
}
