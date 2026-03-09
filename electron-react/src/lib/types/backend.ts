/** Represents the connection URLs for one backend managed by Electron. */
export interface BackendConnectionInfo {
  baseUrl: string
  healthUrl: string
  sessionServerUrl: string
}

/** Represents one backend health state surfaced by the Electron supervisor. */
export type BackendHealthStatus = 'stopped' | 'starting' | 'healthy' | 'unreachable'

/** Represents one backend status snapshot returned to the Electron renderer. */
export interface BackendStatusSnapshot extends BackendConnectionInfo {
  error: string
  healthStatus: BackendHealthStatus
  instanceId: string | null
  managedByApp: boolean
  processId: number | null
  serverType: string | null
  serverTypeHash: string | null
  startedAt: string | null
  supportsRestart: boolean
  supportsStart: boolean
  supportsStop: boolean
}
