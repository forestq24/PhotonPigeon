//! pigeon-bridge: a local iMessage transport for PhotonPigeon.
//!
//! Signs a dedicated Apple ID into iMessage through rustpush (via Corten's
//! wrapper) and exposes send/receive, including app balloons such as
//! GamePigeon cards, as newline-delimited JSON over a Unix socket.
//!
//!   pigeon-bridge login [--state-dir DIR]
//!   pigeon-bridge run   [--state-dir DIR] [--socket PATH]
//!
//! This file is copied into Corten's `pkg/rustpushgo/src/bin/` by
//! scripts/setup.sh and built there. See ../README.md for the protocol.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use rustpushgo::{
    connect, create_local_macos_config, create_local_macos_config_with_device_id, init_logger,
    login_start, new_client, restore_token_provider, Client, MessageCallback, UpdateUsersCallback,
    WrappedAPSConnection, WrappedAPSState, WrappedConversation, WrappedIDSNGMIdentity,
    WrappedIDSUsers, WrappedMessage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc};

const STATE_FILE: &str = "state.json";
const APS_CHECKPOINT_SECS: u64 = 300;

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
struct Account {
    username: String,
    hashed_password_hex: String,
    pet: String,
    adsid: String,
    dsid: String,
    spd_base64: String,
    persist_blob: Option<String>,
    mme_delegate_json: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct State {
    schema: u32,
    device_id: String,
    aps_state: String,
    ids_users: String,
    ids_identity: String,
    account: Account,
}

struct Store {
    path: PathBuf,
    state: Mutex<State>,
}

impl Store {
    fn update(&self, f: impl FnOnce(&mut State)) {
        let mut state = self.state.lock().unwrap();
        f(&mut state);
        if let Err(err) = write_state(&self.path, &state) {
            eprintln!("[bridge] failed to persist state: {err}");
        }
    }
}

/// Atomic, owner-only write. The file holds account tokens, so it is never world-readable.
fn write_state(path: &Path, state: &State) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    file.write_all(&body).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn read_state(path: &Path) -> Result<State, String> {
    let body = std::fs::read(path)
        .map_err(|e| format!("cannot read {}: {e}. Run `pigeon-bridge login` first.", path.display()))?;
    serde_json::from_slice(&body).map_err(|e| format!("{} is not valid state: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Terminal input (credentials never come from argv or the environment)
// ---------------------------------------------------------------------------

fn prompt_line(prompt: &str, echo: bool) -> Result<String, String> {
    let tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|e| format!("needs an interactive terminal: {e}"))?;
    let fd = tty.as_raw_fd();
    let mut saved: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(fd, &mut saved) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if !echo {
        let mut silent = saved;
        silent.c_lflag &= !libc::ECHO;
        unsafe { libc::tcsetattr(fd, libc::TCSANOW, &silent) };
    }
    let mut out = &tty;
    let _ = write!(out, "{prompt}");
    let _ = out.flush();
    let mut line = String::new();
    let result = std::io::BufReader::new(&tty).read_line(&mut line);
    if !echo {
        unsafe { libc::tcsetattr(fd, libc::TCSANOW, &saved) };
        let _ = writeln!(out);
    }
    result.map_err(|e| e.to_string())?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

async fn login(state_dir: &Path) -> Result<(), String> {
    let state_path = state_dir.join(STATE_FILE);
    if state_path.exists() {
        return Err(format!(
            "{} already exists. Remove it to sign in again (this registers a new device).",
            state_path.display()
        ));
    }

    let config = create_local_macos_config().map_err(|e| e.to_string())?;
    let aps_state = WrappedAPSState::new(None);
    println!("Connecting to Apple Push Service…");
    let connection = connect(&config, &aps_state).await;

    let result = login_inner(&config, &connection, &state_path).await;
    connection.close();
    result
}

async fn login_inner(
    config: &Arc<rustpushgo::WrappedOSConfig>,
    connection: &Arc<WrappedAPSConnection>,
    state_path: &Path,
) -> Result<(), String> {
    let apple_id = prompt_line("Bot Apple ID: ", true)?;
    let password = prompt_line("Password (hidden): ", false)?;
    if apple_id.trim().is_empty() || password.is_empty() {
        return Err("Apple ID and password are required".into());
    }

    println!("Signing in…");
    let session = login_start(apple_id, password, config, connection)
        .await
        .map_err(|e| e.to_string())?;

    if session.needs_2fa() {
        let code = prompt_line("Two-factor code: ", true)?;
        let accepted = session
            .submit_2fa(code.trim().to_string())
            .await
            .map_err(|e| e.to_string())?;
        if !accepted {
            return Err("Apple did not accept the two-factor code".into());
        }
    }

    println!("Registering this Mac with iMessage…");
    let result = session
        .finish(config, connection, None, None)
        .await
        .map_err(|e| e.to_string())?;

    let persist = result
        .account_persist
        .ok_or("login returned no restorable account state")?;
    let (persist_blob, mme_delegate_json) = match &result.token_provider {
        Some(tp) => (
            tp.get_account_persist_blob().await.map_err(|e| e.to_string())?,
            tp.get_mme_delegate_json().await.map_err(|e| e.to_string())?,
        ),
        None => (None, None),
    };

    let handles = result.users.get_handles();
    if handles.is_empty() {
        return Err("registration returned no iMessage handles".into());
    }

    let state = State {
        schema: 1,
        device_id: config.get_device_id(),
        aps_state: connection.state().await.to_string(),
        ids_users: result.users.to_string(),
        ids_identity: result.identity.to_string(),
        account: Account {
            username: persist.username,
            hashed_password_hex: persist.hashed_password_hex,
            pet: persist.pet,
            adsid: persist.adsid,
            dsid: persist.dsid,
            spd_base64: persist.spd_base64,
            persist_blob,
            mme_delegate_json,
        },
    };
    write_state(state_path, &state)?;

    println!("Signed in. People can reach the bot at:");
    for handle in handles {
        println!("  {handle}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

struct MessageSink(mpsc::UnboundedSender<WrappedMessage>);

impl MessageCallback for MessageSink {
    fn on_message(&self, msg: WrappedMessage) {
        let _ = self.0.send(msg);
    }
}

struct UsersSink(Arc<Store>);

impl UpdateUsersCallback for UsersSink {
    fn update_users(&self, users: Arc<WrappedIDSUsers>) {
        let serialized = users.to_string();
        if !serialized.is_empty() {
            self.0.update(|s| s.ids_users = serialized);
        }
    }
}

/// What we know about a 1:1 conversation, learned from inbound messages.
#[derive(Clone)]
struct Chat {
    participants: Vec<String>,
    sender_guid: Option<String>,
    our_handle: String,
}

struct Bridge {
    client: Arc<Client>,
    handles: Vec<String>,
    default_handle: String,
    chats: Mutex<HashMap<String, Chat>>,
    events: broadcast::Sender<String>,
}

impl Bridge {
    fn is_ours(&self, handle: &str) -> bool {
        self.handles.iter().any(|h| h.eq_ignore_ascii_case(handle))
    }

    fn ready_event(&self) -> String {
        json!({ "type": "ready", "handles": self.handles, "default_handle": self.default_handle }).to_string()
    }

    fn conversation(&self, chat_id: &str) -> (WrappedConversation, String) {
        let known = self.chats.lock().unwrap().get(chat_id).cloned();
        let chat = known.unwrap_or_else(|| Chat {
            participants: vec![self.default_handle.clone(), chat_id.to_string()],
            sender_guid: None,
            our_handle: self.default_handle.clone(),
        });
        (
            WrappedConversation {
                participants: chat.participants,
                group_name: None,
                sender_guid: chat.sender_guid,
                is_sms: false,
            },
            chat.our_handle,
        )
    }

    /// Turn a rustpush message into a bridge event. Returns None for control
    /// messages the agent has no use for.
    fn to_event(&self, msg: &WrappedMessage) -> Option<Value> {
        let sender = msg.sender.clone().unwrap_or_default();
        let from_me = self.is_ours(&sender);
        let others: Vec<&String> = msg.participants.iter().filter(|p| !self.is_ours(p)).collect();
        let is_group = others.len() > 1;
        let chat_id = if is_group {
            format!("group:{}", msg.sender_guid.clone().unwrap_or_default())
        } else if let Some(peer) = others.first() {
            (*peer).clone()
        } else {
            sender.clone()
        };

        if !is_group && !chat_id.is_empty() && !msg.participants.is_empty() {
            let our_handle = msg
                .participants
                .iter()
                .find(|p| self.is_ours(p))
                .cloned()
                .unwrap_or_else(|| self.default_handle.clone());
            self.chats.lock().unwrap().insert(
                chat_id.clone(),
                Chat { participants: msg.participants.clone(), sender_guid: msg.sender_guid.clone(), our_handle },
            );
        }

        let base = |kind: &str| {
            json!({
                "type": kind,
                "id": msg.uuid,
                "chat": chat_id,
                "sender": sender,
                "from_me": from_me,
                "is_group": is_group,
                "timestamp_ms": msg.timestamp_ms,
            })
        };

        if msg.is_error {
            let mut ev = base("send_error");
            ev["for"] = json!(msg.error_for_uuid);
            ev["status"] = json!(msg.error_status);
            ev["status_text"] = json!(msg.error_status_str);
            return Some(ev);
        }
        if msg.is_delivered {
            return Some(base("delivered"));
        }
        if msg.is_read_receipt {
            return Some(base("read"));
        }
        if msg.is_typing {
            return Some(base("typing"));
        }
        // A tapback that carries an app card is a session reply (a game move), handled below.
        if msg.is_tapback && msg.app_bundle_id.is_none() {
            let mut ev = base("tapback");
            ev["target"] = json!(msg.tapback_target_uuid);
            ev["kind"] = json!(msg.tapback_type);
            ev["emoji"] = json!(msg.tapback_emoji);
            ev["remove"] = json!(msg.tapback_remove);
            return Some(ev);
        }
        if msg.text.is_none() && msg.app_bundle_id.is_none() {
            // Nothing the agent acts on. Report its kind (never its content) so an
            // unexpected message type is visible instead of silently dropped.
            let flags: Vec<&str> = [
                ("edit", msg.is_edit),
                ("unsend", msg.is_unsend),
                ("rename", msg.is_rename),
                ("participant_change", msg.is_participant_change),
                ("update_extension", msg.is_update_extension),
                ("peer_cache_invalidate", msg.is_peer_cache_invalidate),
                ("icon_change", msg.is_icon_change),
                ("mark_unread", msg.is_mark_unread),
                ("read_on_device", msg.is_message_read_on_device),
                ("share_profile", msg.is_share_profile),
                ("update_profile", msg.is_update_profile),
                ("notify_anyways", msg.is_notify_anyways),
            ]
            .iter()
            .filter(|(_, on)| *on)
            .map(|(name, _)| *name)
            .collect();
            let mut ev = base("other");
            ev["flags"] = json!(flags);
            ev["for"] = json!(msg.update_extension_for_uuid);
            ev["attachments"] = json!(msg.attachments.len());
            return Some(ev);
        }

        let mut ev = base("message");
        ev["text"] = json!(msg.text);
        ev["stored"] = json!(msg.is_stored_message);
        ev["participants"] = json!(msg.participants);
        if msg.is_tapback {
            // The earlier card in the same app session that this one replies to.
            ev["reply_to"] = json!(msg.tapback_target_uuid);
        }
        if let Some(bundle_id) = &msg.app_bundle_id {
            ev["balloon"] = json!({
                "bundle_id": bundle_id,
                "app_name": msg.app_name,
                "adam_id": msg.app_adam_id,
                "url": msg.balloon_url,
                "session": msg.balloon_session,
                "caption": msg.balloon_caption,
                "subcaption": msg.balloon_subcaption,
                "ld_text": msg.balloon_ld_text,
                "live": msg.balloon_is_live,
                "icon_b64": msg.balloon_icon.as_ref().map(|i| base64::engine::general_purpose::STANDARD.encode(i)),
            });
        }
        Some(ev)
    }

    async fn dispatch(&self, req: &Value) -> Result<Value, String> {
        let op = req["op"].as_str().ok_or("missing op")?;
        if op == "ping" {
            return Ok(json!({}));
        }
        let chat = req["chat"].as_str().ok_or("missing chat")?;
        if chat.starts_with("group:") {
            return Err("group chats are not supported".into());
        }
        let (conversation, handle) = self.conversation(chat);
        let str_opt = |key: &str| req[key].as_str().map(str::to_string);

        match op {
            "send_text" => {
                let text = req["text"].as_str().ok_or("missing text")?.to_string();
                let id = self
                    .client
                    .send_message(conversation, text, None, handle, None, None, None)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({ "id": id }))
            }
            "send_balloon" => {
                let bundle_id = str_opt("bundle_id").ok_or("missing bundle_id")?;
                let app_name = str_opt("app_name").ok_or("missing app_name")?;
                let url = str_opt("url").ok_or("missing url")?;
                let session = str_opt("session");
                if let Some(s) = &session {
                    // rustpush unwraps the UUID parse; reject bad input here instead of panicking there.
                    if !is_uuid(s) {
                        return Err("session must be a UUID".into());
                    }
                }
                let icon = match req["icon_b64"].as_str() {
                    Some(b64) => Some(
                        base64::engine::general_purpose::STANDARD
                            .decode(b64)
                            .map_err(|e| format!("icon_b64: {e}"))?,
                    ),
                    None => None,
                };
                let id = self
                    .client
                    .send_balloon(
                        conversation,
                        handle,
                        bundle_id,
                        app_name,
                        req["adam_id"].as_u64(),
                        url,
                        session,
                        str_opt("caption"),
                        str_opt("subcaption"),
                        str_opt("ld_text"),
                        req["live"].as_bool().unwrap_or(false),
                        icon,
                        str_opt("breadcrumb"),
                        str_opt("reply_to"),
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({ "id": id }))
            }
            "tapback" => {
                let target = str_opt("target").ok_or("missing target")?;
                let (reaction, emoji) = match req["reaction"].as_str().unwrap_or("") {
                    "love" => (0, None),
                    "like" => (1, None),
                    "dislike" => (2, None),
                    "laugh" => (3, None),
                    "emphasize" => (4, None),
                    "question" => (5, None),
                    other if !other.is_empty() => (6, Some(other.to_string())),
                    _ => return Err("missing reaction".into()),
                };
                let id = self
                    .client
                    .send_tapback(
                        conversation,
                        target,
                        req["part"].as_u64().unwrap_or(0),
                        reaction,
                        emoji,
                        req["remove"].as_bool().unwrap_or(false),
                        handle,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({ "id": id }))
            }
            "typing" => {
                self.client
                    .send_typing(conversation, req["active"].as_bool().unwrap_or(true), handle)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({}))
            }
            other => Err(format!("unknown op: {other}")),
        }
    }
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

async fn serve_connection(bridge: Arc<Bridge>, stream: UnixStream) {
    let (read_half, mut write_half) = stream.into_split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let _ = out_tx.send(bridge.ready_event());

    let mut events = bridge.events.subscribe();
    let event_tx = out_tx.clone();
    let forward = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(line) => {
                    if event_tx.send(line).is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let writer = tokio::spawn(async move {
        while let Some(line) = out_rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err()
                || write_half.write_all(b"\n").await.is_err()
            {
                break;
            }
        }
    });

    let mut lines = BufReader::new(read_half).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let bridge = bridge.clone();
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            let response = match serde_json::from_str::<Value>(&line) {
                Ok(req) => {
                    let req_id = req["req"].clone();
                    match bridge.dispatch(&req).await {
                        Ok(mut body) => {
                            body["type"] = json!("response");
                            body["req"] = req_id;
                            body["ok"] = json!(true);
                            body
                        }
                        Err(error) => json!({ "type": "response", "req": req_id, "ok": false, "error": error }),
                    }
                }
                Err(e) => json!({ "type": "response", "req": null, "ok": false, "error": format!("bad json: {e}") }),
            };
            let _ = out_tx.send(response.to_string());
        });
    }

    forward.abort();
    drop(out_tx);
    let _ = writer.await;
}

async fn run(state_dir: &Path, socket_path: &Path) -> Result<(), String> {
    let state_path = state_dir.join(STATE_FILE);
    let state = read_state(&state_path)?;
    let store = Arc::new(Store { path: state_path, state: Mutex::new(state.clone()) });

    let config = create_local_macos_config_with_device_id(state.device_id.clone()).map_err(|e| e.to_string())?;
    let aps_state = WrappedAPSState::new(Some(state.aps_state.clone()));
    let connection = connect(&config, &aps_state).await;

    let account = state.account.clone();
    let token_provider = restore_token_provider(
        &config,
        &connection,
        account.username,
        account.hashed_password_hex,
        account.pet,
        account.spd_base64,
        account.persist_blob,
    )
    .await
    .map_err(|e| e.to_string())?;
    if let Some(delegate) = account.mme_delegate_json {
        token_provider.seed_mme_delegate_json(delegate).await.map_err(|e| e.to_string())?;
    }

    let users = WrappedIDSUsers::new(Some(state.ids_users.clone()));
    let identity = WrappedIDSNGMIdentity::new(Some(state.ids_identity.clone()));
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<WrappedMessage>();
    let client = new_client(
        &connection,
        &users,
        &identity,
        &config,
        Some(token_provider),
        Box::new(MessageSink(msg_tx)),
        Box::new(UsersSink(store.clone())),
    )
    .await
    .map_err(|e| e.to_string())?;

    let handles = client.get_handles().await;
    let default_handle = handles.first().cloned().ok_or("no registered iMessage handles")?;
    let (events, _) = broadcast::channel::<String>(1024);
    let bridge = Arc::new(Bridge {
        client,
        handles,
        default_handle,
        chats: Mutex::new(HashMap::new()),
        events,
    });

    // Inbound messages -> events.
    let inbound_bridge = bridge.clone();
    tokio::spawn(async move {
        while let Some(msg) = msg_rx.recv().await {
            if let Some(event) = inbound_bridge.to_event(&msg) {
                let is_inbound_message = event["type"] == "message" && event["from_me"] == false;
                let chat = event["chat"].as_str().unwrap_or_default().to_string();
                // One line per event, without content, so the bridge window shows what arrived
                // even when no client is connected (events are not replayed later).
                println!(
                    "[bridge] {} chat={} from_me={} card={} flags={} listeners={}",
                    event["type"].as_str().unwrap_or("?"),
                    chat,
                    event["from_me"],
                    !event["balloon"].is_null(),
                    event["flags"],
                    inbound_bridge.events.receiver_count(),
                );
                let _ = inbound_bridge.events.send(event.to_string());
                if is_inbound_message && !chat.starts_with("group:") && !msg.is_stored_message {
                    let (conversation, handle) = inbound_bridge.conversation(&chat);
                    if let Err(e) = inbound_bridge.client.send_delivery_receipt(conversation, handle).await {
                        eprintln!("[bridge] delivery receipt failed: {e}");
                    }
                }
            }
        }
    });

    // Periodic APS state checkpoint, so a restart resumes the same push token.
    let checkpoint_store = store.clone();
    let checkpoint_conn = connection.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(APS_CHECKPOINT_SECS)).await;
            let aps = checkpoint_conn.state().await.to_string();
            if !aps.is_empty() {
                checkpoint_store.update(|s| s.aps_state = aps);
            }
        }
    });

    let _ = std::fs::remove_file(socket_path);
    let listener = UnixListener::bind(socket_path).map_err(|e| format!("bind {}: {e}", socket_path.display()))?;
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    println!("[bridge] ready. handles: {:?}", bridge.handles);
    println!("[bridge] listening on {}", socket_path.display());

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|e| e.to_string())?;
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => { tokio::spawn(serve_connection(bridge.clone(), stream)); }
                Err(e) => eprintln!("[bridge] accept failed: {e}"),
            },
            _ = tokio::signal::ctrl_c() => break,
            _ = sigterm.recv() => break,
        }
    }

    println!("[bridge] shutting down");
    let aps = connection.state().await.to_string();
    if !aps.is_empty() {
        store.update(|s| s.aps_state = aps);
    }
    bridge.client.stop().await;
    connection.close();
    let _ = std::fs::remove_file(socket_path);
    Ok(())
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

fn usage() -> ! {
    eprintln!("usage: pigeon-bridge <login|run> [--state-dir DIR] [--socket PATH]");
    std::process::exit(2);
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| usage());
    let mut state_dir: Option<PathBuf> = None;
    let mut socket: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--state-dir" => state_dir = Some(PathBuf::from(args.next().unwrap_or_else(|| usage()))),
            "--socket" => socket = Some(PathBuf::from(args.next().unwrap_or_else(|| usage()))),
            _ => usage(),
        }
    }
    let state_dir = state_dir.unwrap_or_else(|| {
        PathBuf::from(std::env::var("HOME").expect("HOME is not set")).join(".pigeon-bridge")
    });

    unsafe { libc::umask(0o077) };
    if let Err(e) = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&state_dir) {
        eprintln!("cannot create {}: {e}", state_dir.display());
        std::process::exit(1);
    }
    let state_dir = state_dir.canonicalize().expect("state dir");
    let socket = socket.unwrap_or_else(|| state_dir.join("bridge.sock"));

    // rustpush keeps anisette and cache files under XDG_DATA_HOME and ./state.
    std::env::set_var("XDG_DATA_HOME", state_dir.join("xdg"));
    if std::env::var_os("RUST_LOG").is_none() {
        std::env::set_var("RUST_LOG", "warn");
    }
    std::env::set_current_dir(&state_dir).expect("chdir state dir");
    init_logger();

    let result = match command.as_str() {
        "login" => login(&state_dir).await,
        "run" => run(&state_dir, &socket).await,
        _ => usage(),
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
