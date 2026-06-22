pub mod types;

#[cfg(not(target_os = "windows"))]
pub mod macos;

#[cfg(target_os = "windows")]
pub mod windows;
