use super::*;
use crate::ssh::sftp::SftpControl;
use crate::ssh::test_support::{within, Block, Fixture};
use crate::ssh::types::{SftpListRequest, SftpTransferRequest};
use tokio::sync::oneshot;

fn start(
    fixture: &mut Fixture,
    fail_output: bool,
) -> (
    mpsc::Sender<SshControl>,
    CancellationToken,
    tokio::task::JoinHandle<Result<(), SessionFailure>>,
) {
    let (sender, receiver) = mpsc::channel(128);
    let cancellation = CancellationToken::new();
    let shutdown = cancellation.clone();
    let ssh = fixture.ssh.clone();
    let channel = fixture.channel.take().unwrap();
    let task = tokio::spawn(async move {
        let output = Channel::new(move |_| {
            if fail_output {
                Err(std::io::Error::other("output closed").into())
            } else {
                Ok(())
            }
        });
        run_connected_session(
            ssh,
            channel.split(),
            receiver,
            &output,
            &shutdown,
            |_| {},
            || async {},
        )
        .await
    });
    (sender, cancellation, task)
}

async fn open_sftp(sender: &mpsc::Sender<SshControl>) {
    let (reply, response) = oneshot::channel();
    sender
        .send(SshControl::Sftp(SftpControl::Open { reply }))
        .await
        .unwrap();
    within(response).await.unwrap().unwrap();
}

#[tokio::test]
async fn every_terminal_exit_reaps_monitor_and_sftp_open_holding_runtime_lock() {
    for exit in [
        "normal",
        "output_error",
        "cancel",
        "close",
        "sender_dropped",
        "transport_lost",
    ] {
        let mut fixture = Fixture::new(false, None).await;
        let (sender, cancellation, task) = start(&mut fixture, exit == "output_error");
        let (monitor_reply, monitor_result) = oneshot::channel();
        sender
            .send(SshControl::Monitor {
                reply: monitor_reply,
            })
            .await
            .unwrap();
        assert_eq!(within(fixture.events.recv()).await, Some("monitor"));
        let (open_reply, open_result) = oneshot::channel();
        sender
            .send(SshControl::Sftp(SftpControl::Open { reply: open_reply }))
            .await
            .unwrap();
        assert_eq!(within(fixture.events.recv()).await, Some("sftp"));

        match exit {
            "normal" => {
                fixture
                    .server
                    .exit_status_request(fixture.terminal, 0)
                    .await
                    .unwrap();
                fixture.server.eof(fixture.terminal).await.unwrap();
            }
            "output_error" => fixture
                .server
                .data(fixture.terminal, b"hello"[..].into())
                .await
                .unwrap(),
            "cancel" => cancellation.cancel(),
            "close" => sender.send(SshControl::Close).await.unwrap(),
            "sender_dropped" => {}
            "transport_lost" => fixture
                .server
                .disconnect(Disconnect::ByApplication, "test".into(), "en".into())
                .await
                .unwrap(),
            _ => unreachable!(),
        }
        let sender = if exit == "sender_dropped" {
            drop(sender);
            None
        } else {
            Some(sender)
        };
        let result = within(task).await.unwrap();
        match exit {
            "output_error" => assert!(
                matches!(result, Err(SessionFailure::Message(ref value)) if value.starts_with("ssh_output_channel_failed:"))
            ),
            "transport_lost" => assert!(
                matches!(result, Err(SessionFailure::Message(ref value)) if value == "ssh_transport_lost")
            ),
            _ => assert!(result.is_ok(), "{exit}: {result:?}"),
        }
        assert!(!matches!(within(monitor_result).await, Ok(Ok(_))));
        assert!(!matches!(within(open_result).await, Ok(Ok(_))));
        drop(sender);
        fixture.finish().await;
    }
}

#[tokio::test]
async fn cancellation_rejects_queued_controls_and_unblocks_full_queue_senders() {
    let mut fixture = Fixture::new(true, None).await;
    let channel = fixture.channel.take().unwrap();
    let (sender, receiver) = mpsc::channel(1);
    let (reply, response) = oneshot::channel();
    sender.send(SshControl::Monitor { reply }).await.unwrap();
    let blocked_sender = sender.clone();
    let blocked =
        tokio::spawn(async move { blocked_sender.send(SshControl::Input(vec![1])).await });
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let output = Channel::new(|_| Ok(()));
    within(run_connected_session(
        fixture.ssh.clone(),
        channel.split(),
        receiver,
        &output,
        &cancellation,
        |_| {},
        || async {},
    ))
    .await
    .unwrap();
    assert!(within(response).await.is_err());
    assert!(within(blocked).await.unwrap().is_err());
    assert!(sender.is_closed());
    assert!(fixture.events.try_recv().is_err());
    fixture.finish().await;
}

#[tokio::test]
async fn output_error_cancels_and_joins_an_active_directory_listing() {
    let block = Block::new("opendir");
    let mut fixture = Fixture::new(true, Some(block.clone())).await;
    let (sender, cancellation, task) = start(&mut fixture, true);
    open_sftp(&sender).await;
    let (reply, response) = oneshot::channel();
    sender
        .send(SshControl::Sftp(SftpControl::List {
            request: SftpListRequest {
                session_id: "test".into(),
                path: "/".into(),
            },
            reply,
        }))
        .await
        .unwrap();
    within(block.started.cancelled()).await;
    fixture
        .server
        .data(fixture.terminal, b"output"[..].into())
        .await
        .unwrap();
    let result = within(task).await.unwrap();
    assert!(
        matches!(result, Err(SessionFailure::Message(value)) if value.starts_with("ssh_output_channel_failed:"))
    );
    assert_eq!(
        within(response).await.unwrap().unwrap_err(),
        "sftp_session_closed"
    );
    block.release.cancel();
    assert!(sender.is_closed());
    assert!(!cancellation.is_cancelled());
    within(fixture.sftp_closed.cancelled()).await;
    fixture.finish().await;
}

#[tokio::test]
async fn closing_during_upload_or_download_cleans_partial_files_and_preserves_targets() {
    for upload in [true, false] {
        let block = Block::new(if upload { "write" } else { "read" });
        let mut fixture = Fixture::new(true, Some(block.clone())).await;
        fixture
            .files
            .lock()
            .unwrap()
            .contents
            .insert("/target".into(), b"old remote data".to_vec());
        let root =
            std::env::temp_dir().join(format!("nextdesk-ssh-transfer-{}", rand::random::<u64>()));
        tokio::fs::create_dir(&root).await.unwrap();
        let local = root.join("target");
        tokio::fs::write(&local, b"old local data").await.unwrap();
        let (sender, cancellation, task) = start(&mut fixture, false);
        open_sftp(&sender).await;
        let request = SftpTransferRequest {
            session_id: "test".into(),
            transfer_id: "active".into(),
            local_path: local.to_str().unwrap().into(),
            remote_path: "/target".into(),
            overwrite: true,
            recursive: false,
        };
        let (reply, response) = oneshot::channel();
        let on_progress = Channel::new(|_| Ok(()));
        let control = if upload {
            SftpControl::Upload {
                request,
                on_progress,
                reply,
            }
        } else {
            SftpControl::Download {
                request,
                on_progress,
                reply,
            }
        };
        sender.send(SshControl::Sftp(control)).await.unwrap();
        within(block.started.cancelled()).await;
        cancellation.cancel();
        // The session must close admission before waiting for transfer cleanup.
        within(sender.closed()).await;
        block.release.cancel();
        assert!(within(task).await.unwrap().is_ok());
        assert_eq!(
            within(response).await.unwrap(),
            Err("sftp_transfer_cancelled".into())
        );
        assert_eq!(tokio::fs::read(&local).await.unwrap(), b"old local data");
        assert!(!root.join(".target.nextdesk-download-active.part").exists());
        {
            let files = fixture.files.lock().unwrap();
            assert_eq!(files.contents.get("/target").unwrap(), b"old remote data");
            assert!(!files
                .contents
                .contains_key("/.target.nextdesk-upload-active.part"));
            if upload {
                let close = files
                    .operations
                    .iter()
                    .position(|event| event == "close:/.target.nextdesk-upload-active.part")
                    .unwrap();
                let remove = files
                    .operations
                    .iter()
                    .position(|event| event == "remove:/.target.nextdesk-upload-active.part")
                    .unwrap();
                assert!(close < remove);
            }
        }
        within(fixture.sftp_closed.cancelled()).await;
        fixture.finish().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}

#[tokio::test]
async fn input_and_resize_write_failures_reap_pending_children() {
    for resize in [false, true] {
        let mut closed_transport = Fixture::new(false, None).await;
        let (_, failed_writer) = closed_transport.channel.take().unwrap().split();
        closed_transport.finish().await;
        let mut fixture = Fixture::new(false, None).await;
        let (reader, _) = fixture.channel.take().unwrap().split();
        let ssh = fixture.ssh.clone();
        let (sender, receiver) = mpsc::channel(8);
        let task = tokio::spawn(async move {
            run_connected_session(
                ssh,
                (reader, failed_writer),
                receiver,
                &Channel::new(|_| Ok(())),
                &CancellationToken::new(),
                |_| {},
                || async {},
            )
            .await
        });
        let (monitor_reply, monitor_result) = oneshot::channel();
        sender
            .send(SshControl::Monitor {
                reply: monitor_reply,
            })
            .await
            .unwrap();
        assert_eq!(within(fixture.events.recv()).await, Some("monitor"));
        let (reply, response) = oneshot::channel();
        sender
            .send(SshControl::Sftp(SftpControl::Open { reply }))
            .await
            .unwrap();
        assert_eq!(within(fixture.events.recv()).await, Some("sftp"));
        sender
            .send(if resize {
                SshControl::Resize {
                    cols: 80,
                    rows: 24,
                    pixel_width: 800,
                    pixel_height: 600,
                }
            } else {
                SshControl::Input(b"command".to_vec())
            })
            .await
            .unwrap();
        let result = within(task).await.unwrap();
        let prefix = if resize {
            "ssh_resize_failed:"
        } else {
            "ssh_input_failed:"
        };
        assert!(
            matches!(result, Err(SessionFailure::Message(ref error)) if error.starts_with(prefix)),
            "{result:?}"
        );
        assert!(!matches!(within(monitor_result).await, Ok(Ok(_))));
        assert!(!matches!(within(response).await, Ok(Ok(_))));
        assert!(sender.is_closed());
        fixture.finish().await;
    }
}
