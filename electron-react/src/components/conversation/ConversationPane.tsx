import { useEffect, useRef, useState } from 'react'

import { useSessionChat } from '../../lib/use-session-chat'
import { ConversationComposer } from './ConversationComposer'
import { ConversationErrorBanner } from './ConversationErrorBanner'
import { ConversationHeader } from './ConversationHeader'
import { ConversationTranscript } from './ConversationTranscript'

/** Renders the single-agent chat panel backed by the Bun WebSocket placeholder backend. */
export function ConversationPane(): JSX.Element {
  const [composerValue, setComposerValue] = useState('')
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)
  const {
    clearConversation,
    connectionStatus,
    dismissError,
    entries,
    errorMessage,
    isSending,
    reconnect,
    sendMessage,
  } = useSessionChat()

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    })
  }, [entries])

  /** Stores the latest composer text for the live chat pane. */
  function updateComposerValue(value: string): void {
    setComposerValue(value)
  }

  /** Clears the local transcript view and resets the composer field. */
  function clearConversationView(): void {
    setComposerValue('')
    clearConversation()
  }

  /** Sends the current composer text to the live chat socket. */
  function submitComposerMessage(): void {
    const nextMessage = composerValue.trim()

    if (!nextMessage) {
      return
    }

    setComposerValue('')
    sendMessage(nextMessage)
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 bg-[var(--color-bg)] p-5 text-[var(--color-text)]">
      <ConversationHeader connectionStatus={connectionStatus} />

      {errorMessage ? (
        <ConversationErrorBanner message={errorMessage} onDismiss={dismissError} />
      ) : null}

      <ConversationTranscript entries={entries} endRef={transcriptEndRef} />

      <ConversationComposer
        canSend={connectionStatus === 'connected'}
        connectionStatus={connectionStatus}
        value={composerValue}
        isSending={isSending}
        onClearChat={clearConversationView}
        onReconnect={reconnect}
        onSubmit={submitComposerMessage}
        onValueChange={updateComposerValue}
      />
    </section>
  )
}
