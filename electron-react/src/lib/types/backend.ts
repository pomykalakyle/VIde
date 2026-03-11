/** Represents the connection URLs for one backend managed by Electron. */
export interface BackendConnectionInfo {
  baseUrl: string
  healthUrl: string
  sessionServerUrl: string
}

/** Represents one backend health state surfaced by the Electron supervisor. */
export type BackendHealthStatus = 'stopped' | 'starting' | 'healthy' | 'unreachable'

/** Represents one supported runtime execution mode surfaced by the backend. */
export type BackendExecutionMode = 'docker' | 'unsafe-host'

/** Represents one session-runtime lifecycle state surfaced by the backend. */
export type BackendRuntimeStatus = 'starting' | 'ready' | 'stopped' | 'error'

/** Represents one OpenCode lifecycle state surfaced by the backend. */
export type BackendOpenCodeStatus = 'starting' | 'ready' | 'stopped' | 'error'

/** Represents one Docker metadata block surfaced for Docker-backed runtimes. */
export interface BackendDockerContainerMetadata {
  id: string | null
  image: string
  name: string | null
}

/** Represents one backend status snapshot returned to the Electron renderer. */
export interface BackendStatusSnapshot extends BackendConnectionInfo {
  activeWorkspaceHostPath: string | null
  activeWorkspaceId: string | null
  activeWorkspaceName: string | null
  dockerContainer: BackendDockerContainerMetadata | null
  error: string
  executionMode: BackendExecutionMode | null
  healthStatus: BackendHealthStatus
  instanceId: string | null
  managedByApp: boolean
  openCodeError: string
  openCodeStatus: BackendOpenCodeStatus
  openCodeVersion: string | null
  processId: number | null
  runtimeBaseUrl: string | null
  runtimeError: string
  runtimeStartedAt: string | null
  runtimeStatus: BackendRuntimeStatus
  serverType: string | null
  serverTypeHash: string | null
  startedAt: string | null
  supportsRestart: boolean
  supportsStart: boolean
  supportsStop: boolean
}
