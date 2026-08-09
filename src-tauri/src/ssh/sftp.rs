use super::session::NextDeskSshClient;
use super::types::{
    SftpCreateDirectoryRequest, SftpEntry, SftpEntryKind, SftpListRequest, SftpListResponse,
    SftpOpenResponse, SftpReadTextRequest, SftpReadTextResponse, SftpRemoveRequest,
    SftpRenameRequest, SftpSetPermissionsRequest, SftpTransferDirection, SftpTransferEvent,
    SftpTransferRequest, SftpTransferState, SftpWriteTextRequest,
};
use russh::client;
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

const SFTP_CHANNEL_TIMEOUT: Duration = Duration::from_secs(15);
const SFTP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);
const SFTP_TRANSFER_CHUNK_SIZE: usize = 256 * 1024;
const SFTP_TEXT_FILE_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Clone)]
struct ActiveTransfer {
    cancellation: CancellationToken,
    completed: CancellationToken,
}

pub enum SftpControl {
    Open {
        reply: oneshot::Sender<Result<SftpOpenResponse, String>>,
    },
    List {
        request: SftpListRequest,
        reply: oneshot::Sender<Result<SftpListResponse, String>>,
    },
    Upload {
        request: SftpTransferRequest,
        on_progress: Channel<SftpTransferEvent>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Download {
        request: SftpTransferRequest,
        on_progress: Channel<SftpTransferEvent>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Cancel {
        transfer_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    CreateDirectory {
        request: SftpCreateDirectoryRequest,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Rename {
        request: SftpRenameRequest,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Remove {
        request: SftpRemoveRequest,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ReadText {
        request: SftpReadTextRequest,
        reply: oneshot::Sender<Result<SftpReadTextResponse, String>>,
    },
    WriteText {
        request: SftpWriteTextRequest,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetPermissions {
        request: SftpSetPermissionsRequest,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

#[derive(Default)]
pub struct SftpRuntime {
    session: Option<Arc<SftpSession>>,
    home_path: Option<String>,
    transfers: Arc<Mutex<HashMap<String, ActiveTransfer>>>,
    mutations: Arc<tokio::sync::Mutex<()>>,
}

impl SftpRuntime {
    pub async fn handle(&mut self, control: SftpControl, ssh: &client::Handle<NextDeskSshClient>) {
        match control {
            SftpControl::Open { reply } => {
                let result = self.open(ssh).await;
                let _ = reply.send(result);
            }
            SftpControl::List { request, reply } => {
                let Some(session) = self.session.clone() else {
                    let _ = reply.send(Err("sftp_session_not_open".to_string()));
                    return;
                };
                tauri::async_runtime::spawn(async move {
                    let result = list_directory(session, request).await;
                    let _ = reply.send(result);
                });
            }
            SftpControl::Upload {
                request,
                on_progress,
                reply,
            } => self.start_transfer(SftpTransferDirection::Upload, request, on_progress, reply),
            SftpControl::Download {
                request,
                on_progress,
                reply,
            } => self.start_transfer(SftpTransferDirection::Download, request, on_progress, reply),
            SftpControl::Cancel { transfer_id, reply } => {
                if let Some(transfer) = self.transfers.lock().unwrap().get(&transfer_id) {
                    transfer.cancellation.cancel();
                }
                let _ = reply.send(Ok(()));
            }
            SftpControl::CreateDirectory { request, reply } => {
                let Some(session) = self.session.clone() else {
                    let _ = reply.send(Err("sftp_session_not_open".to_string()));
                    return;
                };
                let mutations = Arc::clone(&self.mutations);
                tauri::async_runtime::spawn(async move {
                    let _guard = mutations.lock().await;
                    let result = create_directory(&session, request).await;
                    let _ = reply.send(result);
                });
            }
            SftpControl::Rename { request, reply } => {
                let Some(session) = self.session.clone() else {
                    let _ = reply.send(Err("sftp_session_not_open".to_string()));
                    return;
                };
                let mutations = Arc::clone(&self.mutations);
                tauri::async_runtime::spawn(async move {
                    let _guard = mutations.lock().await;
                    let result = rename_remote_path(&session, request).await;
                    let _ = reply.send(result);
                });
            }
            SftpControl::Remove { request, reply } => {
                let Some(session) = self.session.clone() else {
                    let _ = reply.send(Err("sftp_session_not_open".to_string()));
                    return;
                };
                let mutations = Arc::clone(&self.mutations);
                tauri::async_runtime::spawn(async move {
                    let _guard = mutations.lock().await;
                    let result = remove_remote_request(&session, request).await;
                    let _ = reply.send(result);
                });
            }
            SftpControl::ReadText { request, reply } => {
                let Some(session) = self.session.clone() else {
                    let _ = reply.send(Err("sftp_session_not_open".to_string()));
                    return;
                };
                tauri::async_runtime::spawn(async move {
                    let result = read_text_file(&session, request).await;
                    let _ = reply.send(result);
                });
            }
            SftpControl::WriteText { request, reply } => {
                let Some(session) = self.session.clone() else {
                    let _ = reply.send(Err("sftp_session_not_open".to_string()));
                    return;
                };
                let mutations = Arc::clone(&self.mutations);
                tauri::async_runtime::spawn(async move {
                    let _guard = mutations.lock().await;
                    let result = write_text_file(&session, request).await;
                    let _ = reply.send(result);
                });
            }
            SftpControl::SetPermissions { request, reply } => {
                let Some(session) = self.session.clone() else {
                    let _ = reply.send(Err("sftp_session_not_open".to_string()));
                    return;
                };
                let mutations = Arc::clone(&self.mutations);
                tauri::async_runtime::spawn(async move {
                    let _guard = mutations.lock().await;
                    let result = set_permissions(&session, request).await;
                    let _ = reply.send(result);
                });
            }
        }
    }

    fn start_transfer(
        &self,
        direction: SftpTransferDirection,
        request: SftpTransferRequest,
        on_progress: Channel<SftpTransferEvent>,
        reply: oneshot::Sender<Result<(), String>>,
    ) {
        if let Err(error) = request.validate() {
            let _ = reply.send(Err(error));
            return;
        }
        let Some(session) = self.session.clone() else {
            let _ = reply.send(Err("sftp_session_not_open".to_string()));
            return;
        };
        let cancellation = CancellationToken::new();
        let completed = CancellationToken::new();
        {
            let mut transfers = self.transfers.lock().unwrap();
            if transfers.contains_key(&request.transfer_id) {
                let _ = reply.send(Err("sftp_transfer_already_exists".to_string()));
                return;
            }
            transfers.insert(
                request.transfer_id.clone(),
                ActiveTransfer {
                    cancellation: cancellation.clone(),
                    completed: completed.clone(),
                },
            );
        }
        let transfers = Arc::clone(&self.transfers);
        let mutations = Arc::clone(&self.mutations);
        let transferred_bytes = Arc::new(AtomicU64::new(0));
        let total_bytes = Arc::new(AtomicU64::new(0));
        tauri::async_runtime::spawn(async move {
            emit_transfer(
                &on_progress,
                &request,
                direction,
                SftpTransferState::Queued,
                0,
                0,
                None,
            );
            let result = match direction {
                SftpTransferDirection::Upload => {
                    if request.recursive {
                        upload_directory(
                            &session,
                            &request,
                            &cancellation,
                            &on_progress,
                            &transferred_bytes,
                            &total_bytes,
                            &mutations,
                        )
                        .await
                    } else {
                        upload_file(
                            &session,
                            &request,
                            &cancellation,
                            &on_progress,
                            &transferred_bytes,
                            &total_bytes,
                            &mutations,
                        )
                        .await
                    }
                }
                SftpTransferDirection::Download => {
                    if request.recursive {
                        download_directory(
                            &session,
                            &request,
                            &cancellation,
                            &on_progress,
                            &transferred_bytes,
                            &total_bytes,
                            &mutations,
                        )
                        .await
                    } else {
                        download_file(
                            &session,
                            &request,
                            &cancellation,
                            &on_progress,
                            &transferred_bytes,
                            &total_bytes,
                            &mutations,
                        )
                        .await
                    }
                }
            };
            let (state, message) = match &result {
                Ok(()) => (SftpTransferState::Completed, None),
                Err(error) if error == "sftp_transfer_cancelled" => {
                    (SftpTransferState::Cancelled, Some(error.clone()))
                }
                Err(error) => (SftpTransferState::Failed, Some(error.clone())),
            };
            emit_transfer(
                &on_progress,
                &request,
                direction,
                state,
                transferred_bytes.load(Ordering::Relaxed),
                total_bytes.load(Ordering::Relaxed),
                message,
            );
            transfers.lock().unwrap().remove(&request.transfer_id);
            completed.cancel();
            let _ = reply.send(result);
        });
    }

    async fn open(
        &mut self,
        ssh: &client::Handle<NextDeskSshClient>,
    ) -> Result<SftpOpenResponse, String> {
        if let (Some(_), Some(path)) = (&self.session, &self.home_path) {
            return Ok(SftpOpenResponse { path: path.clone() });
        }

        let channel = tokio::time::timeout(SFTP_CHANNEL_TIMEOUT, ssh.channel_open_session())
            .await
            .map_err(|_| "sftp_channel_timeout".to_string())?
            .map_err(|_| "sftp_channel_open_failed".to_string())?;
        tokio::time::timeout(
            SFTP_CHANNEL_TIMEOUT,
            channel.request_subsystem(true, "sftp"),
        )
        .await
        .map_err(|_| "sftp_subsystem_timeout".to_string())?
        .map_err(|_| "sftp_subsystem_unavailable".to_string())?;
        let session = tokio::time::timeout(
            SFTP_CHANNEL_TIMEOUT,
            SftpSession::new(channel.into_stream()),
        )
        .await
        .map_err(|_| "sftp_handshake_timeout".to_string())?
        .map_err(|_| "sftp_handshake_failed".to_string())?;
        let path = tokio::time::timeout(SFTP_CHANNEL_TIMEOUT, session.canonicalize("."))
            .await
            .map_err(|_| "sftp_home_timeout".to_string())?
            .map_err(|_| "sftp_home_unavailable".to_string())?;
        self.home_path = Some(path.clone());
        self.session = Some(Arc::new(session));
        Ok(SftpOpenResponse { path })
    }

    pub async fn shutdown(&mut self) {
        let transfers = self
            .transfers
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for transfer in &transfers {
            transfer.cancellation.cancel();
        }
        let wait_for_cleanup = async {
            for transfer in &transfers {
                transfer.completed.cancelled().await;
            }
        };
        if tokio::time::timeout(SFTP_SHUTDOWN_TIMEOUT, wait_for_cleanup)
            .await
            .is_err()
        {
            log::warn!("[ssh] timed out waiting for SFTP transfers to stop cleanly");
        }
        if let Some(session) = self.session.take() {
            let _ = session.close().await;
        }
        self.home_path = None;
    }
}

async fn read_text_file(
    session: &SftpSession,
    request: SftpReadTextRequest,
) -> Result<SftpReadTextResponse, String> {
    request.validate()?;
    let metadata = session
        .metadata(request.path.clone())
        .await
        .map_err(|_| "sftp_remote_stat_failed".to_string())?;
    if metadata.is_dir() {
        return Err("sftp_remote_file_required".to_string());
    }
    if metadata.size.unwrap_or(0) > SFTP_TEXT_FILE_LIMIT {
        return Err("sftp_text_file_too_large".to_string());
    }
    let file = session
        .open(request.path.clone())
        .await
        .map_err(|_| "sftp_remote_open_failed".to_string())?;
    let mut contents = Vec::new();
    file.take(SFTP_TEXT_FILE_LIMIT + 1)
        .read_to_end(&mut contents)
        .await
        .map_err(|_| "sftp_remote_read_failed".to_string())?;
    if contents.len() as u64 > SFTP_TEXT_FILE_LIMIT {
        return Err("sftp_text_file_too_large".to_string());
    }
    let content = String::from_utf8(contents).map_err(|_| "sftp_text_file_invalid".to_string())?;
    Ok(SftpReadTextResponse {
        path: request.path,
        content,
        modified: metadata.mtime.map(u64::from),
        permissions: metadata.permissions,
    })
}

async fn write_text_file(
    session: &SftpSession,
    request: SftpWriteTextRequest,
) -> Result<(), String> {
    request.validate()?;
    let metadata = session
        .metadata(request.path.clone())
        .await
        .map_err(|_| "sftp_remote_stat_failed".to_string())?;
    if metadata.is_dir() {
        return Err("sftp_remote_file_required".to_string());
    }
    let temporary = remote_side_path(
        &request.path,
        &format!("nextdesk-edit-{}.part", request.operation_id),
    )?;
    let _ = session.remove_file(temporary.clone()).await;
    let mut remote = session
        .create(temporary.clone())
        .await
        .map_err(|_| "sftp_remote_create_failed".to_string())?;
    let result = async {
        remote
            .write_all(request.content.as_bytes())
            .await
            .map_err(|_| "sftp_remote_write_failed".to_string())?;
        remote
            .shutdown()
            .await
            .map_err(|_| "sftp_remote_close_failed".to_string())?;
        if let Some(permissions) = metadata.permissions {
            let mut attributes = russh_sftp::protocol::FileAttributes::empty();
            attributes.permissions = Some(permissions);
            session
                .set_metadata(temporary.clone(), attributes)
                .await
                .map_err(|_| "sftp_remote_permissions_failed".to_string())?;
        }
        commit_remote_file(
            session,
            &temporary,
            &request.path,
            true,
            &request.operation_id,
        )
        .await
    }
    .await;
    if result.is_err() {
        let _ = session.remove_file(temporary).await;
    }
    result
}

async fn set_permissions(
    session: &SftpSession,
    request: SftpSetPermissionsRequest,
) -> Result<(), String> {
    request.validate()?;
    let mut attributes = russh_sftp::protocol::FileAttributes::empty();
    attributes.permissions = Some(request.permissions);
    session
        .set_metadata(request.path, attributes)
        .await
        .map_err(|_| "sftp_remote_permissions_failed".to_string())
}

fn emit_transfer(
    channel: &Channel<SftpTransferEvent>,
    request: &SftpTransferRequest,
    direction: SftpTransferDirection,
    state: SftpTransferState,
    transferred_bytes: u64,
    total_bytes: u64,
    message: Option<String>,
) {
    let _ = channel.send(SftpTransferEvent {
        transfer_id: request.transfer_id.clone(),
        direction,
        state,
        transferred_bytes,
        total_bytes,
        message,
    });
}

async fn upload_file(
    session: &SftpSession,
    request: &SftpTransferRequest,
    cancellation: &CancellationToken,
    progress: &Channel<SftpTransferEvent>,
    transferred_bytes: &AtomicU64,
    total_bytes: &AtomicU64,
    mutations: &tokio::sync::Mutex<()>,
) -> Result<(), String> {
    let mut local = tokio::fs::File::open(&request.local_path)
        .await
        .map_err(|_| "sftp_local_open_failed".to_string())?;
    let metadata = local
        .metadata()
        .await
        .map_err(|_| "sftp_local_metadata_failed".to_string())?;
    if !metadata.is_file() {
        return Err("sftp_local_file_required".to_string());
    }
    let total = metadata.len();
    total_bytes.store(total, Ordering::Relaxed);
    if remote_exists(session, &request.remote_path).await? && !request.overwrite {
        return Err("sftp_remote_exists".to_string());
    }

    let temporary = remote_side_path(
        &request.remote_path,
        &format!("nextdesk-upload-{}.part", request.transfer_id),
    )?;
    let _ = session.remove_file(temporary.clone()).await;
    let mut remote = session
        .create(temporary.clone())
        .await
        .map_err(|_| "sftp_remote_create_failed".to_string())?;
    let result = async {
        let mut buffer = vec![0u8; SFTP_TRANSFER_CHUNK_SIZE];
        let mut transferred = 0u64;
        emit_transfer(
            progress,
            request,
            SftpTransferDirection::Upload,
            SftpTransferState::Running,
            transferred,
            total,
            None,
        );
        loop {
            let read = tokio::select! {
                _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
                result = local.read(&mut buffer) => result.map_err(|_| "sftp_local_read_failed".to_string())?,
            };
            if read == 0 {
                break;
            }
            tokio::select! {
                _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
                result = remote.write_all(&buffer[..read]) => result.map_err(|_| "sftp_remote_write_failed".to_string())?,
            }
            transferred += read as u64;
            transferred_bytes.store(transferred, Ordering::Relaxed);
            emit_transfer(
                progress,
                request,
                SftpTransferDirection::Upload,
                SftpTransferState::Running,
                transferred,
                total,
                None,
            );
        }
        remote
            .shutdown()
            .await
            .map_err(|_| "sftp_remote_close_failed".to_string())?;
        if cancellation.is_cancelled() {
            return Err("sftp_transfer_cancelled".to_string());
        }
        let _guard = tokio::select! {
            _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
            guard = mutations.lock() => guard,
        };
        commit_remote_file(
            session,
            &temporary,
            &request.remote_path,
            request.overwrite,
            &request.transfer_id,
        )
        .await
    }
    .await;
    if result.is_err() {
        let _ = session.remove_file(temporary).await;
    }
    result
}

async fn download_file(
    session: &SftpSession,
    request: &SftpTransferRequest,
    cancellation: &CancellationToken,
    progress: &Channel<SftpTransferEvent>,
    transferred_bytes: &AtomicU64,
    total_bytes: &AtomicU64,
    mutations: &tokio::sync::Mutex<()>,
) -> Result<(), String> {
    let remote_metadata = session
        .metadata(request.remote_path.clone())
        .await
        .map_err(|_| "sftp_remote_stat_failed".to_string())?;
    if remote_metadata.is_dir() {
        return Err("sftp_remote_file_required".to_string());
    }
    let target = PathBuf::from(&request.local_path);
    if local_exists(&target).await? && !request.overwrite {
        return Err("sftp_local_exists".to_string());
    }
    let temporary = local_side_path(
        &target,
        &format!("nextdesk-download-{}.part", request.transfer_id),
    )?;
    let _ = tokio::fs::remove_file(&temporary).await;
    let mut remote = session
        .open(request.remote_path.clone())
        .await
        .map_err(|_| "sftp_remote_open_failed".to_string())?;
    let mut local = tokio::fs::File::create(&temporary)
        .await
        .map_err(|_| "sftp_local_create_failed".to_string())?;
    let total = remote_metadata.size.unwrap_or(0);
    total_bytes.store(total, Ordering::Relaxed);
    let result = async {
        let mut buffer = vec![0u8; SFTP_TRANSFER_CHUNK_SIZE];
        let mut transferred = 0u64;
        emit_transfer(
            progress,
            request,
            SftpTransferDirection::Download,
            SftpTransferState::Running,
            transferred,
            total,
            None,
        );
        loop {
            let read = tokio::select! {
                _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
                result = remote.read(&mut buffer) => result.map_err(|_| "sftp_remote_read_failed".to_string())?,
            };
            if read == 0 {
                break;
            }
            tokio::select! {
                _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
                result = local.write_all(&buffer[..read]) => result.map_err(|_| "sftp_local_write_failed".to_string())?,
            }
            transferred += read as u64;
            transferred_bytes.store(transferred, Ordering::Relaxed);
            emit_transfer(
                progress,
                request,
                SftpTransferDirection::Download,
                SftpTransferState::Running,
                transferred,
                total,
                None,
            );
        }
        local
            .flush()
            .await
            .map_err(|_| "sftp_local_flush_failed".to_string())?;
        local
            .sync_all()
            .await
            .map_err(|_| "sftp_local_sync_failed".to_string())?;
        if cancellation.is_cancelled() {
            return Err("sftp_transfer_cancelled".to_string());
        }
        let _guard = tokio::select! {
            _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
            guard = mutations.lock() => guard,
        };
        commit_local_file(&temporary, &target, request.overwrite, &request.transfer_id).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[derive(Debug)]
struct LocalTreeFile {
    local_path: PathBuf,
    relative_path: PathBuf,
    size: u64,
}

#[derive(Debug)]
struct RemoteTreeFile {
    remote_path: String,
    relative_path: PathBuf,
    size: u64,
}

async fn collect_local_tree(
    root: &Path,
) -> Result<(Vec<PathBuf>, Vec<LocalTreeFile>, u64), String> {
    let metadata = tokio::fs::metadata(root)
        .await
        .map_err(|_| "sftp_local_metadata_failed".to_string())?;
    if !metadata.is_dir() {
        return Err("sftp_local_directory_required".to_string());
    }
    let mut directories = vec![PathBuf::new()];
    let mut files = Vec::new();
    let mut total = 0u64;
    let mut stack = vec![(root.to_path_buf(), PathBuf::new(), 0usize)];
    while let Some((current, relative, depth)) = stack.pop() {
        if depth > 64 {
            return Err("sftp_transfer_depth_exceeded".to_string());
        }
        let mut entries = tokio::fs::read_dir(&current)
            .await
            .map_err(|_| "sftp_local_read_directory_failed".to_string())?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|_| "sftp_local_read_directory_failed".to_string())?
        {
            let file_type = entry
                .file_type()
                .await
                .map_err(|_| "sftp_local_metadata_failed".to_string())?;
            let next_relative = relative.join(entry.file_name());
            if file_type.is_dir() {
                directories.push(next_relative.clone());
                stack.push((entry.path(), next_relative, depth + 1));
            } else if file_type.is_file() {
                let size = entry
                    .metadata()
                    .await
                    .map_err(|_| "sftp_local_metadata_failed".to_string())?
                    .len();
                total = total.saturating_add(size);
                files.push(LocalTreeFile {
                    local_path: entry.path(),
                    relative_path: next_relative,
                    size,
                });
            }
            if directories.len() + files.len() > 100_000 {
                return Err("sftp_transfer_entry_limit".to_string());
            }
        }
    }
    directories.sort_by_key(|path| path.components().count());
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok((directories, files, total))
}

async fn collect_remote_tree(
    session: &SftpSession,
    root: &str,
) -> Result<(Vec<PathBuf>, Vec<RemoteTreeFile>, u64), String> {
    let metadata = session
        .metadata(root.to_string())
        .await
        .map_err(|_| "sftp_remote_stat_failed".to_string())?;
    if !metadata.is_dir() {
        return Err("sftp_remote_directory_required".to_string());
    }
    let mut directories = vec![PathBuf::new()];
    let mut files = Vec::new();
    let mut total = 0u64;
    let mut stack = vec![(root.to_string(), PathBuf::new(), 0usize)];
    while let Some((current, relative, depth)) = stack.pop() {
        if depth > 64 {
            return Err("sftp_transfer_depth_exceeded".to_string());
        }
        let entries = session
            .read_dir(current)
            .await
            .map_err(|_| "sftp_list_failed".to_string())?;
        for entry in entries {
            let name = entry.file_name();
            if name.is_empty()
                || name == "."
                || name == ".."
                || name.contains('/')
                || name.contains('\0')
            {
                return Err("sftp_remote_path_invalid".to_string());
            }
            let next_relative = relative.join(&name);
            let file_type = entry.file_type();
            if file_type.is_dir() {
                directories.push(next_relative.clone());
                stack.push((entry.path(), next_relative, depth + 1));
            } else if file_type.is_file() {
                let size = entry.metadata().size.unwrap_or(0);
                total = total.saturating_add(size);
                files.push(RemoteTreeFile {
                    remote_path: entry.path(),
                    relative_path: next_relative,
                    size,
                });
            }
            if directories.len() + files.len() > 100_000 {
                return Err("sftp_transfer_entry_limit".to_string());
            }
        }
    }
    directories.sort_by_key(|path| path.components().count());
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok((directories, files, total))
}

fn remote_join_path(root: &str, relative: &Path) -> Result<String, String> {
    let mut result = root.trim_end_matches('/').to_string();
    for component in relative.components() {
        let part = component
            .as_os_str()
            .to_str()
            .filter(|value| {
                !value.is_empty()
                    && *value != "."
                    && *value != ".."
                    && !value.contains('/')
                    && !value.contains('\\')
                    && !value.contains('\0')
            })
            .ok_or_else(|| "sftp_local_path_invalid".to_string())?;
        result.push('/');
        result.push_str(part);
    }
    Ok(if result.is_empty() {
        "/".to_string()
    } else {
        result
    })
}

async fn upload_directory(
    session: &SftpSession,
    request: &SftpTransferRequest,
    cancellation: &CancellationToken,
    progress: &Channel<SftpTransferEvent>,
    transferred_bytes: &AtomicU64,
    total_bytes: &AtomicU64,
    mutations: &tokio::sync::Mutex<()>,
) -> Result<(), String> {
    let root = PathBuf::from(&request.local_path);
    let (directories, files, total) = collect_local_tree(&root).await?;
    total_bytes.store(total, Ordering::Relaxed);
    if remote_exists(session, &request.remote_path).await? && !request.overwrite {
        return Err("sftp_remote_exists".to_string());
    }
    let temporary = remote_side_path(
        &request.remote_path,
        &format!("nextdesk-upload-{}.part", request.transfer_id),
    )?;
    if remote_exists(session, &temporary).await? {
        remove_remote_path(session, temporary.clone(), true).await?;
    }
    session
        .create_dir(temporary.clone())
        .await
        .map_err(|_| "sftp_create_directory_failed".to_string())?;
    let result = async {
        for relative in directories.iter().skip(1) {
            if cancellation.is_cancelled() {
                return Err("sftp_transfer_cancelled".to_string());
            }
            session
                .create_dir(remote_join_path(&temporary, relative)?)
                .await
                .map_err(|_| "sftp_create_directory_failed".to_string())?;
        }
        emit_transfer(
            progress,
            request,
            SftpTransferDirection::Upload,
            SftpTransferState::Running,
            0,
            total,
            None,
        );
        for file in files {
            if cancellation.is_cancelled() {
                return Err("sftp_transfer_cancelled".to_string());
            }
            let mut local = tokio::fs::File::open(&file.local_path)
                .await
                .map_err(|_| "sftp_local_open_failed".to_string())?;
            let mut remote = session
                .create(remote_join_path(&temporary, &file.relative_path)?)
                .await
                .map_err(|_| "sftp_remote_create_failed".to_string())?;
            let mut buffer = vec![0u8; SFTP_TRANSFER_CHUNK_SIZE];
            let mut file_transferred = 0u64;
            while file_transferred < file.size {
                let read = tokio::select! {
                    _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
                    result = local.read(&mut buffer) => result.map_err(|_| "sftp_local_read_failed".to_string())?,
                };
                if read == 0 {
                    break;
                }
                tokio::select! {
                    _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
                    result = remote.write_all(&buffer[..read]) => result.map_err(|_| "sftp_remote_write_failed".to_string())?,
                }
                file_transferred += read as u64;
                let transferred = transferred_bytes
                    .fetch_add(read as u64, Ordering::Relaxed)
                    .saturating_add(read as u64);
                emit_transfer(
                    progress,
                    request,
                    SftpTransferDirection::Upload,
                    SftpTransferState::Running,
                    transferred,
                    total,
                    None,
                );
            }
            remote
                .shutdown()
                .await
                .map_err(|_| "sftp_remote_close_failed".to_string())?;
        }
        let _guard = tokio::select! {
            _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
            guard = mutations.lock() => guard,
        };
        commit_remote_directory(
            session,
            &temporary,
            &request.remote_path,
            request.overwrite,
            &request.transfer_id,
        )
        .await
    }
    .await;
    if result.is_err() && remote_exists(session, &temporary).await.unwrap_or(false) {
        let _ = remove_remote_path(session, temporary, true).await;
    }
    result
}

async fn download_directory(
    session: &SftpSession,
    request: &SftpTransferRequest,
    cancellation: &CancellationToken,
    progress: &Channel<SftpTransferEvent>,
    transferred_bytes: &AtomicU64,
    total_bytes: &AtomicU64,
    mutations: &tokio::sync::Mutex<()>,
) -> Result<(), String> {
    let (directories, files, total) = collect_remote_tree(session, &request.remote_path).await?;
    total_bytes.store(total, Ordering::Relaxed);
    let target = PathBuf::from(&request.local_path);
    if local_path_exists(&target).await? && !request.overwrite {
        return Err("sftp_local_exists".to_string());
    }
    let temporary = local_side_path(
        &target,
        &format!("nextdesk-download-{}.part", request.transfer_id),
    )?;
    if local_path_exists(&temporary).await? {
        remove_local_path(&temporary).await?;
    }
    tokio::fs::create_dir(&temporary)
        .await
        .map_err(|_| "sftp_local_create_failed".to_string())?;
    let result = async {
        for relative in directories.iter().skip(1) {
            if cancellation.is_cancelled() {
                return Err("sftp_transfer_cancelled".to_string());
            }
            tokio::fs::create_dir(temporary.join(relative))
                .await
                .map_err(|_| "sftp_local_create_failed".to_string())?;
        }
        emit_transfer(
            progress,
            request,
            SftpTransferDirection::Download,
            SftpTransferState::Running,
            0,
            total,
            None,
        );
        for file in files {
            if cancellation.is_cancelled() {
                return Err("sftp_transfer_cancelled".to_string());
            }
            let mut remote = session
                .open(file.remote_path)
                .await
                .map_err(|_| "sftp_remote_open_failed".to_string())?;
            let mut local = tokio::fs::File::create(temporary.join(file.relative_path))
                .await
                .map_err(|_| "sftp_local_create_failed".to_string())?;
            let mut buffer = vec![0u8; SFTP_TRANSFER_CHUNK_SIZE];
            let mut file_transferred = 0u64;
            while file_transferred < file.size {
                let read = tokio::select! {
                    _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
                    result = remote.read(&mut buffer) => result.map_err(|_| "sftp_remote_read_failed".to_string())?,
                };
                if read == 0 {
                    break;
                }
                tokio::select! {
                    _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
                    result = local.write_all(&buffer[..read]) => result.map_err(|_| "sftp_local_write_failed".to_string())?,
                }
                file_transferred += read as u64;
                let transferred = transferred_bytes
                    .fetch_add(read as u64, Ordering::Relaxed)
                    .saturating_add(read as u64);
                emit_transfer(
                    progress,
                    request,
                    SftpTransferDirection::Download,
                    SftpTransferState::Running,
                    transferred,
                    total,
                    None,
                );
            }
            local
                .flush()
                .await
                .map_err(|_| "sftp_local_flush_failed".to_string())?;
        }
        let _guard = tokio::select! {
            _ = cancellation.cancelled() => return Err("sftp_transfer_cancelled".to_string()),
            guard = mutations.lock() => guard,
        };
        commit_local_directory(
            &temporary,
            &target,
            request.overwrite,
            &request.transfer_id,
        )
        .await
    }
    .await;
    if result.is_err() && local_path_exists(&temporary).await.unwrap_or(false) {
        let _ = remove_local_path(&temporary).await;
    }
    result
}

async fn commit_remote_directory(
    session: &SftpSession,
    temporary: &str,
    target: &str,
    overwrite: bool,
    transfer_id: &str,
) -> Result<(), String> {
    if !remote_exists(session, target).await? {
        return session
            .rename(temporary.to_string(), target.to_string())
            .await
            .map_err(|_| "sftp_remote_commit_failed".to_string());
    }
    if !overwrite {
        return Err("sftp_remote_exists".to_string());
    }
    let backup = remote_side_path(target, &format!("nextdesk-overwrite-{transfer_id}.backup"))?;
    if remote_exists(session, &backup).await? {
        remove_remote_path(session, backup.clone(), true).await?;
    }
    session
        .rename(target.to_string(), backup.clone())
        .await
        .map_err(|_| "sftp_remote_backup_failed".to_string())?;
    if session
        .rename(temporary.to_string(), target.to_string())
        .await
        .is_err()
    {
        let _ = session.rename(backup, target.to_string()).await;
        return Err("sftp_remote_commit_failed".to_string());
    }
    let _ = remove_remote_path(session, backup, true).await;
    Ok(())
}

async fn commit_local_directory(
    temporary: &Path,
    target: &Path,
    overwrite: bool,
    transfer_id: &str,
) -> Result<(), String> {
    if !local_path_exists(target).await? {
        return tokio::fs::rename(temporary, target)
            .await
            .map_err(|_| "sftp_local_commit_failed".to_string());
    }
    if !overwrite {
        return Err("sftp_local_exists".to_string());
    }
    let backup = local_side_path(target, &format!("nextdesk-overwrite-{transfer_id}.backup"))?;
    if local_path_exists(&backup).await? {
        remove_local_path(&backup).await?;
    }
    tokio::fs::rename(target, &backup)
        .await
        .map_err(|_| "sftp_local_backup_failed".to_string())?;
    if tokio::fs::rename(temporary, target).await.is_err() {
        let _ = tokio::fs::rename(&backup, target).await;
        return Err("sftp_local_commit_failed".to_string());
    }
    let _ = remove_local_path(&backup).await;
    Ok(())
}

async fn local_path_exists(path: &Path) -> Result<bool, String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("sftp_local_stat_failed".to_string()),
    }
}

async fn remove_local_path(path: &Path) -> Result<(), String> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| "sftp_local_stat_failed".to_string())?;
    if metadata.is_dir() {
        tokio::fs::remove_dir_all(path)
            .await
            .map_err(|_| "sftp_local_remove_failed".to_string())
    } else {
        tokio::fs::remove_file(path)
            .await
            .map_err(|_| "sftp_local_remove_failed".to_string())
    }
}

async fn commit_remote_file(
    session: &SftpSession,
    temporary: &str,
    target: &str,
    overwrite: bool,
    transfer_id: &str,
) -> Result<(), String> {
    if !remote_exists(session, target).await? {
        return session
            .rename(temporary.to_string(), target.to_string())
            .await
            .map_err(|_| "sftp_remote_commit_failed".to_string());
    }
    if !overwrite {
        return Err("sftp_remote_exists".to_string());
    }
    let metadata = session
        .symlink_metadata(target.to_string())
        .await
        .map_err(|_| "sftp_remote_stat_failed".to_string())?;
    if metadata.is_dir() {
        return Err("sftp_remote_target_not_file".to_string());
    }
    let backup = remote_side_path(target, &format!("nextdesk-overwrite-{transfer_id}.backup"))?;
    let _ = session.remove_file(backup.clone()).await;
    session
        .rename(target.to_string(), backup.clone())
        .await
        .map_err(|_| "sftp_remote_backup_failed".to_string())?;
    if session
        .rename(temporary.to_string(), target.to_string())
        .await
        .is_err()
    {
        let _ = session.rename(backup, target.to_string()).await;
        return Err("sftp_remote_commit_failed".to_string());
    }
    let _ = session.remove_file(backup).await;
    Ok(())
}

async fn commit_local_file(
    temporary: &Path,
    target: &Path,
    overwrite: bool,
    transfer_id: &str,
) -> Result<(), String> {
    if !local_exists(target).await? {
        return tokio::fs::rename(temporary, target)
            .await
            .map_err(|_| "sftp_local_commit_failed".to_string());
    }
    if !overwrite {
        return Err("sftp_local_exists".to_string());
    }
    let backup = local_side_path(target, &format!("nextdesk-overwrite-{transfer_id}.backup"))?;
    let _ = tokio::fs::remove_file(&backup).await;
    tokio::fs::rename(target, &backup)
        .await
        .map_err(|_| "sftp_local_backup_failed".to_string())?;
    if tokio::fs::rename(temporary, target).await.is_err() {
        let _ = tokio::fs::rename(&backup, target).await;
        return Err("sftp_local_commit_failed".to_string());
    }
    let _ = tokio::fs::remove_file(backup).await;
    Ok(())
}

async fn local_exists(path: &Path) -> Result<bool, String> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err("sftp_local_target_not_file".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("sftp_local_stat_failed".to_string()),
    }
}

async fn remote_exists(session: &SftpSession, path: &str) -> Result<bool, String> {
    match session.symlink_metadata(path.to_string()).await {
        Ok(_) => Ok(true),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
        {
            Ok(false)
        }
        Err(_) => Err("sftp_remote_stat_failed".to_string()),
    }
}

fn remote_side_path(target: &str, suffix: &str) -> Result<String, String> {
    let (parent, name) = target
        .rsplit_once('/')
        .map_or(("", target), |(parent, name)| (parent, name));
    if name.is_empty() {
        return Err("sftp_remote_path_invalid".to_string());
    }
    let generated = format!(".{name}.{suffix}");
    Ok(if parent.is_empty() {
        generated
    } else if parent == "/" {
        format!("/{generated}")
    } else {
        format!("{parent}/{generated}")
    })
}

fn local_side_path(target: &Path, suffix: &str) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "sftp_local_path_invalid".to_string())?;
    Ok(target.with_file_name(format!(".{name}.{suffix}")))
}

async fn create_directory(
    session: &SftpSession,
    request: SftpCreateDirectoryRequest,
) -> Result<(), String> {
    request.validate()?;
    if remote_exists(session, &request.path).await? {
        return Err("sftp_remote_exists".to_string());
    }
    session
        .create_dir(request.path)
        .await
        .map_err(|_| "sftp_create_directory_failed".to_string())
}

async fn rename_remote_path(
    session: &SftpSession,
    request: SftpRenameRequest,
) -> Result<(), String> {
    request.validate()?;
    if !remote_exists(session, &request.from_path).await? {
        return Err("sftp_remote_source_missing".to_string());
    }
    if !remote_exists(session, &request.to_path).await? {
        return session
            .rename(request.from_path, request.to_path)
            .await
            .map_err(|_| "sftp_rename_failed".to_string());
    }
    if !request.overwrite {
        return Err("sftp_remote_exists".to_string());
    }

    let backup = remote_side_path(
        &request.to_path,
        &format!("nextdesk-rename-{}.backup", request.operation_id),
    )?;
    if remote_exists(session, &backup).await? {
        remove_remote_path(session, backup.clone(), true).await?;
    }
    session
        .rename(request.to_path.clone(), backup.clone())
        .await
        .map_err(|_| "sftp_remote_backup_failed".to_string())?;
    if session
        .rename(request.from_path, request.to_path.clone())
        .await
        .is_err()
    {
        let _ = session.rename(backup, request.to_path).await;
        return Err("sftp_rename_failed".to_string());
    }
    let _ = remove_remote_path(session, backup, true).await;
    Ok(())
}

async fn remove_remote_request(
    session: &SftpSession,
    request: SftpRemoveRequest,
) -> Result<(), String> {
    request.validate()?;
    remove_remote_path(session, request.path, request.recursive).await
}

async fn remove_remote_path(
    session: &SftpSession,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    let metadata = session
        .symlink_metadata(path.clone())
        .await
        .map_err(|_| "sftp_remote_stat_failed".to_string())?;
    if !metadata.is_dir() {
        return session
            .remove_file(path)
            .await
            .map_err(|_| "sftp_remove_failed".to_string());
    }
    if !recursive {
        return session
            .remove_dir(path)
            .await
            .map_err(|_| "sftp_remove_failed".to_string());
    }

    let mut stack = vec![(path, false, 0usize)];
    while let Some((current, expanded, depth)) = stack.pop() {
        if depth > 64 {
            return Err("sftp_remove_depth_exceeded".to_string());
        }
        let metadata = session
            .symlink_metadata(current.clone())
            .await
            .map_err(|_| "sftp_remote_stat_failed".to_string())?;
        if !metadata.is_dir() {
            session
                .remove_file(current)
                .await
                .map_err(|_| "sftp_remove_failed".to_string())?;
            continue;
        }
        if expanded {
            session
                .remove_dir(current)
                .await
                .map_err(|_| "sftp_remove_failed".to_string())?;
            continue;
        }
        let entries = session
            .read_dir(current.clone())
            .await
            .map_err(|_| "sftp_list_failed".to_string())?;
        stack.push((current, true, depth));
        for entry in entries {
            stack.push((entry.path(), false, depth + 1));
        }
    }
    Ok(())
}

async fn list_directory(
    session: Arc<SftpSession>,
    request: SftpListRequest,
) -> Result<SftpListResponse, String> {
    request.validate()?;
    let path = session
        .canonicalize(request.path)
        .await
        .map_err(|_| "sftp_path_unavailable".to_string())?;
    let directory = session
        .read_dir(path.clone())
        .await
        .map_err(|_| "sftp_list_failed".to_string())?;
    let mut entries = directory
        .map(|entry| {
            let metadata = entry.metadata();
            let file_type = entry.file_type();
            SftpEntry {
                name: entry.file_name(),
                path: entry.path(),
                kind: if file_type.is_dir() {
                    SftpEntryKind::Directory
                } else if file_type.is_file() {
                    SftpEntryKind::File
                } else if file_type.is_symlink() {
                    SftpEntryKind::Symlink
                } else {
                    SftpEntryKind::Other
                },
                size: metadata.size.unwrap_or(0),
                modified: metadata.mtime.map(u64::from),
                permissions: metadata.permissions,
                owner: metadata.user,
                group: metadata.group,
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        let left_rank = usize::from(left.kind != SftpEntryKind::Directory);
        let right_rank = usize::from(right.kind != SftpEntryKind::Directory);
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(SftpListResponse { path, entries })
}

#[cfg(test)]
mod tests {
    use super::{collect_local_tree, remote_join_path};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn joins_local_relative_components_into_remote_paths() {
        assert_eq!(
            remote_join_path("/home/root/archive", Path::new("logs/app.log")),
            Ok("/home/root/archive/logs/app.log".to_string())
        );
        assert!(remote_join_path("/home/root", Path::new("../escape")).is_err());
    }

    #[tokio::test]
    async fn scans_local_directory_trees_for_recursive_uploads() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "nextdesk-sftp-tree-{}-{suffix}",
            std::process::id()
        ));
        tokio::fs::create_dir_all(root.join("logs")).await.unwrap();
        tokio::fs::write(root.join("empty.txt"), []).await.unwrap();
        tokio::fs::write(root.join("logs/app.log"), b"hello")
            .await
            .unwrap();

        let (directories, files, total) = collect_local_tree(&root).await.unwrap();

        assert!(directories.contains(&PathBuf::from("logs")));
        assert!(files
            .iter()
            .any(|file| file.relative_path == PathBuf::from("logs/app.log")));
        assert_eq!(total, 5);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
