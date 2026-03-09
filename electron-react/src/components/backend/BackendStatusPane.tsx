import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  BackendContainerStatus,
  BackendHealthStatus,
  BackendOpenCodeStatus,
  BackendStatusSnapshot,
} from '../../lib/types/backend'

type BackendServerAction = 'start' | 'stop' | 'restart' | null

const statusPollIntervalMs = 2_000

/** Returns the human-readable label for one backend health state. */
function getBackendHealthLabel(status: BackendHealthStatus): string {
  if (status === 'healthy') {
    return 'Healthy'
  }

  if (status === 'starting') {
    return 'Starting'
  }

  if (status === 'unreachable') {
    return 'Unreachable'
  }

  return 'Stopped'
}

/** Returns the badge classes for one backend health state. */
function getBackendHealthTone(status: BackendHealthStatus): string {
  if (status === 'healthy') {
    return 'border-emerald-500/30 bg-emerald-500/12 text-emerald-300'
  }

  if (status === 'starting') {
    return 'border-sky-500/30 bg-sky-500/12 text-sky-300'
  }

  if (status === 'unreachable') {
    return 'border-rose-500/30 bg-rose-500/12 text-rose-300'
  }

  return 'border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-muted)]'
}

/** Returns the status-panel button label for one pending backend action. */
function getPendingActionLabel(action: BackendServerAction): string {
  if (action === 'start') {
    return 'Starting server...'
  }

  if (action === 'stop') {
    return 'Stopping server...'
  }

  if (action === 'restart') {
    return 'Restarting server...'
  }

  return ''
}

/** Returns the display value for one optional backend metadata field. */
function formatOptionalMetadata(value: string | null | undefined): string {
  return value && value.length > 0 ? value : 'Unavailable'
}

/** Returns the human-readable label for one container lifecycle state. */
function getContainerStatusLabel(status: BackendContainerStatus): string {
  if (status === 'ready') {
    return 'Ready'
  }

  if (status === 'starting') {
    return 'Starting'
  }

  if (status === 'error') {
    return 'Error'
  }

  return 'Stopped'
}

/** Returns the human-readable label for one OpenCode lifecycle state. */
function getOpenCodeStatusLabel(status: BackendOpenCodeStatus): string {
  if (status === 'ready') {
    return 'Ready'
  }

  if (status === 'starting') {
    return 'Starting'
  }

  if (status === 'error') {
    return 'Error'
  }

  return 'Stopped'
}

/** Renders one label-value row inside the runtime status panel. */
function StatusRow({
  label,
  value,
}: {
  label: string
  value: string
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <p className="pt-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-muted)]">
        {label}
      </p>
      <p className="max-w-[65%] break-all text-right text-[var(--color-text)]">{value}</p>
    </div>
  )
}

/** Renders the runtime status panel with local server lifecycle controls. */
export function BackendStatusPane(): JSX.Element {
  const [snapshot, setSnapshot] = useState<BackendStatusSnapshot | null>(null)
  const [isCheckingStatus, setIsCheckingStatus] = useState(true)
  const [statusError, setStatusError] = useState('')
  const [pendingAction, setPendingAction] = useState<BackendServerAction>(null)
  const [actionError, setActionError] = useState('')
  const hasLoadedStatusRef = useRef(false)

  /** Refreshes the backend status snapshot from the Electron bridge. */
  const refreshStatus = useCallback(async (): Promise<void> => {
    if (!hasLoadedStatusRef.current) {
      setIsCheckingStatus(true)
    }

    try {
      const nextSnapshot = await window.videApi.getBackendStatus()
      setSnapshot(nextSnapshot)
      setStatusError('')
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'The backend status check failed.')
    } finally {
      hasLoadedStatusRef.current = true
      setIsCheckingStatus(false)
    }
  }, [])

  useEffect(() => {
    let isDisposed = false

    /** Runs one guarded status refresh while the panel is still mounted. */
    async function refreshWhileMounted(): Promise<void> {
      if (isDisposed) {
        return
      }

      await refreshStatus()
    }

    void refreshWhileMounted()
    const intervalId = window.setInterval(() => {
      void refreshWhileMounted()
    }, statusPollIntervalMs)

    return () => {
      isDisposed = true
      window.clearInterval(intervalId)
    }
  }, [refreshStatus])

  /** Runs one backend lifecycle action through the Electron bridge. */
  const runServerAction = useCallback(
    async (action: Exclude<BackendServerAction, null>): Promise<void> => {
      if (pendingAction) {
        return
      }

      setPendingAction(action)
      setActionError('')

      try {
        if (action === 'start') {
          await window.videApi.startBackend()
        } else if (action === 'stop') {
          await window.videApi.stopBackend()
        } else {
          await window.videApi.restartBackend()
        }

        await refreshStatus()
      } catch (error) {
        setActionError(error instanceof Error ? error.message : `The ${action} request failed.`)
        await refreshStatus()
      } finally {
        setPendingAction(null)
      }
    },
    [pendingAction, refreshStatus],
  )

  const currentStatus = snapshot?.healthStatus ?? 'stopped'
  const statusLabel = isCheckingStatus ? 'Checking...' : getBackendHealthLabel(currentStatus)
  const statusTone = isCheckingStatus
    ? 'border-sky-500/30 bg-sky-500/12 text-sky-300'
    : getBackendHealthTone(currentStatus)
  const displayedError =
    actionError || statusError || snapshot?.error || snapshot?.containerError || snapshot?.openCodeError || ''
  const openCodeHealthUrl = snapshot?.containerBaseUrl
    ? `${snapshot.containerBaseUrl}/global/health`
    : null

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-[var(--color-bg)] p-5 text-[var(--color-text)]">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Runtime Status</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Local server, container, and OpenCode controls for development.
            </p>
          </div>
          <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusTone}`}>
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 text-sm">
        <div className="grid gap-3">
          <p className="text-sm font-semibold text-[var(--color-text)]">Session Manager</p>
          <StatusRow label="Status" value={statusLabel} />
          <StatusRow label="Health endpoint" value={snapshot?.healthUrl ?? 'Loading...'} />
          <StatusRow
            label="Process"
            value={
              snapshot?.processId === null || snapshot?.processId === undefined
                ? 'Not running'
                : `PID ${snapshot.processId}`
            }
          />
          <StatusRow label="Started at" value={formatOptionalMetadata(snapshot?.startedAt)} />
          <StatusRow label="Instance ID" value={formatOptionalMetadata(snapshot?.instanceId)} />
          <StatusRow label="Server hash" value={formatOptionalMetadata(snapshot?.serverTypeHash)} />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <div className="grid gap-3">
            <p className="text-sm font-semibold text-[var(--color-text)]">Docker Container</p>
            <StatusRow
              label="Status"
              value={snapshot ? getContainerStatusLabel(snapshot.containerStatus) : 'Loading...'}
            />
            <StatusRow
              label="Started at"
              value={formatOptionalMetadata(snapshot?.containerStartedAt)}
            />
            <StatusRow label="Name" value={formatOptionalMetadata(snapshot?.containerName)} />
            <StatusRow label="ID" value={formatOptionalMetadata(snapshot?.containerId)} />
            <StatusRow label="Image" value={formatOptionalMetadata(snapshot?.containerImage)} />
            <StatusRow label="Base URL" value={formatOptionalMetadata(snapshot?.containerBaseUrl)} />
          </div>
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <div className="grid gap-3">
            <p className="text-sm font-semibold text-[var(--color-text)]">OpenCode</p>
            <StatusRow
              label="Status"
              value={snapshot ? getOpenCodeStatusLabel(snapshot.openCodeStatus) : 'Loading...'}
            />
            <StatusRow label="Version" value={formatOptionalMetadata(snapshot?.openCodeVersion)} />
            <StatusRow label="Health endpoint" value={formatOptionalMetadata(openCodeHealthUrl)} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <button
          type="button"
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void runServerAction('start')}
          disabled={pendingAction !== null || !snapshot?.supportsStart}
        >
          Start server
        </button>
        <button
          type="button"
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void runServerAction('stop')}
          disabled={pendingAction !== null || !snapshot?.supportsStop}
        >
          Stop server
        </button>
        <button
          type="button"
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void runServerAction('restart')}
          disabled={pendingAction !== null || !snapshot?.supportsRestart}
        >
          Restart server
        </button>
      </div>

      {pendingAction ? (
        <div className="rounded-2xl border border-sky-500/30 bg-sky-500/12 px-4 py-3 text-sm text-sky-200">
          {getPendingActionLabel(pendingAction)}
        </div>
      ) : null}

      {displayedError ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/12 px-4 py-3 text-sm text-rose-200">
          {displayedError}
        </div>
      ) : null}
    </section>
  )
}
