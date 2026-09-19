// A janela é o produto; o console atrás dela não. `windows_subsystem` some com
// o prompt preto que apareceria junto do app no Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    saimo_tv_lib::run()
}
