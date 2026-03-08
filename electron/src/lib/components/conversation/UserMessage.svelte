<svelte:options runes={true} />

<script lang="ts">
  import type { UserConversationEntry } from '../../types/conversation'

  let { entry }: { entry: UserConversationEntry } = $props()
</script>

<article class="relative ml-auto w-full max-w-3xl rounded-3xl border border-[var(--color-border)] bg-[var(--color-panel)] px-5 py-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
  <span
    aria-hidden="true"
    class="absolute right-4 top-4 h-2.5 w-2.5 rounded-full bg-[var(--color-accent)]"
  ></span>
  <p class="whitespace-pre-wrap leading-7 text-[var(--color-text)]">{entry.content}</p>
</article>
