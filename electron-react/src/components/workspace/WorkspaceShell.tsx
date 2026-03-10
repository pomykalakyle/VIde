import { useCallback, useState } from 'react'

import { DockviewHost } from './DockviewHost'

/** Renders the top-level workspace shell for the React migration app. */
export function WorkspaceShell(): JSX.Element {
  const [openConversationPanel, setOpenConversationPanel] = useState<(() => void) | null>(null)
  const [openBackendStatusPanel, setOpenBackendStatusPanel] = useState<(() => void) | null>(null)
  const [openSettingsPanel, setOpenSettingsPanel] = useState<(() => void) | null>(null)

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
              React migration shell with blank workspace panes.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-3 sm:flex-row">
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
        />
      </div>
    </section>
  )
}
