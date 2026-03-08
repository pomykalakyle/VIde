<svelte:options runes={true} />

<script lang="ts">
  import DockviewHost from './DockviewHost.svelte'
  import { sessionState } from '../../session/session-state.svelte'
  import { theme } from '../../theme/theme-state.svelte'
  import { isThemeName, themeLabels, themeNames } from '../../theme/themes'

  const session = sessionState

  let openConversationPanel: (() => void) | null = null
  let openBackendStatusPanel: (() => void) | null = null

  /** Stores the latest chat-panel opener registered by the Dockview host. */
  function handleOpenConversationRegistration(opener: (() => void) | null): void {
    openConversationPanel = opener
  }

  /** Stores the latest backend-status-panel opener registered by the Dockview host. */
  function handleOpenBackendStatusRegistration(opener: (() => void) | null): void {
    openBackendStatusPanel = opener
  }

  /** Requests that the Dockview host focus or recreate the chat panel. */
  function handleOpenChat(): void {
    openConversationPanel?.()
  }

  /** Requests that the Dockview host focus or recreate the backend status panel. */
  function handleOpenBackendStatus(): void {
    openBackendStatusPanel?.()
  }

  /** Updates the persisted theme preset from the selector. */
  function handleThemeChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value

    if (isThemeName(value)) {
      theme.set(value)
    }
  }
</script>

<section class="flex h-screen min-h-0 flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
  <header class="border-b border-[var(--color-border)] px-4 py-4 sm:px-6">
    <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div class="flex min-w-0 flex-col gap-1">
        <p class="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-accent)]">
          Workspace
        </p>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 class="text-lg font-semibold text-[var(--color-text)]">VIde</h1>
          <p class="text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
            Session {session.sessionId} · {session.connectionStatus}
          </p>
        </div>
        <p class="text-sm text-[var(--color-muted)]">
          Chat now lives in a dockable panel inside the workspace.
        </p>
        {#if session.error}
          <p class="text-sm text-[var(--color-accent)]">{session.error}</p>
        {/if}
      </div>

      <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div class="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            class="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)]"
            onclick={handleOpenChat}
          >
            Open chat
          </button>
          <button
            type="button"
            class="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)]"
            onclick={handleOpenBackendStatus}
          >
            Open backend status
          </button>
        </div>

        <label class="flex min-w-44 flex-col gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-muted)]">
          Theme
          <select
            class="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm font-medium normal-case tracking-normal text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)]"
            value={theme.current}
            onchange={handleThemeChange}
          >
            {#each themeNames as themeName (themeName)}
              <option value={themeName}>{themeLabels[themeName]}</option>
            {/each}
          </select>
        </label>
      </div>
    </div>
  </header>

  <div class="min-h-0 flex-1">
    <DockviewHost
      registerOpenConversationPanel={handleOpenConversationRegistration}
      registerOpenBackendStatusPanel={handleOpenBackendStatusRegistration}
    />
  </div>
</section>
