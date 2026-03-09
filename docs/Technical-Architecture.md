# Technical Architecture: Voice-First AI Development Environment

**Draft v0.3 — March 2026**
**Status:** Early / Pre-Implementation
**Companion to:** Voice-First-IDE-Product-Design.md

---

## 1. System Overview

The system is split into three distinct parts: a **client** that handles voice and rendering, a thin **session coordinator** that owns the long-lived session, and a per-project **runtime container** that runs an **OpenCode server** against a specific project workspace. This separation is what makes cross-device continuity and project switching possible — the session is persistent even when the active project container changes.

Voice processing (STT and TTS) lives on the client side. The client handles audio capture, transcribes it locally via a local STT runtime, and sends text to the session coordinator. The coordinator sends text responses and UI actions back, and the client speaks them aloud. This keeps audio on the user's machine — important for privacy and for cloud-hosted deployments where streaming raw audio to a remote server would be wasteful and sensitive.

```text
+-------------------+                     +------------------------+
| Electron Client   |<------------------->| VIde Session           |
|-------------------|    WebSocket:       | Coordinator            |
| - Voice input     |    - final          |------------------------|
| - React UI        |    - transcript     | - Session manager      |
| - TTS             |    - assistant text | - Transcript store     |
+-------------------+    - UI actions     | - Current project ref  |
                                           +-----------+------------+
                                                       |
                                                       | HTTP / SDK:
                                                       | - session control
                                                       | - prompt turns
                                                       | - replies / events
                                                       v
                        +--------------------------------------------------+
                        | Project Runtime Container                        |
                        |--------------------------------------------------|
                        | +----------------------+   +-------------------+ |
                        | | OpenCode Server      |<->| Project Workspace | |
                        | +----------------------+   +-------------------+ |
                        |   All file reads, edits, and commands happen    |
                        |   inside this container.                         |
                        +--------------------------------------------------+

Other clients also connect to the same session coordinator.
```

---

## 2. MVP System Components

This section is where we work through the MVP system components subsection by subsection. The MVP frontend target is a desktop-only React app. The MVP backend is a thin session coordinator plus a per-project OpenCode server running in Docker. Each subsection captures the MVP approach we have chosen or the open questions we still need to answer.

---

### 2.1 The Frontend

The frontend is responsible for voice interaction and for rendering the workspace the user sees and manipulates.

#### 2.1.1 Voice Input and Output

**MVP approach:**

- The user activates push-to-talk or toggle-to-talk to start voice input.
- The client captures audio, runs a speech-to-text pipeline, and shows partial transcription locally while the user is speaking.
- When the utterance ends, the client sends only the final confirmed transcript to the session manager, and the session manager acts only on that final text.
- Voice input should sit behind an abstraction so we can change the speech-to-text approach later without changing the rest of the UI flow.

#### 2.1.2 The Workspace Canvas

**What we know for MVP:**

- The desktop React frontend renders and owns the canvas state.
- The React frontend uses **Dockview** to represent and render the workspace canvas.
- The minimum pane types are the conversation, a code/editor view, a terminal view, and a server status view.
- The server can tell the frontend to apply canvas changes, even though the canvas state itself is client-local.

---

### 2.2 The Session Manager

**What we know for MVP:**

The session manager is the thin outer backend service that owns the canonical session state, not the project runtime container and not the frontend.

It owns:

- The conversation transcript.
- Session metadata.
- The identity of the currently attached project and runtime container.
- Enough saved context to rehydrate the agent if the runtime container changes.

It is responsible for:

- Receiving user transcripts from clients.
- Routing those turns to the OpenCode server inside the currently attached execution sandbox.
- Sending assistant responses and UI actions back to connected clients.
- Persisting session state so the session can be recovered if the session manager restarts or crashes.
- Supporting multiple clients connected to the same session, even if the desktop client is the only frontend we build first.

The attached project runtime container may keep short-lived local runtime state, but that state should be treated as disposable and recreatable.

---

### 2.3 The Agent Runtime and Execution Sandbox

Environment:

- Use Docker as the first execution sandbox for the MVP.
- For MVP, the execution sandbox is a per-project container with the active project workspace inside it.
- For local/self-hosted use, the user's project on disk can still be bind-mounted into the project container for simplicity.

OpenCode server inside the container:

- The first project runtime implementation runs an **OpenCode server** inside the container, alongside the project workspace.
- OpenCode handles model-provider selection, so the system can switch between providers like **OpenAI** and **Claude** without rewriting the frontend session protocol.
- For the first implementation, we only need to append the final assistant reply to the transcript; streaming and richer tool activity can be added later.
- If a tool fails or produces an unclear result, surface that failure to the user instead of trying to do sophisticated automatic recovery.

## 3. Post-MVP / Future Considerations

These are the things we already know we may want, but are intentionally not designing deeply until the MVP forces us to.

- **Always-listening session mode:** Instead of push-to-talk or toggle-to-talk, the microphone stays open for the full session. The system has to decide when the user has started speaking to the agent, when they are done, and when speech is just ambient conversation, thinking out loud, or background noise.
- **Advanced speech handling:** Better device switching, better noisy-environment behavior, and other edge cases in the voice pipeline.
- **TTS and voice output:** Client-side spoken responses, provider choice, interruption behavior, and the exact voice-output experience can all be added after the core input/canvas/sandbox workflow is working.
- **Long-running agent work:** Background tasks, better retries, reconnect handling, and richer interruption/redirection once tasks can run for a long time.
- **Advanced context management:** Better summarization or pruning once conversations and tool output become too large to keep passing directly to the model.
- **True cross-device continuity:** Concurrent clients, device handoff, reconnection catch-up, and conflict handling when more than one device is active.
- **Stronger sandboxing:** Tighter isolation, better resource controls, and hosted multi-user deployment concerns.
- **Richer canvas behavior:** More pane types, generated diagrams, and better behavior on smaller screens.
- **More adaptive TTS behavior:** Better interruption handling and more nuanced rules for what the agent should say out loud.

---

*End of document — Draft v0.2*
