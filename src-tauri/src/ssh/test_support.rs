use russh::{client, server, Channel, ChannelId};
use russh_sftp::protocol::{
    self, Attrs, Data, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode,
};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("SSH test timed out")
}

pub struct TestClient(pub russh::keys::ssh_key::PublicKey);

impl client::Handler for TestClient {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(key == &self.0)
    }
}

#[derive(Clone)]
pub struct Block {
    pub operation: &'static str,
    pub started: CancellationToken,
    pub release: CancellationToken,
}

impl Block {
    pub fn new(operation: &'static str) -> Self {
        Self {
            operation,
            started: CancellationToken::new(),
            release: CancellationToken::new(),
        }
    }
}

#[derive(Default)]
pub struct Files {
    pub contents: HashMap<String, Vec<u8>>,
    pub handles: HashSet<String>,
    pub operations: Vec<String>,
}

pub struct Fixture {
    pub ssh: Arc<client::Handle<TestClient>>,
    pub channel: Option<Channel<client::Msg>>,
    pub server: server::Handle,
    pub terminal: ChannelId,
    pub events: mpsc::UnboundedReceiver<&'static str>,
    pub files: Arc<Mutex<Files>>,
    pub sftp_closed: CancellationToken,
    running: tokio::task::JoinHandle<()>,
}

impl Fixture {
    pub async fn new(serve_sftp: bool, block: Option<Block>) -> Self {
        let key = russh::keys::PrivateKey::random(
            &mut rand::rngs::OsRng,
            russh::keys::Algorithm::Ed25519,
        )
        .unwrap();
        let public_key = key.public_key().clone();
        let config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (events_tx, events) = mpsc::unbounded_channel();
        let (handle_tx, handle_rx) = tokio::sync::oneshot::channel();
        let files = Arc::new(Mutex::new(Files::default()));
        let sftp_closed = CancellationToken::new();
        let handler = TestServer {
            channels: HashMap::new(),
            events: events_tx,
            serve_sftp,
            files: files.clone(),
            block,
            sftp_closed: sftp_closed.clone(),
        };
        let running = tokio::spawn(async move {
            let session = server::run_stream(config, server_io, handler)
                .await
                .unwrap();
            let _ = handle_tx.send(session.handle());
            let _ = session.await;
        });
        let mut ssh = within(client::connect_stream(
            Arc::new(client::Config::default()),
            client_io,
            TestClient(public_key),
        ))
        .await
        .unwrap();
        assert!(within(ssh.authenticate_none("test"))
            .await
            .unwrap()
            .success());
        let channel = within(ssh.channel_open_session()).await.unwrap();
        let terminal = channel.id();
        Self {
            ssh: Arc::new(ssh),
            channel: Some(channel),
            server: within(handle_rx).await.unwrap(),
            terminal,
            events,
            files,
            sftp_closed,
            running,
        }
    }

    pub async fn finish(self) {
        let _ = self
            .ssh
            .disconnect(russh::Disconnect::ByApplication, "test done", "en")
            .await;
        within(self.running).await.unwrap();
    }
}

struct TestServer {
    channels: HashMap<ChannelId, Channel<server::Msg>>,
    events: mpsc::UnboundedSender<&'static str>,
    serve_sftp: bool,
    files: Arc<Mutex<Files>>,
    block: Option<Block>,
    sftp_closed: CancellationToken,
}

impl server::Handler for TestServer {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        _: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        self.channels.insert(channel.id(), channel);
        Ok(true)
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let _ = self.events.send("monitor");
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(name, "sftp");
        session.channel_success(channel)?;
        let _ = self.events.send("sftp");
        if self.serve_sftp {
            let stream = self.channels.remove(&channel).unwrap().into_stream();
            russh_sftp::server::run(
                stream,
                TestSftp {
                    files: self.files.clone(),
                    block: self.block.clone(),
                    closed: self.sftp_closed.clone(),
                },
            )
            .await;
        }
        Ok(())
    }
}

struct TestSftp {
    files: Arc<Mutex<Files>>,
    block: Option<Block>,
    closed: CancellationToken,
}

impl Drop for TestSftp {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}

impl TestSftp {
    async fn pause(&self, operation: &str) {
        if let Some(block) = &self.block {
            if block.operation == operation {
                block.started.cancel();
                block.release.cancelled().await;
            }
        }
    }
    fn ok(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: "en".into(),
        }
    }
    fn attrs(&self, id: u32, path: &str) -> Result<Attrs, StatusCode> {
        let files = self.files.lock().unwrap();
        let content = files.contents.get(path).ok_or(StatusCode::NoSuchFile)?;
        let mut attrs = FileAttributes::empty();
        attrs.size = Some(content.len() as u64);
        attrs.permissions = Some(0o100644);
        Ok(Attrs { id, attrs })
    }
}

impl russh_sftp::server::Handler for TestSftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        self.pause("realpath").await;
        Ok(Name {
            id,
            files: vec![protocol::File::dummy(path)],
        })
    }
    async fn opendir(&mut self, _id: u32, _path: String) -> Result<Handle, Self::Error> {
        self.pause("opendir").await;
        Err(StatusCode::OpUnsupported)
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.attrs(id, &path)
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.attrs(id, &path)
    }
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let mut files = self.files.lock().unwrap();
        if flags.contains(OpenFlags::CREATE) {
            files.contents.insert(filename.clone(), Vec::new());
        }
        if !files.contents.contains_key(&filename) {
            return Err(StatusCode::NoSuchFile);
        }
        files.handles.insert(filename.clone());
        files.operations.push(format!("open:{filename}"));
        Ok(Handle {
            id,
            handle: filename,
        })
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        let mut files = self.files.lock().unwrap();
        files.handles.remove(&handle);
        files.operations.push(format!("close:{handle}"));
        Ok(Self::ok(id))
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        self.pause("read").await;
        let files = self.files.lock().unwrap();
        let content = files.contents.get(&handle).ok_or(StatusCode::NoSuchFile)?;
        if offset as usize >= content.len() {
            return Err(StatusCode::Eof);
        }
        Ok(Data {
            id,
            data: content[offset as usize..content.len().min(offset as usize + len as usize)]
                .to_vec(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        self.pause("write").await;
        let mut files = self.files.lock().unwrap();
        let content = files
            .contents
            .get_mut(&handle)
            .ok_or(StatusCode::NoSuchFile)?;
        content.resize(content.len().max(offset as usize + data.len()), 0);
        content[offset as usize..offset as usize + data.len()].copy_from_slice(&data);
        Ok(Self::ok(id))
    }
    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let mut files = self.files.lock().unwrap();
        if files.handles.contains(&filename) {
            return Err(StatusCode::Failure);
        }
        files
            .contents
            .remove(&filename)
            .ok_or(StatusCode::NoSuchFile)?;
        files.operations.push(format!("remove:{filename}"));
        Ok(Self::ok(id))
    }
    async fn rename(&mut self, id: u32, from: String, to: String) -> Result<Status, Self::Error> {
        let mut files = self.files.lock().unwrap();
        let data = files.contents.remove(&from).ok_or(StatusCode::NoSuchFile)?;
        files.contents.insert(to, data);
        Ok(Self::ok(id))
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _: FileAttributes,
    ) -> Result<Status, Self::Error> {
        self.pause("mkdir").await;
        self.files
            .lock()
            .unwrap()
            .operations
            .push(format!("mkdir:{path}"));
        Ok(Self::ok(id))
    }
}
