<svelte:options runes={true} />

<script lang="ts">
  import type { AgentConversationEntry } from '../../types/conversation'

  let { entry }: { entry: AgentConversationEntry } = $props()
</script>

<article class="w-full max-w-4xl">
  <div class="border-l-2 pl-4" style="border-color: var(--color-accent);">
    <p class="whitespace-pre-wrap leading-7 text-[var(--color-text)]">{entry.content}</p>
  </div>
</article>
