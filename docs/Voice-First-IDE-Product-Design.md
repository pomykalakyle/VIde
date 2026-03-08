# Product Design Document: Voice-First AI Development Environment

**Draft v0.3 — March 2026**
**Status:** Early Concept
**Target user:** Anyone who builds software — optimized for professional engineers, accessible to newcomers

---

## 1. Product Vision

A development environment where voice is the primary interface. Not a voice plugin bolted onto a traditional IDE, but a ground-up rethinking of how people interact with their development tools. The product is a full AI-powered agent that can read, write, and execute code, controllable entirely through natural conversation.

The core premise is that developers spend a huge amount of their time describing what they want (to themselves, to colleagues, to AI assistants) and then translating that into programming actions: writing code, running commands, navigating files, managing dependencies. This product collapses that gap. You speak your intent, the agent acts, and you direct the results using your voice.

But this isn't only about turning intent into action. A huge part of working with code — especially in unfamiliar or complex codebases — is understanding what's going on. The agent should be equally capable as an explainer: tracing how data flows through the system, walking you through how a function gets called, generating diagrams that help you build a mental model of the architecture. You should be able to ask "how does authentication work in this project?" and get a clear answer backed by the actual code, with visuals on screen if that helps.

The product should work from anywhere you have a microphone and a screen. You start a session at your desk, walk to the couch and pick it up on your phone, then cast to your TV. The session is continuous. The devices are interchangeable.

---

## 2. Design Principles

These principles guide every product decision. Where there is ambiguity, default to these:

- **Ship it, let usage decide.** Many interaction details (agent personality, default modes, layout presets, voice output behavior) should be configurable and refined through real usage data rather than over-specified upfront. Build flexibility, observe behavior, then converge on defaults.

- **No keyboard required.** Every core workflow must be completable without touching a keyboard. The keyboard is a welcome accelerator, never a dependency.

- **Voice for intent, screen for artifacts.** Spoken language is excellent for expressing what you want. Screens are excellent for displaying structured artifacts like code, diffs, and diagrams. The product respects both modalities and never forces one to do the other's job.

- **One session, any screen.** A session is not bound to a device. It floats across whatever displays are available — desktop monitor, phone, tablet, TV. The architecture treats devices as interchangeable viewports into the same ongoing conversation and workspace.

---

## 3. Target User

Anyone who builds software. The product is optimized for professional software engineers who are already proficient with development tools and want a more fluid way to work. But the voice-first interface also has the potential to make software development more approachable for people who are earlier in their journey — the barrier to entry is lower when you can describe what you want in plain language instead of memorizing IDE shortcuts and terminal commands.

---

## 4. Interaction Model

### 4.1 Voice Input

The product supports two input modes, switchable at any time:

| Mode | Behavior | Best for |
|------|----------|----------|
| **Session Mode** | Continuous open microphone. The system listens throughout the session and uses context and silence detection to distinguish commands from ambient speech or thinking pauses. | Quiet environments, solo work, extended coding sessions where you want to stay in flow. |
| **Push-to-Talk** | Microphone activates on a trigger (hotkey, button, or a brief tap on mobile). Input ends on release or after a configurable silence timeout. | Noisy environments, shared spaces, users who prefer explicit control over when the system is listening. |

### 4.2 Voice Output

The AI agent responds aloud with spoken summaries and conversational responses. Two baseline rules: stay terse by default, and don't recite literal code. Beyond that, the exact behavior of voice output should be discovered through usage rather than specified upfront.

The tone, verbosity, and personality of voice responses should be user-configurable. Ship with a reasonable default and let users tune it. The right default will emerge from usage data.

### 4.3 Text Input Fallback

A text input is always available for situations where voice is impractical (typing a specific URL, a variable name the speech engine struggles with, pasting a stack trace). This is not the primary interface; it is an escape hatch.

---

## 5. Interface Layout

The interface is a single flexible workspace — a **Workspace Canvas** — where everything lives, including the conversation.

### 5.1 Workspace Canvas

The entire screen is a voice-controllable canvas for displaying whatever is relevant: code files, diffs, terminal output, file trees, call hierarchies, diagrams, documentation, and the conversation transcript itself.

The conversation transcript — along with a text input at the bottom, like most chat interfaces — is always accessible. You can summon it, dismiss it, resize it, or move it like anything else on the canvas. It is part of the workspace, not a separate fixed region. Sometimes you want it front and center; sometimes you want it tucked away while you look at code. Critically, the transcript and text input must always be reachable by mouse or touch, so that if the microphone fails or voice input isn't working, the user can always fall back to typing without any voice commands.

Users arrange the canvas by speaking layout commands:

| Example voice command | Result |
|-----------------------|--------|
| "Show me the UserCard component on the right" | Opens the file and scrolls to the component in a right-side pane. |
| "Put the test file below it" | Opens the corresponding test file in a pane below the first. |
| "Show call hierarchy for processOrder up top" | Displays a call hierarchy view in a top pane. |
| "Pull up the conversation" | Brings the conversation transcript back into view. |
| "Clear the canvas" / "Close everything" | Removes all panes, returning to a clean workspace. |
| "Show me the diff" | Displays a diff view of the most recent changes in a new pane. |
| "Draw me a diagram of how the auth system works" | Generates and displays an architecture diagram. |

The canvas supports any contextual view the agent or user deems useful. This list is not exhaustive — it should grow as new needs are discovered through usage.

### 5.2 Compact Mode (Phone, Tablet, Small Screens)

On smaller screens, the canvas concept is the same but the layout is more compact — likely a single scrollable view rather than a multi-pane arrangement. Users can still request to see files, diffs, and other views, which render inline. The conversation transcript may be the default view on small screens, with other content summoned on demand.

The experience should feel like the same product on a smaller viewport, not a different product.

---

## 6. Session Continuity

A session is a continuous conversation and workspace that persists across devices. You can:

- Start a session on your desktop, walk to another room, and continue on your phone.
- Cast the workspace to a TV while talking from the couch.
- Switch back to desktop when you need more screen space.

The session state — conversation history, workspace layout, agent context, and any in-progress work — travels with you. Devices are viewports, not containers.

---

## 7. Agent Capabilities

The agent is a full autonomous coding agent, not an advisor. It has direct access to the codebase and can take real actions. It is also an explainer — capable of helping you understand code, trace execution paths, and build mental models of how a system works.

### 7.1 Core Primitives

At its foundation, the agent needs a small set of primitives:

- **Text editing** — read, create, edit, and delete files in the project
- **Terminal access** — run arbitrary commands (build, test, lint, deploy, git operations, dependency management, and anything else the user would do in a terminal)
- **Codebase search** — semantic and text-based search across the project
- **Web access** — browse documentation, search the web, fetch resources

Most development actions (git operations, running tests, installing packages, deploying) are effectively terminal commands. The agent doesn't need a separate capability for each — it needs robust terminal access and the intelligence to use it well.

This list of primitives is a starting point, not a boundary. As the product is used, new capabilities will be identified and added. The architecture should make it easy to extend what the agent can do without redesigning the system.

---

## 8. Project and Codebase Access

The product needs to connect to a real codebase. The initial approach should support:

- Local filesystem access (cloned repos on the user's machine)
- Git integration (clone, pull, push to remotes like GitHub, GitLab, etc.)
- Potential future: cloud-hosted dev environments for sessions without local filesystem access (especially relevant for phone-only or TV-only usage)

---

## 9. What This Product Is Not

- Not a voice plugin for an existing IDE. It is a standalone development environment.
- Not a dictation tool. You do not speak code syntax; you speak intent.
- Not tied to a single device. The session is the product, not the screen.

---

## 10. Product Goals

These are the concrete outcomes that indicate the product is working as intended:

- Users complete real coding tasks end-to-end without touching a keyboard.
- Users choose to open this tool instead of their existing IDE for at least some work.
- Session lengths are long (30+ minutes), indicating sustained usefulness, not just novelty.
- Users actively use voice to arrange the workspace canvas, not just to chat.
- Users switch devices mid-session, indicating the continuity architecture has value.
- Non-engineers or early-career developers are able to accomplish meaningful work.

---

## 11. Open Questions for Usage to Resolve

These questions are intentionally left open. The product should ship with flexibility in these areas and converge on answers through real-world usage:

| # | Question | Initial approach |
|---|----------|------------------|
| 1 | What should the default agent personality be? | Ship configurable. Start with concise and professional. Observe what users change it to. |
| 2 | Should the agent proactively show files and views? | Start conservative (only on request), gradually add proactive behaviors and measure whether users keep or disable them. |
| 3 | What should voice output sound like in different situations? | Don't over-specify. Start with terse summaries, no raw code. Let users push the boundaries and see what they actually want to hear. |
| 4 | What layout presets are most useful? | Ship with none. Let users build layouts via voice. If patterns emerge, codify them as presets. |
| 5 | Should there be distinct "planning" vs "execution" modes? | Don't build explicit modes upfront. Let the agent infer from context. If users need more control, add explicit modes later based on what they ask for. |
| 6 | How should the agent handle high-risk operations? | Start by asking confirmation on destructive actions. Tune the threshold based on user feedback — some users will want full autonomy, others will want more guardrails. |
| 7 | What does phone/TV execution look like? | Start with planning-only on non-desktop devices. Add execution if users demand it. |
| 8 | How does session mode distinguish commands from ambient speech? | Start with a lightweight approach (push-to-talk as default, session mode as opt-in). Refine intent detection based on real usage patterns. |
| 9 | How does workspace layout adapt across different screen sizes? | Let the system intelligently collapse and expand layouts. Refine heuristics through usage. |

---

*End of document — Draft v0.3*
