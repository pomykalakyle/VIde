import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  ClientSessionMessage,
  ConversationEntry,
  RenderedConversationEntry,
  ServerSessionMessage,
} from './types/session'

/** Represents the live connection state for the renderer chat socket. */
export type SessionConnectionStatus = 'connecting' | 'connected' | 'disconnected'

/** Represents the state and actions exposed by the live chat session hook. */
export interface UseSessionChatResult {
  clearConversation: () => void
  connectionStatus: SessionConnectionStatus
  dismissError: () => void
  entries: RenderedConversationEntry[]
  errorMessage: string
  isSending: boolean
  reconnect: () => void
  sendMessage: (text: string) => void
}

/** Returns one browser-generated identifier for a local chat entry. */
function createEntryId(): string {
  return crypto.randomUUID()
}

/** Returns one rendered transcript entry for the chat UI. */
function createRenderedConversationEntry(
  role: ConversationEntry['role'],
  content: string,
  status: RenderedConversationEntry['status'],
): RenderedConversationEntry {
  return {
    id: createEntryId(),
    role,
    content,
    status,
  }
}

/** Sends one typed client message across the active chat socket. */
function sendClientSessionMessage(socket: WebSocket, message: ClientSessionMessage): void {
  socket.send(JSON.stringify(message))
}

/** Returns one parsed server session message from the active chat socket. */
function parseServerSessionMessage(data: unknown): ServerSessionMessage {
  if (typeof data !== 'string') {
    throw new Error('The chat socket only accepts text messages from the server.')
  }

  const parsedMessage = JSON.parse(data) as Partial<ServerSessionMessage> & {
    entry?: unknown
    message?: unknown
    type?: unknown
  }

  if (parsedMessage.type === 'conversation_entry') {
    const entry = parsedMessage.entry as Partial<ConversationEntry> | undefined

    if (
      !entry ||
      typeof entry.id !== 'string' ||
      (entry.role !== 'user' && entry.role !== 'assistant') ||
      typeof entry.content !== 'string'
    ) {
      throw new Error('The backend sent an invalid conversation entry.')
    }

    return {
      type: 'conversation_entry',
      entry: {
        id: entry.id,
        role: entry.role,
        content: entry.content,
      },
    }
  }

  if (parsedMessage.type === 'session_error') {
    if (typeof parsedMessage.message !== 'string') {
      throw new Error('The backend sent an invalid session error.')
    }

    return {
      type: 'session_error',
      message: parsedMessage.message,
    }
  }

  throw new Error('The backend sent an unsupported chat socket message.')
}

/** Returns one transcript update with the current pending reply replaced. */
function replacePendingEntry(
  entries: RenderedConversationEntry[],
  pendingEntryId: string | null,
  replacementEntry: RenderedConversationEntry,
): RenderedConversationEntry[] {
  if (!pendingEntryId) {
    return [...entries, replacementEntry]
  }

  return entries.map((entry) => (entry.id === pendingEntryId ? replacementEntry : entry))
}

/** Manages one live renderer chat socket backed by the Bun placeholder server. */
export function useSessionChat(): UseSessionChatResult {
  const [connectionStatus, setConnectionStatus] = useState<SessionConnectionStatus>('connecting')
  const [entries, setEntries] = useState<RenderedConversationEntry[]>([])
  const [errorMessage, setErrorMessage] = useState('')
  const [isSending, setIsSending] = useState(false)
  const awaitingReplyRef = useRef(false)
  const pendingEntryIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string>(crypto.randomUUID())
  const silentCloseSocketsRef = useRef<WeakSet<WebSocket>>(new WeakSet())
  const socketRef = useRef<WebSocket | null>(null)

  /** Replaces the current pending assistant entry with one final transcript entry. */
  const resolvePendingEntry = useCallback((replacementEntry: RenderedConversationEntry): void => {
    setEntries((currentEntries) =>
      replacePendingEntry(currentEntries, pendingEntryIdRef.current, replacementEntry),
    )
    awaitingReplyRef.current = false
    pendingEntryIdRef.current = null
    setIsSending(false)
  }, [])

  /** Creates a new WebSocket connection and joins the current session. */
  const reconnect = useCallback((): void => {
    const existingSocket = socketRef.current

    if (awaitingReplyRef.current) {
      resolvePendingEntry(
        createRenderedConversationEntry(
          'assistant',
          'The previous chat request was interrupted while the socket reconnected.',
          'error',
        ),
      )
    }

    if (existingSocket) {
      silentCloseSocketsRef.current.add(existingSocket)
      existingSocket.close()
    }

    setConnectionStatus('connecting')
    setErrorMessage('')
    const { sessionServerUrl } = window.videApi.getBackendConnectionInfo()
    const socket = new WebSocket(sessionServerUrl)
    socketRef.current = socket

    socket.addEventListener('open', () => {
      setConnectionStatus('connected')

      try {
        sendClientSessionMessage(socket, {
          type: 'connect',
          sessionId: sessionIdRef.current,
        })
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : 'The chat socket could not join the session.',
        )
      }
    })

    socket.addEventListener('message', (event) => {
      try {
        const message = parseServerSessionMessage(event.data)

        if (message.type === 'conversation_entry') {
          resolvePendingEntry({
            ...message.entry,
            status: 'complete',
          })
          return
        }

        setErrorMessage(message.message)
        resolvePendingEntry(
          createRenderedConversationEntry('assistant', message.message, 'error'),
        )
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : 'The chat socket returned an unreadable reply.',
        )
      }
    })

    socket.addEventListener('close', () => {
      const wasSilentClose = silentCloseSocketsRef.current.has(socket)
      silentCloseSocketsRef.current.delete(socket)

      if (socketRef.current === socket) {
        socketRef.current = null
      }

      if (wasSilentClose) {
        return
      }

      setConnectionStatus('disconnected')

      if (awaitingReplyRef.current) {
        setErrorMessage('The chat socket disconnected before the backend replied.')
        resolvePendingEntry(
          createRenderedConversationEntry(
            'assistant',
            'The chat socket disconnected before the backend replied.',
            'error',
          ),
        )
      }
    })

    socket.addEventListener('error', () => {
      setErrorMessage('The chat socket encountered an unexpected error.')
    })
  }, [resolvePendingEntry])

  useEffect(() => {
    reconnect()

    return () => {
      if (!socketRef.current) {
        return
      }

      silentCloseSocketsRef.current.add(socketRef.current)
      socketRef.current.close()
      socketRef.current = null
    }
  }, [reconnect])

  /** Clears the visible transcript and the current error banner. */
  const clearConversation = useCallback((): void => {
    awaitingReplyRef.current = false
    pendingEntryIdRef.current = null
    setEntries([])
    setErrorMessage('')
    setIsSending(false)
  }, [])

  /** Dismisses the current error banner without changing the transcript. */
  const dismissError = useCallback((): void => {
    setErrorMessage('')
  }, [])

  /** Sends one user message to the backend and waits for a socket reply. */
  const sendMessage = useCallback(
    (text: string): void => {
      const trimmedText = text.trim()

      if (!trimmedText || isSending) {
        return
      }

      const socket = socketRef.current

      if (!socket || socket.readyState !== WebSocket.OPEN) {
        setErrorMessage('The chat socket is not connected yet.')
        return
      }

      const userEntry = createRenderedConversationEntry('user', trimmedText, 'complete')
      awaitingReplyRef.current = true
      pendingEntryIdRef.current = null
      setEntries((currentEntries) => [...currentEntries, userEntry])
      setErrorMessage('')
      setIsSending(true)

      try {
        sendClientSessionMessage(socket, {
          type: 'user_message',
          sessionId: sessionIdRef.current,
          text: trimmedText,
        })
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'The user message could not be sent.')
        resolvePendingEntry(
          createRenderedConversationEntry(
            'assistant',
            'The user message could not be sent to the backend.',
            'error',
          ),
        )
      }
    },
    [isSending, resolvePendingEntry],
  )

  return {
    clearConversation,
    connectionStatus,
    dismissError,
    entries,
    errorMessage,
    isSending,
    reconnect,
    sendMessage,
  }
}
