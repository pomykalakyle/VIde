<svelte:options runes={true} />

<script lang="ts">
  import ConversationPane from './lib/components/conversation/ConversationPane.svelte'
  import { sessionState } from './lib/session/session-state.svelte'

  $effect(() => {
    void sessionState.connect()

    return () => {
      sessionState.destroy()
    }
  })
</script>

<svelte:head>
  <title>VIde</title>
</svelte:head>

<ConversationPane />
