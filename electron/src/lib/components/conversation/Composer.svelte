<svelte:options runes={true} />

<script lang="ts">
  import {
    createVoiceComposerController,
    getVoiceButtonLabel,
    getVoiceStatusLabel,
  } from '../../voice/voice-composer-controller.svelte'

  let {
    disabled = false,
    onSubmit,
  }: {
    disabled?: boolean
    onSubmit: (value: string) => boolean | Promise<boolean>
  } = $props()

  const voiceComposer = createVoiceComposerController()
  let textareaElement: HTMLTextAreaElement | null = null
  let lastAppliedSelectionRevision = 0

  /**
   * Sends the current composer contents when input is allowed.
   */
  async function submit(): Promise<void> {
    const value = voiceComposer.draft.trim()

    if (!value || disabled || voiceComposer.voiceState !== 'idle' || voiceComposer.isStartingVoice) {
      return
    }

    const wasSubmitted = await onSubmit(value)

    if (wasSubmitted) {
      voiceComposer.setDraft('')
    }
  }

  /**
   * Submits on Enter while preserving Shift+Enter for new lines.
   */
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  /**
   * Keeps the local draft in sync with textarea edits.
   */
  function handleDraftInput(event: Event): void {
    voiceComposer.setDraft((event.currentTarget as HTMLTextAreaElement).value)
  }

  $effect(() => {
    voiceComposer.setDisabled(disabled)
  })

  $effect(() => {
    voiceComposer.connect()

    return () => {
      void voiceComposer.destroy()
    }
  })

  $effect(() => {
    if (
      !textareaElement ||
      voiceComposer.voiceState !== 'idle' ||
      voiceComposer.selectionStart === null ||
      voiceComposer.selectionEnd === null ||
      voiceComposer.selectionRevision === lastAppliedSelectionRevision
    ) {
      return
    }

    lastAppliedSelectionRevision = voiceComposer.selectionRevision
    textareaElement.focus()
    textareaElement.setSelectionRange(voiceComposer.selectionEnd, voiceComposer.selectionEnd)
  })
</script>

<div class="border-t border-[var(--color-border)] px-4 py-4 sm:px-6">
  <div class="mx-auto flex w-full max-w-4xl flex-col gap-3">
    <div class="flex gap-3">
      <textarea
        bind:this={textareaElement}
        value={voiceComposer.draft}
        class="min-h-28 flex-1 resize-none rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-3 text-sm leading-6 text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)]"
        placeholder="Type to talk to VIde..."
        disabled={disabled || voiceComposer.voiceState !== 'idle' || voiceComposer.isStartingVoice}
        oninput={handleDraftInput}
        onkeydown={handleKeydown}
      ></textarea>
      <div class="flex w-28 shrink-0 flex-col gap-2">
        <button
          type="button"
          class={`rounded-2xl border px-3 py-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            voiceComposer.voiceState === 'recording'
              ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accentContrast)]'
              : 'border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-muted)]'
          }`}
          disabled={disabled || voiceComposer.voiceState === 'processing'}
          onclick={() => void voiceComposer.handleVoiceClick(disabled)}
          onpointerdown={(event) => void voiceComposer.handleVoicePointerDown(event, disabled)}
          onpointerup={(event) => void voiceComposer.handleVoicePointerUp(event)}
          onpointercancel={() => void voiceComposer.handleVoicePointerCancel()}
        >
          {getVoiceButtonLabel(voiceComposer)}
        </button>
        <button
          type="button"
          class="rounded-2xl bg-[var(--color-accent)] px-3 py-3 text-sm font-semibold text-[var(--color-accentContrast)] transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
          disabled={
            disabled ||
            voiceComposer.voiceState !== 'idle' ||
            voiceComposer.isStartingVoice ||
            !voiceComposer.draft.trim()
          }
          onclick={() => void submit()}
        >
          Send
        </button>
      </div>
    </div>
    {#if voiceComposer.voiceError}
      <p class="text-xs text-[var(--color-accent)]">{voiceComposer.voiceError}</p>
    {:else if voiceComposer.voiceState !== 'idle'}
      <p class="text-xs text-[var(--color-muted)]">
        {#if voiceComposer.voiceState === 'recording' && voiceComposer.inputMode === 'toggle'}
          {getVoiceStatusLabel(voiceComposer)}: click Voice again to finish the draft.
        {:else if voiceComposer.voiceState === 'recording'}
          {getVoiceStatusLabel(voiceComposer)}: dictating into the text box.
        {:else}
          {getVoiceStatusLabel(voiceComposer)}: finishing the draft.
        {/if}
      </p>
    {:else}
      <p class="text-xs text-[var(--color-muted)]">
        {#if voiceComposer.inputMode === 'toggle'}
          Click Voice to start and stop dictation. Press Send or Enter to submit.
        {:else}
          Hold Voice to dictate into the text box. Release to finish. Press Send or Enter to submit.
        {/if}
      </p>
    {/if}
  </div>
</div>
