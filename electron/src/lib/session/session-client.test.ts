import { expect, test } from 'bun:test'
import { SessionClient } from './session-client'
import {
  getAvailablePort,
  isAssistantConversationEntry,
  isSessionSnapshotMessage,
  isUserConversationEntry,
  startRustServer,
  stopRustServer,
  waitForServerMessage,
} from './session-test-utils'

/** Verifies the client starts live Rust, connects, receives a snapshot, submits a message, and gets appended transcript events back. */
test(
  'session client exchanges snapshot and append events with the live Rust backend',
  async () => {
    const port = await getAvailablePort()
    const serverProcess = await startRustServer(port)
    const client = new SessionClient({
      sessionId: 'local-dev',
      url: `ws://127.0.0.1:${port}/ws`,
    })

    try {
      const snapshotPromise = waitForServerMessage(client, isSessionSnapshotMessage)
      const userEntryPromise = waitForServerMessage(client, isUserConversationEntry)
      const assistantEntryPromise = waitForServerMessage(client, isAssistantConversationEntry)

      await client.connect()

      const snapshot = await snapshotPromise
      expect(snapshot.entries).toEqual([])

      client.submitUserMessage('Show me the shell and the transcript first.')

      const userEntry = await userEntryPromise
      const assistantEntry = await assistantEntryPromise

      expect(userEntry.entry.content).toBe('Show me the shell and the transcript first.')
      expect(assistantEntry.entry.content).toContain('Show me the shell and the transcript first.')
    } finally {
      client.disconnect()
      await stopRustServer(serverProcess)
    }
  },
  120_000,
)
