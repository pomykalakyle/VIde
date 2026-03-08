<svelte:options runes={true} />

<script lang="ts">
  import AgentMessage from './AgentMessage.svelte'
  import UserMessage from './UserMessage.svelte'
  import type { ConversationEntry } from '../../types/conversation'

  let { entries = [] }: { entries?: ConversationEntry[] } = $props()
</script>

<div class="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
  <div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
    {#each entries as entry (entry.id)}
      {#if entry.role === 'user'}
        <UserMessage entry={entry} />
      {:else}
        <AgentMessage entry={entry} />
      {/if}
    {/each}
  </div>
</div>
