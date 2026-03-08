<svelte:options runes={true} />

<script lang="ts">
  import Composer from './Composer.svelte'
  import TranscriptList from './TranscriptList.svelte'
  import { sessionState } from '../../session/session-state.svelte'

  const session = sessionState

  /**
   * Submits one finalized composer value to the server-owned session.
   */
  async function handleSubmit(value: string): Promise<boolean> {
    return session.submitUserMessage(value)
  }

</script>

<section class="flex h-full min-h-0 flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
  <TranscriptList entries={session.entries} />
  <Composer disabled={session.isResponding} onSubmit={handleSubmit} />
</section>
