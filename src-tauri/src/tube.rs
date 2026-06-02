//! Tube Mode: multi-link aggregation for RDP acceleration.
//!
//! Built-in dispatcher domains + GeoIP auto-selection.

use std::future::IntoFuture;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;

// ===== Built-in dispatcher domains — change before release =====
const TUBE_DISPATCHERS: &[(&str, &str)] = &[
    ("us", "tube-us.yourdomain.com:9000"),
    ("asia", "tube-asia.yourdomain.com:9000"),
];
const DEFAULT_REGION: &str = "us";

// GeoIP country code → region mapping
const AMERICAS: &[&str] = &["US", "CA", "MX", "BR", "AR", "CL", "CO", "PE", "VE"];
const ASIA_PACIFIC: &[&str] = &[
    "CN", "JP", "KR", "SG", "HK", "TW", "IN", "TH", "VN", "MY", "PH", "ID", "AU", "NZ",
];

/// Global toggle type for Tube Mode.
pub type TubeEnabled = Arc<Mutex<bool>>;

/// Resolve which dispatcher to use based on RDP target IP.
/// Returns dispatcher address like "tube-us.yourdomain.com:9000".
pub fn resolve_dispatcher(rdp_host: &str) -> Option<String> {
    let ip: IpAddr = rdp_host.parse().ok()?;

    // Load GeoIP database from app config dir
    let db_path = crate::config::get_user_config_dir().join("Country.mmdb");
    let reader = maxminddb::Reader::open_readfile(&db_path).ok()?;
    let country: maxminddb::geoip2::Country = reader.lookup(ip).ok()?;
    let iso = country.country?.iso_code?;

    let region = if AMERICAS.contains(&iso) {
        "us"
    } else if ASIA_PACIFIC.contains(&iso) {
        "asia"
    } else {
        DEFAULT_REGION
    };

    log::info!("[tube] GeoIP: {} -> {} -> region={}", ip, iso, region);
    TUBE_DISPATCHERS
        .iter()
        .find(|(r, _)| *r == region)
        .map(|(_, addr)| addr.to_string())
}

/// Build an Aggligator multi-link connection to the dispatcher.
///
/// Flow:
/// 1. Create Aggligator outgoing connection
/// 2. Open N SOCKS5 links (each through Clash)
/// 3. Add each link via Control::add_io
/// 4. Outgoing::connect() to establish connection
/// 5. Send RDP target as first line (dispatcher protocol)
/// 6. Return aggregated IO stream
pub async fn connect_tube(
    dispatcher_addr: &str,
    socks_port: u16,
    rdp_dest: &str,
    link_count: usize,
) -> Result<aggligator::alc::Stream, Box<dyn std::error::Error + Send + Sync>> {
    use aggligator::cfg::Cfg;
    use aggligator::connect;
    use aggligator::io::{IoRx, IoTx};
    use tokio::io::ReadHalf;
    use tokio::io::WriteHalf;
    use tokio::net::TcpStream;
    use tokio_socks::tcp::Socks5Stream;

    type W = WriteHalf<TcpStream>;
    type R = ReadHalf<TcpStream>;

    let cfg = Cfg::default();
    let (task, outgoing, control) = connect::connect::<IoTx<W>, IoRx<R>, ()>(cfg);

    // Spawn the aggligator background task (IntoFuture)
    tauri::async_runtime::spawn(task.into_future());

    // Create multiple links through SOCKS5
    let socks_addr = format!("127.0.0.1:{socks_port}");
    let mut connected = 0usize;

    for i in 0..link_count {
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            Socks5Stream::connect(socks_addr.as_str(), dispatcher_addr),
        )
        .await
        {
            Ok(Ok(stream)) => {
                let tcp = stream.into_inner();
                let (r, w) = tokio::io::split(tcp);
                if let Err(e) = control.add_io(r, w, (), &[]).await {
                    log::warn!("[tube] Link {i} add failed: {e}");
                } else {
                    log::info!("[tube] Link {i} connected");
                    connected += 1;
                }
            }
            Ok(Err(e)) => {
                log::warn!("[tube] Link {i} SOCKS5 err: {e}");
            }
            Err(_) => {
                log::warn!("[tube] Link {i} timeout (5s)");
            }
        }
    }

    if connected == 0 {
        return Err("No links connected".into());
    }
    log::info!("[tube] {connected}/{link_count} links up");

    // Establish the aggregated connection
    let channel = outgoing
        .connect()
        .await
        .map_err(|e| format!("aggligator connect: {e}"))?;
    let mut io = channel.into_stream();

    // Protocol: send RDP destination as first line
    let header = format!("{rdp_dest}\n");
    io.write_all(header.as_bytes()).await?;

    Ok(io)
}
