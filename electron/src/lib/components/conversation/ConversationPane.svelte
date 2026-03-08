<svelte:options runes={true} />

<script lang="ts">
  import Composer from './Composer.svelte'
  import TranscriptList from './TranscriptList.svelte'
  import { sessionState } from '../../session/session-state.svelte'
  import { theme } from '../../theme/theme-state.svelte'
  import { isThemeName, themeLabels, themeNames } from '../../theme/themes'

  const session = sessionState

  /**
   * Submits one finalized composer value to the server-owned session.
   */
  async function handleSubmit(value: string): Promise<boolean> {
    return session.submitUserMessage(value)
  }

  /**
   * Updates the persisted theme preset from the selector.
   */
  function handleThemeChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value

    if (isThemeName(value)) {
      theme.set(value)
    }
  }
</script>

<section class="flex min-h-screen flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
  <header class="border-b border-[var(--color-border)] px-4 py-4 sm:px-6">
    <div class="mx-auto flex w-full max-w-4xl flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div class="flex flex-col gap-1">
        <p class="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-accent)]">
          Conversation
        </p>
        <h1 class="text-lg font-semibold text-[var(--color-text)]">Transcript</h1>
        <p class="text-sm text-[var(--color-muted)]">
          Typed and voice input now flow through the server-backed conversation path.
        </p>
        <p class="text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
          Session {session.sessionId} · {session.connectionStatus}
        </p>
        {#if session.error}
          <p class="text-sm text-[var(--color-accent)]">{session.error}</p>
        {/if}
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
  </header>

  <TranscriptList entries={session.entries} />
  <Composer disabled={session.isResponding} onSubmit={handleSubmit} />
</section>
