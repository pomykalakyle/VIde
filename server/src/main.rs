use tokio::net::TcpListener;

use server::{run_server, server_socket_addr};

/** Starts the bare-bones VIde Rust backend on the configured local socket. */
#[tokio::main]
async fn main() -> std::io::Result<()> {
  let listener = TcpListener::bind(server_socket_addr()).await?;
  run_server(listener).await
}
