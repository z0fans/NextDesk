use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::sftp::SftpControl;
use super::types::SshMonitorSnapshot;

pub enum SshControl {
    Input(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
        pixel_width: u16,
        pixel_height: u16,
    },
    Sftp(SftpControl),
    Monitor {
        reply: tokio::sync::oneshot::Sender<Result<SshMonitorSnapshot, String>>,
    },
    Close,
}

pub struct SshSessionHandle {
    control: mpsc::Sender<SshControl>,
    cancellation: CancellationToken,
    completed: CancellationToken,
}

impl SshSessionHandle {
    pub fn new(control: mpsc::Sender<SshControl>) -> Self {
        Self {
            control,
            cancellation: CancellationToken::new(),
            completed: CancellationToken::new(),
        }
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }
}

#[derive(Default)]
pub struct SshSessionManager {
    sessions: HashMap<String, SshSessionHandle>,
}

impl SshSessionManager {
    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub fn insert(&mut self, session_id: String, handle: SshSessionHandle) -> Result<(), String> {
        if self.sessions.contains_key(&session_id) {
            return Err("ssh_session_already_exists".to_string());
        }
        self.sessions.insert(session_id, handle);
        Ok(())
    }

    pub fn send(&self, session_id: &str, control: SshControl) -> Result<(), String> {
        self.control_sender(session_id)?
            .try_send(control)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => "ssh_input_backpressure".to_string(),
                mpsc::error::TrySendError::Closed(_) => "ssh_session_closed".to_string(),
            })
    }

    pub fn control_sender(&self, session_id: &str) -> Result<mpsc::Sender<SshControl>, String> {
        let handle = self
            .sessions
            .get(session_id)
            .ok_or_else(|| "ssh_session_not_found".to_string())?;
        if handle.cancellation.is_cancelled() {
            return Err("ssh_session_closed".to_string());
        }
        Ok(handle.control.clone())
    }

    pub fn close(&self, session_id: &str) -> Result<CancellationToken, String> {
        let handle = self
            .sessions
            .get(session_id)
            .ok_or_else(|| "ssh_session_not_found".to_string())?;
        handle.cancellation.cancel();
        let _ = handle.control.try_send(SshControl::Close);
        Ok(handle.completed.clone())
    }

    pub fn remove(&mut self, session_id: &str) {
        if let Some(handle) = self.sessions.remove(session_id) {
            handle.cancellation.cancel();
            handle.completed.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{SshControl, SshSessionHandle, SshSessionManager};

    #[test]
    fn close_cancels_a_session_during_connection_setup() {
        let (control, _receiver) = tokio::sync::mpsc::channel(8);
        let handle = SshSessionHandle::new(control);
        let cancellation = handle.cancellation_token();
        let mut manager = SshSessionManager::default();
        manager.insert("ssh-tab".to_string(), handle).unwrap();

        manager.close("ssh-tab").unwrap();

        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn cloned_control_sender_waits_for_queue_capacity() {
        let (control, mut receiver) = tokio::sync::mpsc::channel(1);
        let handle = SshSessionHandle::new(control);
        let mut manager = SshSessionManager::default();
        manager.insert("ssh-tab".to_string(), handle).unwrap();
        manager.send("ssh-tab", SshControl::Input(vec![1])).unwrap();

        let sender = manager.control_sender("ssh-tab").unwrap();
        let blocked = tokio::spawn(async move { sender.send(SshControl::Input(vec![2])).await });
        tokio::task::yield_now().await;
        assert!(!blocked.is_finished());

        assert!(matches!(receiver.recv().await, Some(SshControl::Input(data)) if data == vec![1]));
        assert!(blocked.await.unwrap().is_ok());
        assert!(matches!(receiver.recv().await, Some(SshControl::Input(data)) if data == vec![2]));
    }

    #[tokio::test]
    async fn replacement_waits_for_removal_and_closing_session_rejects_new_work() {
        let (control, _receiver) = tokio::sync::mpsc::channel(8);
        let mut manager = SshSessionManager::default();
        manager
            .insert("ssh-tab".into(), SshSessionHandle::new(control))
            .unwrap();
        let completed = manager.close("ssh-tab").unwrap();
        assert!(!completed.is_cancelled());
        assert!(manager.contains("ssh-tab"));
        assert_eq!(
            manager
                .send("ssh-tab", SshControl::Input(vec![1]))
                .unwrap_err(),
            "ssh_session_closed"
        );
        assert!(manager.control_sender("ssh-tab").is_err());
        let (replacement, _receiver) = tokio::sync::mpsc::channel(8);
        assert!(manager
            .insert("ssh-tab".into(), SshSessionHandle::new(replacement.clone()))
            .is_err());
        manager.remove("ssh-tab");
        completed.cancelled().await;
        manager
            .insert("ssh-tab".into(), SshSessionHandle::new(replacement))
            .unwrap();
        assert!(manager.control_sender("ssh-tab").is_ok());
    }
}
