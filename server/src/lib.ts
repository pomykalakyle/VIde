import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createOpencodeClient } from '@opencode-ai/sdk'
import type { Server, ServerWebSocket } from 'bun'

import type { AgentRuntime } from './agent/agent-runtime'
import { createAgentRuntime } from './agent/create-agent-runtime'
import {
  getConfigDirectory,
  getDefaultSecretStorageMode,
  getOpenCodeDefaultModel,
  getServerPort,
} from './config'
import {
  createDockerSessionContainerManager,
  type SessionContainerManager,
  type SessionOpenCodeStatus,
  type SessionContainerSnapshot,
  type SessionContainerStatus,
} from './container/session-container'
import {
  createWorkspaceSessionContainerManager,
  type WorkspaceSessionContainerManager,
} from './container/workspace-session-container'
import type {
  ClientSessionMessage,
  ConversationEntry,
  ConversationEntryDeltaMessage,
  ConversationEntryMessage,
  ServerSessionMessage,
  SessionErrorMessage,
  SessionSocketData,
} from './session/session-types'
import {
  createOpenAiConfigStore,
  OpenAiConfigStoreError,
  type OpenAiConfigStore,
} from './runtime-config/openai-config-store'
import type {
  ConvertOpenAiConfigRequest,
  SaveOpenAiConfigRequest,
  UnlockOpenAiConfigRequest,
} from './runtime-config/openai-config-types'
import {
  createWorkspaceStore,
  type CreateWorkspaceRequest,
  type LoadWorkspaceRequest,
  type SaveWorkspaceRequest,
  type WorkspaceRegistrySnapshot,
  type WorkspaceStore,
} from './workspace/workspace-store'

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url))
const openAiRuntimeConfigPath = '/runtime-config/openai'

/** Represents the JSON payload returned by the minimal health endpoint. */
export interface ServerHealthPayload {
  activeWorkspaceHostPath: string | null
  activeWorkspaceId: string | null
  activeWorkspaceName: string | null
  containerBaseUrl: string | null
  containerError: string
  containerId: string | null
  containerImage: string
  containerName: string | null
  containerStartedAt: string | null
  containerStatus: SessionContainerStatus
  instanceId: string
  ok: true
  openCodeError: string
  openCodeStatus: SessionOpenCodeStatus
  openCodeVersion: string | null
  serverType: string
  serverTypeHash: string
  startedAt: string
}

/** Represents the configurable inputs for starting the minimal Bun server. */
export interface StartServerOptions {
  agentRuntime?: AgentRuntime
  openAiConfigStore?: OpenAiConfigStore
  port?: number
  sessionContainerManager?: SessionContainerManager
  workspaceStore?: WorkspaceStore
}

/** Represents one running Bun server plus its cleanup hook. */
export interface ServerHandle {
  server: Server<SessionSocketData>
  stop(): Promise<void>
}

/** Represents the static health metadata for one running Bun coordinator. */
interface ServerHealthPayloadBase {
  instanceId: string
  ok: true
  serverType: string
  serverTypeHash: string
  startedAt: string
}

/** Represents the shared mutable count of in-flight assistant turns. */
interface AssistantTurnCounter {
  activeCount: number
}

/** Returns the stable server type label for the minimal Bun backend. */
function getServerType(): string {
  return 'minimal'
}

/** Returns the sorted file paths that contribute to the server identity hash. */
function getServerHashInputPaths(): string[] {
  const directoriesToScan = [sourceDirectory]
  const discoveredPaths: string[] = []

  while (directoriesToScan.length > 0) {
    const currentDirectory = directoriesToScan.pop()

    if (!currentDirectory) {
      continue
    }

    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const entryPath = path.join(currentDirectory, entry.name)

      if (entry.isDirectory()) {
        directoriesToScan.push(entryPath)
        continue
      }

      if (entry.isFile() && entry.name.endsWith('.ts')) {
        discoveredPaths.push(entryPath)
      }
    }
  }

  discoveredPaths.sort()
  discoveredPaths.push(path.resolve(sourceDirectory, '..', 'package.json'))
  return discoveredPaths
}

/** Returns the code-derived hash for the currently running server build. */
function getServerTypeHash(): string {
  const hash = createHash('sha256')

  for (const filePath of getServerHashInputPaths()) {
    hash.update(path.relative(sourceDirectory, filePath))
    hash.update('\n')
    hash.update(readFileSync(filePath))
    hash.update('\n')
  }

  return hash.digest('hex').slice(0, 12)
}

/** Returns the short identifier for one running backend instance. */
function createServerInstanceId(): string {
  return randomUUID().slice(0, 8)
}

/** Returns the JSON response used by the minimal server health endpoint. */
function createJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

/** Returns one JSON error payload for renderer-safe API failures. */
function createJsonErrorResponse(message: string, status: number): Response {
  return createJsonResponse({ message }, { status })
}

/** Returns one transcript entry sent from the Bun chat socket. */
function createConversationEntry(
  role: ConversationEntry['role'],
  content: string,
  id: string = randomUUID(),
): ConversationEntry {
  return {
    id,
    role,
    content,
  }
}

/** Returns one renderer-safe session error payload. */
function createSessionErrorMessage(message: string): SessionErrorMessage {
  return {
    type: 'session_error',
    message,
  }
}

/** Returns one partial assistant transcript snapshot for the renderer chat socket. */
function createConversationEntryDeltaMessage(entry: ConversationEntry): ConversationEntryDeltaMessage {
  return {
    type: 'conversation_entry_delta',
    entry,
  }
}

/** Returns one renderer-safe error message for unexpected runtime config failures. */
function toRuntimeConfigErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The runtime config request failed.'
}

/** Parses one JSON request body or throws a renderer-safe runtime config error. */
async function parseJsonRequestBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new OpenAiConfigStoreError('The runtime config request body must be valid JSON.', 400)
  }
}

/** Returns the validated OpenAI save request body accepted by the Bun API. */
function parseSaveOpenAiConfigRequest(body: unknown): SaveOpenAiConfigRequest {
  if (typeof body !== 'object' || body === null || typeof body.apiKey !== 'string') {
    throw new OpenAiConfigStoreError('The OpenAI save request must include an apiKey string.', 400)
  }

  return {
    apiKey: body.apiKey,
  }
}

/** Returns the validated encrypted-store unlock request body accepted by the Bun API. */
function parseUnlockOpenAiConfigRequest(body: unknown): UnlockOpenAiConfigRequest {
  if (typeof body !== 'object' || body === null || typeof body.passphrase !== 'string') {
    throw new OpenAiConfigStoreError(
      'The OpenAI unlock request must include a passphrase string.',
      400,
    )
  }

  return {
    passphrase: body.passphrase,
  }
}

/** Returns the validated storage-conversion request body accepted by the Bun API. */
function parseConvertOpenAiConfigRequest(body: unknown): ConvertOpenAiConfigRequest {
  if (
    typeof body !== 'object' ||
    body === null ||
    (body.targetMode !== 'plaintext' && body.targetMode !== 'encrypted')
  ) {
    throw new OpenAiConfigStoreError(
      'The OpenAI convert request must include a plaintext or encrypted targetMode.',
      400,
    )
  }

  return {
    currentPassphrase:
      typeof body.currentPassphrase === 'string' ? body.currentPassphrase : undefined,
    newPassphrase: typeof body.newPassphrase === 'string' ? body.newPassphrase : undefined,
    targetMode: body.targetMode,
  }
}

/** Returns whether the provided container manager can switch between workspaces. */
function isWorkspaceSessionContainerManager(
  sessionContainerManager: SessionContainerManager,
): sessionContainerManager is WorkspaceSessionContainerManager {
  return 'attachWorkspace' in sessionContainerManager
}

/** Returns the validated workspace-create request body accepted by the Bun API. */
function parseCreateWorkspaceRequest(body: unknown): CreateWorkspaceRequest {
  if (typeof body !== 'object' || body === null || typeof body.hostPath !== 'string') {
    throw new Error('The workspace create request must include a hostPath string.')
  }

  return {
    hostPath: body.hostPath,
  }
}

/** Returns the validated workspace-save request body accepted by the Bun API. */
function parseSaveWorkspaceRequest(body: unknown): SaveWorkspaceRequest {
  if (typeof body !== 'object' || body === null || typeof body.name !== 'string') {
    throw new Error('The workspace save request must include a name string.')
  }

  return {
    name: body.name,
  }
}

/** Returns the validated workspace-load request body accepted by the Bun API. */
function parseLoadWorkspaceRequest(body: unknown): LoadWorkspaceRequest {
  if (typeof body !== 'object' || body === null || typeof body.workspaceId !== 'string') {
    throw new Error('The workspace load request must include a workspaceId string.')
  }

  return {
    workspaceId: body.workspaceId,
  }
}

/** Sends one typed session message across the Bun chat socket. */
function sendServerSessionMessage(
  socket: ServerWebSocket<SessionSocketData>,
  message: ServerSessionMessage,
): void {
  socket.send(JSON.stringify(message))
}

/** Sends one renderer-safe error message across the Bun chat socket. */
function sendSessionError(socket: ServerWebSocket<SessionSocketData>, message: string): void {
  sendServerSessionMessage(socket, createSessionErrorMessage(message))
}

/** Applies the saved OpenAI key to the currently running OpenCode runtime when possible. */
async function applyOpenAiCredentialToRuntime(
  openAiConfigStore: OpenAiConfigStore,
  sessionContainerManager: SessionContainerManager,
  assistantTurnCounter: AssistantTurnCounter,
): Promise<void> {
  if (assistantTurnCounter.activeCount > 0) {
    throw new OpenAiConfigStoreError(
      'Wait for the current assistant request to finish before applying OpenAI auth.',
      409,
    )
  }

  const snapshot = sessionContainerManager.getSnapshot()

  if (snapshot.status !== 'ready' || !snapshot.baseUrl) {
    throw new OpenAiConfigStoreError('The OpenCode runtime is not available yet.', 409)
  }

  const summary = await openAiConfigStore.getSummary()
  const savedCredential = await openAiConfigStore.getSavedCredentialForApply()

  if (!savedCredential.apiKey) {
    if (!summary.needsApply) {
      return
    }

    throw new OpenAiConfigStoreError(
      'The running OpenCode runtime cannot clear an already applied OpenAI key without a restart.',
      409,
    )
  }

  try {
    const client = createOpencodeClient({
      baseUrl: snapshot.baseUrl,
    })

    await client.auth.set({
      body: {
        key: savedCredential.apiKey,
        type: 'api',
      },
      path: {
        id: 'openai',
      },
    })
    await openAiConfigStore.setRuntimeApplySuccess(savedCredential.savedRevision)
  } catch (error) {
    const message = toRuntimeConfigErrorMessage(error)

    await openAiConfigStore.applySavedCredentialToRuntimeResult(message)
    throw new OpenAiConfigStoreError(message, 502)
  }
}

/** Starts the runtime container and attempts a background OpenAI auth apply when possible. */
async function initializeRuntimeContainer(
  openAiConfigStore: OpenAiConfigStore,
  sessionContainerManager: SessionContainerManager,
  assistantTurnCounter: AssistantTurnCounter,
  workspaceStore: WorkspaceStore,
): Promise<void> {
  openAiConfigStore.markRuntimeStopped()

  try {
    const workspaceSnapshot = await workspaceStore.getSnapshot()

    if (isWorkspaceSessionContainerManager(sessionContainerManager)) {
      if (!workspaceSnapshot.activeWorkspace) {
        openAiConfigStore.markRuntimeStopped()
        return
      }

      await sessionContainerManager.attachWorkspace(workspaceSnapshot.activeWorkspace.hostPath)
    }

    await sessionContainerManager.start()
    const snapshot = sessionContainerManager.getSnapshot()

    if (snapshot.status !== 'ready' || !snapshot.baseUrl) {
      openAiConfigStore.markRuntimeStopped()
      return
    }

    await openAiConfigStore.markRuntimeStarted()
    const summary = await openAiConfigStore.getSummary()

    if (!summary.locked && summary.needsApply) {
      try {
        await applyOpenAiCredentialToRuntime(
          openAiConfigStore,
          sessionContainerManager,
          assistantTurnCounter,
        )
      } catch {
        // The settings UI surfaces the apply error without blocking server startup.
      }
    }
  } catch {
    openAiConfigStore.markRuntimeStopped()
  }
}

/** Attaches the active workspace and ensures the runtime is ready for the next assistant turn. */
async function attachActiveWorkspaceRuntime(
  openAiConfigStore: OpenAiConfigStore,
  sessionContainerManager: SessionContainerManager,
  assistantTurnCounter: AssistantTurnCounter,
  workspaceStore: WorkspaceStore,
): Promise<WorkspaceRegistrySnapshot> {
  if (assistantTurnCounter.activeCount > 0) {
    throw new Error('Wait for the current assistant request to finish before switching workspaces.')
  }

  const workspaceSnapshot = await workspaceStore.getSnapshot()

  if (!workspaceSnapshot.activeWorkspace) {
    throw new Error('There is no active workspace to attach.')
  }

  openAiConfigStore.markRuntimeStopped()

  if (isWorkspaceSessionContainerManager(sessionContainerManager)) {
    await sessionContainerManager.attachWorkspace(workspaceSnapshot.activeWorkspace.hostPath)
  } else {
    await sessionContainerManager.stop()
    await sessionContainerManager.start()
  }

  const snapshot = sessionContainerManager.getSnapshot()

  if (snapshot.status !== 'ready' || !snapshot.baseUrl) {
    openAiConfigStore.markRuntimeStopped()
    return workspaceSnapshot
  }

  await openAiConfigStore.markRuntimeStarted()
  const summary = await openAiConfigStore.getSummary()

  if (!summary.locked && summary.needsApply) {
    try {
      await applyOpenAiCredentialToRuntime(
        openAiConfigStore,
        sessionContainerManager,
        assistantTurnCounter,
      )
    } catch {
      // The settings UI surfaces the apply error without blocking workspace attach.
    }
  }

  return workspaceSnapshot
}

/** Handles one HTTP request against the Bun-owned OpenAI runtime config API surface. */
async function handleOpenAiRuntimeConfigRequest(
  request: Request,
  openAiConfigStore: OpenAiConfigStore,
  sessionContainerManager: SessionContainerManager,
  assistantTurnCounter: AssistantTurnCounter,
): Promise<Response | null> {
  const url = new URL(request.url)

  try {
    if (url.pathname === openAiRuntimeConfigPath && request.method === 'GET') {
      return createJsonResponse(await openAiConfigStore.getSummary())
    }

    if (url.pathname === openAiRuntimeConfigPath && request.method === 'PUT') {
      return createJsonResponse(
        await openAiConfigStore.saveOpenAiKey(
          parseSaveOpenAiConfigRequest(await parseJsonRequestBody(request)),
        ),
      )
    }

    if (url.pathname === openAiRuntimeConfigPath && request.method === 'DELETE') {
      return createJsonResponse(await openAiConfigStore.clearOpenAiKey())
    }

    if (url.pathname === `${openAiRuntimeConfigPath}/unlock` && request.method === 'POST') {
      return createJsonResponse(
        await openAiConfigStore.unlockEncryptedStore(
          parseUnlockOpenAiConfigRequest(await parseJsonRequestBody(request)).passphrase,
        ),
      )
    }

    if (url.pathname === `${openAiRuntimeConfigPath}/convert` && request.method === 'POST') {
      return createJsonResponse(
        await openAiConfigStore.convertSecretStorage(
          parseConvertOpenAiConfigRequest(await parseJsonRequestBody(request)),
        ),
      )
    }

    if (url.pathname === `${openAiRuntimeConfigPath}/apply` && request.method === 'POST') {
      await applyOpenAiCredentialToRuntime(
        openAiConfigStore,
        sessionContainerManager,
        assistantTurnCounter,
      )
      return createJsonResponse(await openAiConfigStore.getSummary())
    }
  } catch (error) {
    if (error instanceof OpenAiConfigStoreError) {
      return createJsonErrorResponse(error.message, error.statusCode)
    }

    return createJsonErrorResponse(toRuntimeConfigErrorMessage(error), 500)
  }

  return null
}

/** Handles one HTTP request against the Bun-owned workspace management API surface. */
async function handleWorkspaceRequest(
  request: Request,
  workspaceStore: WorkspaceStore,
  openAiConfigStore: OpenAiConfigStore,
  sessionContainerManager: SessionContainerManager,
  assistantTurnCounter: AssistantTurnCounter,
): Promise<Response | null> {
  const url = new URL(request.url)

  try {
    if (url.pathname === '/workspaces' && request.method === 'GET') {
      return createJsonResponse(await workspaceStore.getSnapshot())
    }

    if (url.pathname === '/workspaces/create' && request.method === 'POST') {
      await workspaceStore.createWorkspace(
        parseCreateWorkspaceRequest(await parseJsonRequestBody(request)),
      )
      return createJsonResponse(
        await attachActiveWorkspaceRuntime(
          openAiConfigStore,
          sessionContainerManager,
          assistantTurnCounter,
          workspaceStore,
        ),
      )
    }

    if (url.pathname === '/workspaces/save' && request.method === 'POST') {
      return createJsonResponse(
        await workspaceStore.saveCurrentWorkspace(
          parseSaveWorkspaceRequest(await parseJsonRequestBody(request)),
        ),
      )
    }

    if (url.pathname === '/workspaces/load' && request.method === 'POST') {
      await workspaceStore.loadWorkspace(parseLoadWorkspaceRequest(await parseJsonRequestBody(request)))
      return createJsonResponse(
        await attachActiveWorkspaceRuntime(
          openAiConfigStore,
          sessionContainerManager,
          assistantTurnCounter,
          workspaceStore,
        ),
      )
    }
  } catch (error) {
    return createJsonErrorResponse(
      error instanceof Error ? error.message : 'The workspace request failed.',
      400,
    )
  }

  return null
}

/** Returns one parsed client session message or throws a renderer-safe error. */
function parseClientSessionMessage(message: string | Buffer): ClientSessionMessage {
  if (typeof message !== 'string') {
    throw new Error('The chat socket only accepts text messages.')
  }

  const parsedMessage = JSON.parse(message) as Partial<ClientSessionMessage> & {
    sessionId?: unknown
    text?: unknown
    type?: unknown
  }

  if (parsedMessage.type === 'connect') {
    if (typeof parsedMessage.sessionId !== 'string' || parsedMessage.sessionId.trim().length === 0) {
      throw new Error('The connect message must include a sessionId.')
    }

    return {
      type: 'connect',
      sessionId: parsedMessage.sessionId,
    }
  }

  if (parsedMessage.type === 'user_message') {
    if (typeof parsedMessage.sessionId !== 'string' || parsedMessage.sessionId.trim().length === 0) {
      throw new Error('The user_message event must include a sessionId.')
    }

    if (typeof parsedMessage.text !== 'string') {
      throw new Error('The user_message event must include text.')
    }

    return {
      type: 'user_message',
      sessionId: parsedMessage.sessionId,
      text: parsedMessage.text,
    }
  }

  throw new Error('The chat socket received an unsupported message type.')
}

/** Returns whether the socket is ready to accept one user message for the session. */
function canHandleUserMessage(
  socket: ServerWebSocket<SessionSocketData>,
  sessionId: string,
): boolean {
  if (!socket.data.sessionId) {
    sendSessionError(socket, 'The chat socket must connect to a session before sending messages.')
    return false
  }

  if (socket.data.sessionId !== sessionId) {
    sendSessionError(socket, 'The user message sessionId did not match the connected session.')
    return false
  }

  return true
}

/** Returns whether the session container is ready to accept one assistant turn. */
function canHandleAssistantTurn(
  socket: ServerWebSocket<SessionSocketData>,
  sessionContainerManager: SessionContainerManager,
): boolean {
  const snapshot = sessionContainerManager.getSnapshot()

  if (snapshot.status === 'ready') {
    return true
  }

  if (isWorkspaceSessionContainerManager(sessionContainerManager)) {
    const workspaceDirectory = sessionContainerManager.getWorkspaceDirectory()

    if (!workspaceDirectory) {
      sendSessionError(socket, 'Select or load a workspace before sending chat requests.')
      return false
    }
  }

  sendSessionError(
    socket,
    snapshot.error || 'The session container is not ready yet. Try again in a moment.',
  )
  return false
}

/** Returns the current health payload by combining static server metadata and container state. */
function createServerHealthPayload(
  basePayload: ServerHealthPayloadBase,
  containerSnapshot: SessionContainerSnapshot,
  workspaceSnapshot: WorkspaceRegistrySnapshot,
): ServerHealthPayload {
  return {
    ...basePayload,
    activeWorkspaceHostPath: workspaceSnapshot.activeWorkspace?.hostPath ?? null,
    activeWorkspaceId: workspaceSnapshot.activeWorkspace?.id ?? null,
    activeWorkspaceName: workspaceSnapshot.activeWorkspace?.name ?? null,
    containerBaseUrl: containerSnapshot.baseUrl,
    containerError: containerSnapshot.error,
    containerId: containerSnapshot.containerId,
    containerImage: containerSnapshot.containerImage,
    containerName: containerSnapshot.containerName,
    containerStartedAt: containerSnapshot.startedAt,
    containerStatus: containerSnapshot.status,
    openCodeError: containerSnapshot.openCodeError,
    openCodeStatus: containerSnapshot.openCodeStatus,
    openCodeVersion: containerSnapshot.openCodeVersion,
  }
}

/** Handles one parsed client session message on the Bun chat socket. */
async function handleClientSessionMessage(
  socket: ServerWebSocket<SessionSocketData>,
  message: ClientSessionMessage,
  agentRuntime: AgentRuntime,
  sessionContainerManager: SessionContainerManager,
  assistantTurnCounter: AssistantTurnCounter,
): Promise<void> {
  if (message.type === 'connect') {
    socket.data.sessionId = message.sessionId
    return
  }

  if (!canHandleUserMessage(socket, message.sessionId)) {
    return
  }

  if (!canHandleAssistantTurn(socket, sessionContainerManager)) {
    return
  }

  const userEntry = createConversationEntry('user', message.text)
  const assistantEntryId = randomUUID()
  assistantTurnCounter.activeCount += 1

  try {
    const result = await agentRuntime.runTurn({
      entries: [userEntry],
      onAssistantTextUpdate: (assistantText) => {
        sendServerSessionMessage(
          socket,
          createConversationEntryDeltaMessage(
            createConversationEntry('assistant', assistantText, assistantEntryId),
          ),
        )
      },
      sessionId: message.sessionId,
      userText: message.text,
    })
    const replyMessage: ConversationEntryMessage = {
      type: 'conversation_entry',
      entry: createConversationEntry('assistant', result.assistantText, assistantEntryId),
    }

    sendServerSessionMessage(socket, replyMessage)
  } finally {
    assistantTurnCounter.activeCount -= 1
  }
}

/** Starts the minimal Bun server with a health-check route and placeholder chat socket. */
export function startServer(options: StartServerOptions = {}): ServerHandle {
  const port = options.port ?? getServerPort()
  const sessionContainerManager =
    options.sessionContainerManager ?? createWorkspaceSessionContainerManager()
  const openAiConfigStore =
    options.openAiConfigStore ??
    createOpenAiConfigStore({
      configDirectory: getConfigDirectory(),
      defaultModel: getOpenCodeDefaultModel(),
      defaultSecretStorageMode: getDefaultSecretStorageMode(),
    })
  const workspaceStore =
    options.workspaceStore ?? createWorkspaceStore(getConfigDirectory())
  const agentRuntime =
    options.agentRuntime ?? createAgentRuntime({ sessionContainerManager })
  const healthPayloadBase: ServerHealthPayloadBase = {
    instanceId: createServerInstanceId(),
    ok: true,
    serverType: getServerType(),
    serverTypeHash: getServerTypeHash(),
    startedAt: new Date().toISOString(),
  }
  const assistantTurnCounter: AssistantTurnCounter = {
    activeCount: 0,
  }
  let stopPromise: Promise<void> | null = null

  void initializeRuntimeContainer(
    openAiConfigStore,
    sessionContainerManager,
    assistantTurnCounter,
    workspaceStore,
  )
  const server = Bun.serve<SessionSocketData>({
    port,
    async fetch(request, server) {
      const url = new URL(request.url)

      if (url.pathname === '/health') {
        const workspaceSnapshot = await workspaceStore.getSnapshot()
        return createJsonResponse(
          createServerHealthPayload(
            healthPayloadBase,
            sessionContainerManager.getSnapshot(),
            workspaceSnapshot,
          ),
        )
      }

      const runtimeConfigResponse = await handleOpenAiRuntimeConfigRequest(
        request,
        openAiConfigStore,
        sessionContainerManager,
        assistantTurnCounter,
      )

      if (runtimeConfigResponse) {
        return runtimeConfigResponse
      }

      const workspaceResponse = await handleWorkspaceRequest(
        request,
        workspaceStore,
        openAiConfigStore,
        sessionContainerManager,
        assistantTurnCounter,
      )

      if (workspaceResponse) {
        return workspaceResponse
      }

      if (url.pathname === '/ws') {
        const didUpgrade = server.upgrade(request, {
          data: {
            sessionId: null,
          },
        })

        if (didUpgrade) {
          return
        }

        return createJsonResponse(
          {
            message: 'The chat socket upgrade failed.',
          },
          { status: 400 },
        )
      }

      return new Response('Not found.', { status: 404 })
    },
    websocket: {
      message(socket, message) {
        try {
          void handleClientSessionMessage(
            socket,
            parseClientSessionMessage(message),
            agentRuntime,
            sessionContainerManager,
            assistantTurnCounter,
          ).catch((error) => {
            sendSessionError(
              socket,
              error instanceof Error ? error.message : 'The chat socket request failed.',
            )
          })
        } catch (error) {
          sendSessionError(
            socket,
            error instanceof Error ? error.message : 'The chat socket request failed.',
          )
        }
      },
    },
  })

  return {
    server,
    async stop(): Promise<void> {
      if (stopPromise) {
        await stopPromise
        return
      }

      stopPromise = (async () => {
        try {
          openAiConfigStore.markRuntimeStopped()
          await sessionContainerManager.stop()

          if (agentRuntime.destroy) {
            await agentRuntime.destroy()
          }
        } finally {
          server.stop(true)
        }
      })()
      await stopPromise
    },
  }
}
