use std::{collections::HashMap, env, net::SocketAddr, sync::Arc};

use axum::{
  extract::{
    State,
    ws::{Message, WebSocket, WebSocketUpgrade},
  },
  response::Response,
  routing::get,
  Router,
};
use futures_util::{sink::SinkExt, stream::SplitSink, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::{
  net::TcpListener,
  sync::{Mutex, broadcast},
};

/** Represents one transcript role emitted by the Rust session server. */
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationRole {
  User,
  Assistant,
}

/** Represents one transcript entry stored inside a server-owned session. */
#[derive(Clone, Serialize, Deserialize)]
pub struct ConversationEntry {
  pub id: String,
  pub role: ConversationRole,
  pub content: String,
}

/** Represents the first client message that joins one server-owned session. */
#[derive(Clone, Deserialize)]
pub struct SessionConnectMessage {
  #[serde(rename = "sessionId")]
  pub session_id: String,
}

/** Represents one finalized user transcript sent from the client to the server. */
#[derive(Clone, Deserialize)]
pub struct UserMessageRequest {
  #[serde(rename = "sessionId")]
  pub session_id: String,
  pub text: String,
}

/** Represents any client message accepted by the Rust session server. */
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientSessionMessage {
  Connect(SessionConnectMessage),
  UserMessage(UserMessageRequest),
}

/** Represents the initial server snapshot sent after a client joins a session. */
#[derive(Clone, Serialize)]
pub struct SessionSnapshotMessage {
  #[serde(rename = "type")]
  pub message_type: &'static str,
  #[serde(rename = "sessionId")]
  pub session_id: String,
  pub entries: Vec<ConversationEntry>,
}

/** Represents one append-only transcript event emitted by the Rust server. */
#[derive(Clone, Serialize)]
pub struct ConversationEntryMessage {
  #[serde(rename = "type")]
  pub message_type: &'static str,
  pub entry: ConversationEntry,
}

/** Represents one renderer-safe session error emitted by the Rust server. */
#[derive(Clone, Serialize)]
pub struct SessionErrorMessage {
  #[serde(rename = "type")]
  pub message_type: &'static str,
  pub message: String,
}

/** Represents any server message emitted by the Rust session server. */
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum ServerSessionMessage {
  SessionSnapshot(SessionSnapshotMessage),
  ConversationEntry(ConversationEntryMessage),
  SessionError(SessionErrorMessage),
}

/** Represents one in-memory session record shared across connected clients. */
struct ServerSession {
  entries: Vec<ConversationEntry>,
  next_entry_id: u64,
  broadcaster: broadcast::Sender<ServerSessionMessage>,
}

/** Represents the shared in-memory session registry for the Rust backend. */
#[derive(Clone, Default)]
pub struct SharedServerState {
  sessions: Arc<Mutex<HashMap<String, ServerSession>>>,
}

/** Returns the local socket address configured for the bare-bones Rust backend. */
pub fn server_socket_addr() -> SocketAddr {
  let port = env::var("VIDE_SERVER_PORT")
    .ok()
    .and_then(|value| value.parse::<u16>().ok())
    .unwrap_or(8787);

  SocketAddr::from(([127, 0, 0, 1], port))
}

/** Builds the bare-bones Rust backend router with health and WebSocket endpoints. */
pub fn build_app(state: SharedServerState) -> Router {
  Router::new()
    .route("/health", get(health_handler))
    .route("/ws", get(websocket_handler))
    .with_state(state)
}

/** Starts serving the bare-bones Rust backend on the provided listener. */
pub async fn run_server(listener: TcpListener) -> std::io::Result<()> {
  axum::serve(listener, build_app(SharedServerState::default())).await
}

/** Returns a small health response for the live frontend integration test. */
async fn health_handler() -> &'static str {
  "ok"
}

/** Upgrades one HTTP request into a session-backed WebSocket connection. */
async fn websocket_handler(
  websocket: WebSocketUpgrade,
  State(state): State<SharedServerState>,
) -> Response {
  websocket.on_upgrade(move |socket| handle_socket(socket, state))
}

/** Handles one WebSocket connection against the shared server-owned session state. */
async fn handle_socket(socket: WebSocket, state: SharedServerState) {
  let (mut sender, mut receiver) = socket.split();

  let Some(Ok(Message::Text(payload))) = receiver.next().await else {
    return;
  };

  let Ok(ClientSessionMessage::Connect(connect_message)) = parse_client_message(&payload) else {
    let _ = send_server_message(
      &mut sender,
      &ServerSessionMessage::SessionError(SessionErrorMessage {
        message_type: "session_error",
        message: "The first session message must be connect.".to_string(),
      }),
    )
    .await;
    return;
  };

  let session_id = connect_message.session_id;
  let (snapshot, mut session_events) = state.join_session(&session_id).await;

  if send_server_message(&mut sender, &ServerSessionMessage::SessionSnapshot(snapshot))
    .await
    .is_err()
  {
    return;
  }

  loop {
    tokio::select! {
      maybe_socket_message = receiver.next() => {
        match maybe_socket_message {
          Some(Ok(Message::Text(payload))) => {
            let Ok(message) = parse_client_message(&payload) else {
              let _ = send_server_message(
                &mut sender,
                &ServerSessionMessage::SessionError(SessionErrorMessage {
                  message_type: "session_error",
                  message: "The session server received an invalid message.".to_string(),
                }),
              )
              .await;
              continue;
            };

            if let Err(message) = state.handle_client_message(&session_id, message).await {
              let _ = send_server_message(
                &mut sender,
                &ServerSessionMessage::SessionError(SessionErrorMessage {
                  message_type: "session_error",
                  message,
                }),
              )
              .await;
            }
          }
          Some(Ok(Message::Close(_))) | None => return,
          Some(Ok(_)) => {}
          Some(Err(_)) => return,
        }
      }
      received_message = session_events.recv() => {
        match received_message {
          Ok(message) => {
            if send_server_message(&mut sender, &message).await.is_err() {
              return;
            }
          }
          Err(broadcast::error::RecvError::Lagged(_)) => {
            let snapshot = state.snapshot_session(&session_id).await;
            let message = ServerSessionMessage::SessionSnapshot(snapshot);

            if send_server_message(&mut sender, &message).await.is_err() {
              return;
            }
          }
          Err(broadcast::error::RecvError::Closed) => return,
        }
      }
    }
  }
}

/** Parses one incoming JSON payload into a client session message. */
fn parse_client_message(payload: &str) -> serde_json::Result<ClientSessionMessage> {
  serde_json::from_str(payload)
}

/** Sends one JSON-encoded server message across the active WebSocket sink. */
async fn send_server_message(
  sender: &mut SplitSink<WebSocket, Message>,
  message: &ServerSessionMessage,
) -> Result<(), axum::Error> {
  let payload = serde_json::to_string(message).expect("server session messages should serialize");
  sender.send(Message::Text(payload.into())).await
}

/** Returns one placeholder assistant response for a submitted user message. */
fn placeholder_assistant_reply(text: &str) -> String {
  format!("Rust backend received: {text}")
}

impl SharedServerState {
  /** Joins one server-owned session and returns its current snapshot plus event stream. */
  async fn join_session(
    &self,
    session_id: &str,
  ) -> (SessionSnapshotMessage, broadcast::Receiver<ServerSessionMessage>) {
    let mut sessions = self.sessions.lock().await;
    let session = sessions
      .entry(session_id.to_string())
      .or_insert_with(ServerSession::new);

    (
      SessionSnapshotMessage {
        message_type: "session_snapshot",
        session_id: session_id.to_string(),
        entries: session.entries.clone(),
      },
      session.broadcaster.subscribe(),
    )
  }

  /** Returns the latest full snapshot for one server-owned session. */
  async fn snapshot_session(&self, session_id: &str) -> SessionSnapshotMessage {
    let mut sessions = self.sessions.lock().await;
    let session = sessions
      .entry(session_id.to_string())
      .or_insert_with(ServerSession::new);

    SessionSnapshotMessage {
      message_type: "session_snapshot",
      session_id: session_id.to_string(),
      entries: session.entries.clone(),
    }
  }

  /** Applies one client message to the targeted server-owned session. */
  async fn handle_client_message(
    &self,
    session_id: &str,
    message: ClientSessionMessage,
  ) -> Result<(), String> {
    match message {
      ClientSessionMessage::Connect(_) => Ok(()),
      ClientSessionMessage::UserMessage(request) => {
        if request.session_id != session_id {
          return Err("The submitted session id did not match the active connection.".to_string());
        }

        self.append_conversation_turns(session_id, request.text).await;
        Ok(())
      }
    }
  }

  /** Appends one user turn plus one placeholder assistant turn to the session transcript. */
  async fn append_conversation_turns(&self, session_id: &str, text: String) {
    let (broadcaster, user_entry, assistant_entry) = {
      let mut sessions = self.sessions.lock().await;
      let session = sessions
        .entry(session_id.to_string())
        .or_insert_with(ServerSession::new);

      let user_entry = session.create_entry(ConversationRole::User, text.clone());
      let assistant_entry =
        session.create_entry(ConversationRole::Assistant, placeholder_assistant_reply(&text));

      session.entries.push(user_entry.clone());
      session.entries.push(assistant_entry.clone());

      (
        session.broadcaster.clone(),
        user_entry,
        assistant_entry,
      )
    };

    let _ = broadcaster.send(ServerSessionMessage::ConversationEntry(
      ConversationEntryMessage {
        message_type: "conversation_entry",
        entry: user_entry,
      },
    ));
    let _ = broadcaster.send(ServerSessionMessage::ConversationEntry(
      ConversationEntryMessage {
        message_type: "conversation_entry",
        entry: assistant_entry,
      },
    ));
  }
}

impl ServerSession {
  /** Creates one empty server session with its own append broadcast channel. */
  fn new() -> Self {
    let (broadcaster, _) = broadcast::channel(64);

    Self {
      entries: Vec::new(),
      next_entry_id: 1,
      broadcaster,
    }
  }

  /** Creates one new transcript entry with a stable server-owned identifier. */
  fn create_entry(&mut self, role: ConversationRole, content: String) -> ConversationEntry {
    let entry = ConversationEntry {
      id: self.next_entry_id.to_string(),
      role,
      content,
    };

    self.next_entry_id += 1;
    entry
  }
}
