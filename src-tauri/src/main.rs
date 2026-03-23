// Prevents additional console window on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nextdesk_lib::run()
}
