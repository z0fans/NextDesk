//! tube-server: Aggligator dispatcher with dynamic RDP target.
//!
//! Protocol:
//! 1. Accept Aggligator aggregated connection
//! 2. Read first line = "host:port\n" (RDP target)
//! 3. TCP connect to that target
//! 4. Bidirectional relay

use std::future::IntoFuture;

use aggligator::cfg::Cfg;
use aggligator::connect::Server;
use aggligator::io::{IoRx, IoTx};
use clap::Parser;
use tokio::io::{
    AsyncBufReadExt, BufReader, ReadHalf, WriteHalf,
};
use tokio::net::TcpListener;

#[derive(Parser)]
struct Args {
    /// Address to listen on
    #[arg(long, default_value = "0.0.0.0:9000")]
    listen: String,
}

type W = WriteHalf<tokio::net::TcpStream>;
type R = ReadHalf<tokio::net::TcpStream>;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::init();
    let args = Args::parse();

    let cfg = Cfg::default();
    let server =
        Server::<IoTx<W>, IoRx<R>, ()>::new(cfg);
    let mut listener = server.listen()?;

    let tcp_listener =
        TcpListener::bind(&args.listen).await?;
    log::info!(
        "tube-server listening on {}",
        args.listen
    );

    // Feed incoming TCP links to the server
    let srv = server.clone();
    tokio::spawn(async move {
        loop {
            match tcp_listener.accept().await {
                Ok((stream, peer)) => {
                    log::info!("link from {peer}");
                    let (r, w) =
                        tokio::io::split(stream);
                    if let Err(e) = srv
                        .add_incoming_io(r, w, (), &[])
                        .await
                    {
                        log::warn!(
                            "add link: {e}"
                        );
                    }
                }
                Err(e) => {
                    log::error!("accept: {e}");
                }
            }
        }
    });

    // Accept aggregated connections
    loop {
        match listener.accept().await {
            Ok((task, channel, _control)) => {
                // Spawn task to manage connection
                tokio::spawn(task.into_future());
                tokio::spawn(async move {
                    let stream =
                        channel.into_stream();
                    if let Err(e) =
                        relay_to_rdp(stream).await
                    {
                        log::error!(
                            "relay error: {e}"
                        );
                    }
                });
            }
            Err(e) => {
                log::error!(
                    "accept connection: {e}"
                );
                break;
            }
        }
    }

    Ok(())
}

/// Read RDP target from first line, then relay.
async fn relay_to_rdp(
    io: aggligator::alc::Stream,
) -> anyhow::Result<()> {
    let (reader, mut writer) =
        tokio::io::split(io);
    let mut buf_reader = BufReader::new(reader);

    // 1. Read target address
    let mut target = String::new();
    buf_reader.read_line(&mut target).await?;
    let target = target.trim();
    log::info!(
        "connecting to RDP target: {target}"
    );

    // 2. TCP connect to RDP
    let rdp = tokio::net::TcpStream::connect(target)
        .await?;
    let (mut rdp_r, mut rdp_w) =
        tokio::io::split(rdp);

    // 3. Bidirectional relay
    let a2b = tokio::io::copy(
        &mut buf_reader,
        &mut rdp_w,
    );
    let b2a = tokio::io::copy(
        &mut rdp_r,
        &mut writer,
    );
    tokio::select! {
        r = a2b => {
            if let Err(e) = r {
                log::debug!("a2b: {e}");
            }
        }
        r = b2a => {
            if let Err(e) = r {
                log::debug!("b2a: {e}");
            }
        }
    }

    log::info!("session done: {target}");
    Ok(())
}
