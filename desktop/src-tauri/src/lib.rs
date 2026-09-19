//! SaimoTV para Windows.
//!
//! A janela é a mesma tela do site, carregada de dentro do executável, com duas
//! coisas que o navegador não pode dar:
//!
//! * um proxy próprio, em 127.0.0.1, que manda `Referer` e `User-Agent`, abre
//!   fonte em HTTP simples e conserta cabeçalho de origem quebrada;
//! * a saída para o navegador do sistema quando o link é de fora, em vez de a
//!   janela do app virar uma aba do Discord.
//!
//! Fora isso, é o mesmo código de tela dos outros apps, de propósito: o que for
//! corrigido no site chega aqui na próxima compilação.

mod proxy;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Endereços que a janela pode abrir dentro dela.
///
/// Tudo o mais — Discord, GitHub, qualquer link de descrição — vai para o
/// navegador do sistema. Sem isto um clique no cabeçalho substituiria o app
/// pela página e não haveria botão de voltar para desfazer.
fn e_interno(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("tauri.localhost")
        ),
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // O proxy sobe antes da janela: a tela lê o endereço dele no
            // primeiro script que roda, e um endereço vazio faria o primeiro
            // canal tentar direto e falhar sozinho.
            let base = tauri::async_runtime::block_on(proxy::subir())
                .map(|(base, tarefa)| {
                    // A tarefa vive enquanto o app viver; soltá-la aqui é o
                    // que a mantém no executor.
                    std::mem::forget(tarefa);
                    base
                })
                .unwrap_or_default();

            let injecao = format!(
                "window.__SAIMO_PROXY__ = {};\nwindow.__SAIMO_DESKTOP__ = true;",
                serde_json::to_string(&base).unwrap_or_else(|_| "\"\"".into())
            );

            let manipulador = app.handle().clone();
            WebviewWindowBuilder::new(app, "principal", WebviewUrl::default())
                .title("SaimoTV")
                .inner_size(1280.0, 800.0)
                .min_inner_size(880.0, 560.0)
                .center()
                .resizable(true)
                .initialization_script(&injecao)
                .on_navigation(move |url| {
                    if e_interno(url) {
                        return true;
                    }
                    let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    false
                })
                .build()?;

            // Sem isto a janela abre atrás do que estava em foco quando o
            // usuário clicou no atalho.
            if let Some(janela) = manipulador.get_webview_window("principal") {
                let _ = janela.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao abrir o SaimoTV");
}
