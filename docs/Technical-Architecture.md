# Technical Architecture: Voice-First AI Development Environment

**Draft v0.1 — March 2026**
**Status:** Early / Pre-Implementation
**Companion to:** Voice-First-IDE-Product-Design.md

---

## 1. System Overview

The system is split into two distinct parts: a **Rust server** that does all real work, and **clients** that are thin display/input layers. This separation is what makes cross-device continuity possible — devices are interchangeable viewports into a session running on the server.

Voice processing (STT and TTS) lives on the client side. The client handles audio capture, transcribes it locally via a local STT runtime, and sends text to the server. The server sends text responses back, and the client speaks them aloud. This keeps audio on the user's machine — important for privacy and for cloud-hosted deployments where streaming raw audio to a remote server would be wasteful and sensitive.

```
[CLIENT SIDE]
   Microphone
       |
   [Local STT runtime: sherpa-onnx]
      ←── runs on client (streams partials to screen, sends final text to server)
       |
   [Electron Client]
     ├── Web UI (canvas, conversation, panes)
     ├── TTS module (speaks agent responses)  ←── runs on client
     └── WebSocket connection
              |
              | text in / text + events out
              |
[SERVER SIDE]
   [Rust VIde Server]
     ├── Session manager
     ├── Intent detection (text-level: is this a command? what kind?)
     ├── Agent loop
     ├── AI model layer (OpenRouter)
     └── Workspace canvas state
              |
              | manages and communicates with
              |
     [Execution Sandbox]
     (containerized project environment,
      spun up and owned by the server)

[Other Clients: phone, browser, TV]  ←── same session, same server
```

---

## 2. MVP System Components

This section is where we work through the MVP system components subsection by subsection. The MVP frontend target is a desktop-only Svelte app, and the MVP backend is a Rust server. Each subsection captures the MVP approach we have chosen or the open questions we still need to answer.

---

### 2.1 The Voice Pipeline

**MVP approach:**

- The user activates push-to-talk or toggle-to-talk to start voice input.
- The client captures audio, runs STT, and shows partial transcription locally while the user is speaking.
- When the utterance ends, the client sends only the final confirmed transcript to the server.
- The server acts only on that final text.
- For MVP, the local STT runtime is **sherpa-onnx**.
- STT sits behind an abstraction so the client can swap models within sherpa-onnx, or replace the backend entirely later, without changing the rest of the UI flow.
- The runtime choice is fixed for MVP, but model choice remains open so we can compare options like Whisper-family models and lower-latency sherpa-onnx-compatible models during implementation.

---

### 2.2 The Agent Loop

**MVP approach:**

- The backend stores the conversation transcript as a turn-by-turn record of what the user said and what the agent did.
- When a new user transcript arrives, the backend appends it to that conversation state and sends the relevant conversation and workspace context to the model.
- The minimum core tools are reading files, editing files, and running terminal commands.
- The conversation/transcript view shows the agent's responses and tool activity.
- For the first version, we can render the conversation and tool output directly and refine collapsing or summarization later if it becomes a problem.
- If a tool fails or produces an unclear result, surface that failure to the user instead of trying to do sophisticated automatic recovery.

---

### 2.3 Server-Owned Session State

**What we know for MVP:**

- Session state is server-owned, not a full copy of frontend state.
- The server-owned session state includes the conversation transcript, session metadata, and references to the server-managed execution sandbox tied to the session.
- For MVP, canvas/display state is entirely client-local: each client keeps its own canvas state, it is not mirrored to the backend, and the backend assumes no knowledge of the frontend display state.
- Multiple clients should be able to connect to the same session, even if the desktop client is the only frontend we build first.
- Session state should live in memory for active use and be saved to disk periodically so the session can be recovered if the server restarts or crashes.

---

### 2.4 The Execution Sandbox

**MVP approach:**

- Use Docker as the first execution sandbox for the MVP.
- For local/self-hosted use, the user's project on disk is bind-mounted into the container, while the Rust server reads and writes project files directly on the host filesystem.
- The server owns the container lifecycle: a single container is created per session when the session starts, and multiple clients in the same session share that container.
- When the agent needs to run a command, the server wraps that command and executes it in the container, likely via the Docker CLI for the MVP, and streams the output back to the client.
- Containers do not have network access by default, and for MVP we do not need to over-design resource limits or confirmation rules beyond obvious destructive operations.

---

### 2.5 The Workspace Canvas

**The problem:** The interface needs a flexible workspace where the conversation, code, and other artifacts can be arranged by voice.

**What we know for MVP:**

- The desktop Svelte frontend renders and owns the canvas state.
- The minimum pane types are the conversation, a code/editor view, and a terminal view.
- The server can tell the frontend to apply canvas changes, even though the canvas state itself is client-local.

**Open item:**

- How should the Svelte frontend represent the canvas layout as data while keeping the layout highly customizable? The exact pane/layout library does not need to be chosen yet.

---

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

*End of document — Draft v0.1*
