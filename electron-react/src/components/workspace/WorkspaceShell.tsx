import { useCallback, useEffect, useState } from 'react'

import { subscribeToWorkspaceChangedEvent } from '../../lib/workspace-events'
import type { WorkspaceRegistrySnapshot } from '../../lib/types/workspace'
import { DockviewHost } from './DockviewHost'

/** Renders the top-level workspace shell for the React migration app. */
export function WorkspaceShell(): JSX.Element {
  const [openConversationPanel, setOpenConversationPanel] = useState<(() => void) | null>(null)
  const [openBackendStatusPanel, setOpenBackendStatusPanel] = useState<(() => void) | null>(null)
  const [openSettingsPanel, setOpenSettingsPanel] = useState<(() => void) | null>(null)
  const [openWorkspaceManagerPanel, setOpenWorkspaceManagerPanel] = useState<(() => void) | null>(null)
  const [workspaceSummary, setWorkspaceSummary] = useState<WorkspaceRegistrySnapshot | null>(null)

  useEffect(() => {
    let isDisposed = false

    /** Loads the latest workspace summary for the shell header. */
    async function loadWorkspaceSummary(): Promise<void> {
      try {
        const nextSummary = await window.videApi.getWorkspaceSummary()

        if (!isDisposed) {
          setWorkspaceSummary(nextSummary)
        }
      } catch {
        if (!isDisposed) {
          setWorkspaceSummary(null)
        }
      }
    }

    void loadWorkspaceSummary()

    const unsubscribe = subscribeToWorkspaceChangedEvent((nextSummary) => {
      if (!isDisposed) {
        setWorkspaceSummary(nextSummary)
      }
    })

    return () => {
      isDisposed = true
      unsubscribe()
    }
  }, [])

  /** Stores the latest chat-panel opener registered by the Dockview host. */
  const handleOpenConversationRegistration = useCallback((opener: (() => void) | null): void => {
    setOpenConversationPanel(() => opener)
  }, [])

  /** Stores the latest runtime-status-panel opener registered by the Dockview host. */
  const handleOpenBackendStatusRegistration = useCallback((opener: (() => void) | null): void => {
    setOpenBackendStatusPanel(() => opener)
  }, [])

  /** Stores the latest settings-panel opener registered by the Dockview host. */
  const handleOpenSettingsRegistration = useCallback((opener: (() => void) | null): void => {
    setOpenSettingsPanel(() => opener)
  }, [])

  /** Stores the latest workspace-manager opener registered by the Dockview host. */
  const handleOpenWorkspaceManagerRegistration = useCallback((opener: (() => void) | null): void => {
    setOpenWorkspaceManagerPanel(() => opener)
  }, [])

  /** Requests that the Dockview host focus or recreate the chat panel. */
  const handleOpenChat = useCallback((): void => {
    openConversationPanel?.()
  }, [openConversationPanel])

  /** Requests that the Dockview host focus or recreate the runtime status panel. */
  const handleOpenBackendStatus = useCallback((): void => {
    openBackendStatusPanel?.()
  }, [openBackendStatusPanel])

  /** Requests that the Dockview host focus or recreate the settings panel. */
  const handleOpenSettings = useCallback((): void => {
    openSettingsPanel?.()
  }, [openSettingsPanel])

  /** Requests that the Dockview host focus or recreate the workspace manager panel. */
  const handleOpenWorkspaceManager = useCallback((): void => {
    openWorkspaceManagerPanel?.()
  }, [openWorkspaceManagerPanel])

  return (
    <section className="flex h-screen min-h-0 flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="border-b border-[var(--color-border)] px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-accent)]">
              Workspace
            </p>
            <h1 className="text-lg font-semibold text-[var(--color-text)]">VIde</h1>
            <p className="text-sm text-[var(--color-muted)]">
              {workspaceSummary?.activeWorkspace
                ? `${workspaceSummary.activeWorkspace.name} · ${workspaceSummary.activeWorkspace.hostPath}`
                : 'No workspace selected yet.'}
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)]"
                onClick={handleOpenWorkspaceManager}
              >
                Open workspaces
              </button>
              <button
                type="button"
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)]"
                onClick={handleOpenChat}
              >
                Open chat
              </button>
              <button
                type="button"
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)]"
                onClick={handleOpenBackendStatus}
              >
                Open runtime status
              </button>
              <button
                type="button"
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)]"
                onClick={handleOpenSettings}
              >
                Open settings
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <DockviewHost
          registerOpenConversationPanel={handleOpenConversationRegistration}
          registerOpenBackendStatusPanel={handleOpenBackendStatusRegistration}
          registerOpenSettingsPanel={handleOpenSettingsRegistration}
          registerOpenWorkspaceManagerPanel={handleOpenWorkspaceManagerRegistration}
        />
      </div>
    </section>
  )
}
