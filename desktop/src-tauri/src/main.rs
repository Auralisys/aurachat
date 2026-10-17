// Previene una finestra console aggiuntiva su Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aurachat_lib::run()
}
