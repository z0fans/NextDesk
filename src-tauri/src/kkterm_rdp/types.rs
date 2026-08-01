#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpStartRequest {
    pub tab_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub desktop_width: Option<u16>,
    #[serde(default)]
    pub desktop_height: Option<u16>,
    #[serde(default)]
    pub remote_resolution: Option<String>,
    #[serde(default)]
    pub redirect_drives: bool,
    #[serde(default)]
    pub use_multimon: bool,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default)]
    pub scale_factor: Option<f64>,
    #[serde(default)]
    pub reuse_cloud_binding: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpStartResponse {
    pub tab_id: String,
    pub session_id: String,
    pub route_label: String,
    pub route_lease_id: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpBoundsRequest {
    pub tab_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    pub visible: bool,
    #[serde(default)]
    pub clip_rect: Option<KktermRdpClipRect>,
    #[serde(default)]
    pub clip_rects: Vec<KktermRdpClipRect>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpClipRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpPointerRequest {
    pub tab_id: String,
    pub x: u16,
    pub y: u16,
    pub button_mask: u8,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpKeyRequest {
    pub tab_id: String,
    pub scancode: u16,
    pub down: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpTextRequest {
    pub tab_id: String,
    pub text: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpSimpleRequest {
    pub tab_id: String,
    #[serde(default)]
    pub route_lease_id: Option<u64>,
}

pub fn session_id_from_tab_id(tab_id: &str) -> String {
    let safe_id = tab_id
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let safe_id = if safe_id.is_empty() {
        "session".to_string()
    } else {
        safe_id
    };
    format!("rdp-{safe_id}").chars().take(96).collect()
}
