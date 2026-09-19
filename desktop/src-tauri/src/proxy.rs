//! Proxy de streaming local — o mesmo contrato de `functions/api/proxy.ts`.
//!
//! O aplicativo carrega a mesma tela do site, e a tela pede vídeo em
//! `/api/proxy?url=…`. No site quem responde é a função da Cloudflare; aqui
//! quem responde é este servidor, ouvindo em 127.0.0.1 numa porta escolhida
//! pelo sistema. O contrato é igual de propósito: a correção que passa no site
//! passa aqui sem virar duas implementações que divergem com o tempo.
//!
//! O que ele faz que a janela sozinha não faria:
//!
//! * manda `Referer` e `User-Agent` que certos CDNs exigem e o `fetch` proíbe;
//! * segue redirecionamento na mão, guardando o cookie do caminho;
//! * reescreve manifesto HLS e DASH para todo filho voltar por aqui;
//! * conserta o `Content-Range` de origem que declara o fim do arquivo inteiro
//!   em vez do pedaço entregue — sem isso dois quintos do acervo de filmes não
//!   abre.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};

const UA_PADRAO: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const MAX_REDIRECIONAMENTOS: usize = 15;

/// O mesmo conjunto que o `encodeURIComponent` do navegador preserva.
///
/// A tela monta endereços de proxy em JavaScript e o Rust monta os filhos das
/// playlists; se os dois codificassem diferente, o mesmo segmento viraria dois
/// endereços e o cache do player buscaria tudo duas vezes.
const COMPONENTE: &AsciiSet = &CONTROLS
    .add(b' ').add(b'"').add(b'#').add(b'$').add(b'%').add(b'&').add(b'+').add(b',')
    .add(b'/').add(b':').add(b';').add(b'<').add(b'=').add(b'>').add(b'?').add(b'@')
    .add(b'[').add(b'\\').add(b']').add(b'^').add(b'`').add(b'{').add(b'|').add(b'}');

#[derive(Clone)]
struct Estado {
    cliente: reqwest::Client,
}

/// Sobe o proxy numa porta livre e devolve o endereço que a tela deve usar.
pub async fn subir() -> Result<(String, tokio::task::JoinHandle<()>), String> {
    let cliente = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(12))
        .pool_idle_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let app = Router::new()
        .route("/health", any(saude))
        .route("/api/proxy", any(atender))
        .with_state(Estado { cliente });

    // Porta zero: o sistema escolhe uma livre. Fixar a porta brigaria com uma
    // segunda janela aberta e com qualquer outro programa da máquina.
    let ouvinte = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .map_err(|e| e.to_string())?;
    let porta = ouvinte.local_addr().map_err(|e| e.to_string())?.port();

    let tarefa = tokio::spawn(async move {
        let _ = axum::serve(ouvinte, app).await;
    });

    Ok((format!("http://127.0.0.1:{porta}"), tarefa))
}

async fn saude() -> &'static str {
    "ok\n"
}

// MARK: - Endereços

fn resolver(uri: &str, base: &str) -> String {
    match url::Url::parse(base).and_then(|b| b.join(uri)) {
        Ok(u) => u.to_string(),
        Err(_) => uri.to_string(),
    }
}

/// Endereço deste proxy para uma origem, com os cabeçalhos dela.
pub fn proxiado(absoluto: &str, origem_proxy: &str, referer: Option<&str>, ua: Option<&str>) -> String {
    let mut out = format!(
        "{origem_proxy}/api/proxy?url={}",
        utf8_percent_encode(absoluto, COMPONENTE)
    );
    if let Some(r) = referer {
        out.push_str(&format!("&referer={}", utf8_percent_encode(r, COMPONENTE)));
    }
    if let Some(u) = ua {
        out.push_str(&format!("&ua={}", utf8_percent_encode(u, COMPONENTE)));
    }
    out
}

/// Igual a [`proxiado`], mas devolve `$Number$` e `$Time$` do DASH intactos.
///
/// Quem substitui o gabarito é o player, depois de o endereço estar montado, e
/// `%24Number%24` não é reconhecido por ele.
fn proxiado_gabarito(
    absoluto: &str,
    origem_proxy: &str,
    referer: Option<&str>,
    ua: Option<&str>,
) -> String {
    proxiado(absoluto, origem_proxy, referer, ua).replace("%24", "$")
}

/// Corrige segmento relativo de playlist servida por proxy de terceiro.
///
/// A playlist dos Telecine chega em `/tos-…/proxy.m3u8`, mas o `url=` dela diz
/// que os segmentos moram em `/docs/telecinepipoca/`. Pedir ao lado da playlist
/// devolve 521; pedir na pasta do `url=` devolve o vídeo. Mesma correção que o
/// app Android faz em `Playback.corrigirCaminhoDaPlaylist`.
pub fn corrigir_caminho_aninhado(playlist: &str, pedido: &str) -> String {
    let (Ok(manifesto), Ok(alvo)) = (url::Url::parse(playlist), url::Url::parse(pedido)) else {
        return pedido.to_string();
    };

    // A própria playlist conserva a query assinada; só filho relativo muda.
    if manifesto.path() == alvo.path() {
        return pedido.to_string();
    }
    if manifesto.scheme() != alvo.scheme() || manifesto.host_str() != alvo.host_str() {
        return pedido.to_string();
    }

    // O `url=` carrega um endereço inteiro com query própria, então o valor é
    // fatiado na mão: um parser de query cortaria no primeiro `&` de dentro.
    let bruta = manifesto.query().unwrap_or("");
    let Some(valor) = bruta.split('&').find_map(|p| p.strip_prefix("url=")) else {
        return pedido.to_string();
    };
    let decodificado = percent_encoding::percent_decode_str(valor)
        .decode_utf8_lossy()
        .to_string();
    let Ok(aninhado) = url::Url::parse(&decodificado) else {
        return pedido.to_string();
    };

    let pasta_manifesto = pasta(manifesto.path());
    let pasta_aninhada = pasta(aninhado.path());
    if pasta_manifesto.is_empty() || pasta_aninhada.is_empty() {
        return pedido.to_string();
    }
    if !alvo.path().starts_with(&pasta_manifesto) {
        return pedido.to_string();
    }

    let corrigido = format!("{pasta_aninhada}{}", &alvo.path()[pasta_manifesto.len()..]);
    let query = alvo.query().map(|q| format!("?{q}")).unwrap_or_default();
    let fragmento = alvo.fragment().map(|f| format!("#{f}")).unwrap_or_default();
    // A pasta vem do `url=`, mas o servidor continua sendo o do pedido: quem
    // responde pelo segmento é o proxy de terceiro, não a origem escondida.
    let porta = alvo.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!(
        "{}://{}{porta}{corrigido}{query}{fragmento}",
        alvo.scheme(),
        alvo.host_str().unwrap_or_default()
    )
}

fn pasta(caminho: &str) -> String {
    match caminho.rfind('/') {
        Some(i) => caminho[..=i].to_string(),
        None => String::new(),
    }
}

// MARK: - Manifestos

/// Reescreve o manifesto HLS para que todo filho passe por este proxy.
pub fn reescrever_m3u8(
    conteudo: &str,
    playlist: &str,
    origem_proxy: &str,
    referer: Option<&str>,
    ua: Option<&str>,
) -> String {
    let embrulhar = |uri: &str| -> String {
        let absoluto = corrigir_caminho_aninhado(playlist, &resolver(uri, playlist));
        proxiado(&absoluto, origem_proxy, referer, ua)
    };

    conteudo
        .split('\n')
        .map(|linha| {
            let com_uri = substituir_uri(linha, &embrulhar);
            if com_uri.starts_with('#') {
                return com_uri;
            }
            let limpa = com_uri.trim();
            if limpa.is_empty() {
                return com_uri;
            }
            embrulhar(limpa)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Troca todo `URI="…"` da linha — é assim que `#EXT-X-KEY`, `#EXT-X-MAP` e
/// `#EXT-X-MEDIA` apontam para chave, cabeçalho e faixa de áudio.
fn substituir_uri(linha: &str, embrulhar: &dyn Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(linha.len());
    let mut resto = linha;
    while let Some(inicio) = resto.find("URI=\"") {
        let depois = &resto[inicio + 5..];
        let Some(fim) = depois.find('"') else { break };
        out.push_str(&resto[..inicio]);
        out.push_str("URI=\"");
        out.push_str(&embrulhar(&depois[..fim]));
        out.push('"');
        resto = &depois[fim + 1..];
    }
    out.push_str(resto);
    out
}

fn desescapar_xml(valor: &str) -> String {
    valor
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

/// Reescreve o manifesto DASH para segmentos e inicializações virem por aqui.
///
/// O `BaseURL` é resolvido e removido: com os endereços já absolutos ele só
/// confundiria o player, que voltaria a montar caminho relativo ao proxy.
pub fn reescrever_mpd(
    conteudo: &str,
    manifesto: &str,
    origem_proxy: &str,
    referer: Option<&str>,
    ua: Option<&str>,
) -> String {
    let base = match fatiar_tag(conteudo, "BaseURL") {
        Some(valor) => resolver(&desescapar_xml(valor.trim()), manifesto),
        None => manifesto.to_string(),
    };

    let sem_base = remover_tags(conteudo, "BaseURL");

    substituir_atributos(&sem_base, &["initialization", "media", "sourceURL"], |bruto| {
        let valor = desescapar_xml(bruto);
        if valor.trim().is_empty() {
            return None;
        }
        // `$Number$` não sobrevive ao parser de URL nem ao encode: sai daqui
        // como marcador e volta literal, porque quem o substitui é o player.
        let mut gabaritos: Vec<String> = Vec::new();
        let mascarado = mascarar_cifroes(&valor, &mut gabaritos);
        let mut absoluto = resolver(&mascarado, &base);
        for (i, token) in gabaritos.iter().enumerate() {
            absoluto = absoluto.replace(&format!("__DASHTOK{i}__"), token);
        }
        let endereco = proxiado_gabarito(&absoluto, origem_proxy, referer, ua);
        // Dentro de atributo XML o separador de query precisa ser entidade.
        Some(endereco.replace('&', "&amp;"))
    })
}

fn mascarar_cifroes(valor: &str, gabaritos: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(valor.len());
    let mut resto = valor;
    while let Some(inicio) = resto.find('$') {
        let depois = &resto[inicio + 1..];
        let Some(fim) = depois.find('$') else { break };
        out.push_str(&resto[..inicio]);
        gabaritos.push(format!("${}$", &depois[..fim]));
        out.push_str(&format!("__DASHTOK{}__", gabaritos.len() - 1));
        resto = &depois[fim + 1..];
    }
    out.push_str(resto);
    out
}

fn fatiar_tag<'a>(conteudo: &'a str, tag: &str) -> Option<&'a str> {
    let abertura = format!("<{tag}");
    let fechamento = format!("</{tag}>");
    let inicio = conteudo.find(&abertura)?;
    let corpo = &conteudo[inicio..];
    let depois_do_sinal = corpo.find('>')? + 1;
    let fim = corpo.find(&fechamento)?;
    if fim < depois_do_sinal {
        return None;
    }
    Some(&corpo[depois_do_sinal..fim])
}

fn remover_tags(conteudo: &str, tag: &str) -> String {
    let abertura = format!("<{tag}");
    let fechamento = format!("</{tag}>");
    let mut out = String::with_capacity(conteudo.len());
    let mut resto = conteudo;
    while let Some(inicio) = resto.find(&abertura) {
        let Some(fim) = resto[inicio..].find(&fechamento) else { break };
        out.push_str(&resto[..inicio]);
        resto = &resto[inicio + fim + fechamento.len()..];
        resto = resto.trim_start_matches(['\n', '\r', ' ', '\t']);
    }
    out.push_str(resto);
    out
}

fn substituir_atributos(
    conteudo: &str,
    nomes: &[&str],
    trocar: impl Fn(&str) -> Option<String>,
) -> String {
    let mut out = String::with_capacity(conteudo.len());
    let mut resto = conteudo;

    'fora: loop {
        // O atributo mais próximo, para não pular nenhum ao andar pela linha.
        let mut achado: Option<(usize, &str)> = None;
        for nome in nomes {
            let alvo = format!("{nome}=\"");
            let mut de = 0usize;
            while let Some(rel) = resto[de..].find(&alvo) {
                let pos = de + rel;
                // Só conta se for começo de atributo, não sufixo de outro nome.
                let anterior = resto[..pos].chars().next_back();
                if matches!(anterior, Some(c) if c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                    de = pos + alvo.len();
                    continue;
                }
                if achado.map_or(true, |(p, _)| pos < p) {
                    achado = Some((pos, nome));
                }
                break;
            }
        }

        let Some((pos, nome)) = achado else { break 'fora };
        let abre = pos + nome.len() + 2;
        let Some(fim_rel) = resto[abre..].find('"') else { break 'fora };
        let fim = abre + fim_rel;

        out.push_str(&resto[..pos]);
        match trocar(&resto[abre..fim]) {
            Some(novo) => out.push_str(&format!("{nome}=\"{novo}\"")),
            None => out.push_str(&resto[pos..=fim]),
        }
        resto = &resto[fim + 1..];
    }

    out.push_str(resto);
    out
}

// MARK: - Atendimento

fn e_m3u8(url: &str, tipo: &str) -> bool {
    url.contains(".m3u8")
        || url.split('?').next().unwrap_or(url).to_ascii_lowercase().ends_with(".txt")
        || tipo.contains("application/vnd.apple.mpegurl")
        || tipo.contains("application/x-mpegurl")
        || tipo.contains("audio/mpegurl")
}

fn e_mpd(url: &str, tipo: &str) -> bool {
    url.contains(".mpd") || tipo.contains("application/dash+xml")
}

fn cors(resposta: &mut Response) {
    let h = resposta.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Range, Content-Type"),
    );
}

fn erro(status: StatusCode, mensagem: &str) -> Response {
    let corpo = serde_json::json!({ "error": mensagem }).to_string();
    let mut r = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(corpo))
        .unwrap();
    cors(&mut r);
    r
}

fn texto(status: StatusCode, tipo: &str, corpo: String) -> Response {
    let mut r = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, tipo)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(corpo))
        .unwrap();
    cors(&mut r);
    r
}

/// Os parâmetros da query, decodificados como o navegador decodifica.
fn parametros(query: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for parte in query.split('&') {
        let Some((chave, valor)) = parte.split_once('=') else { continue };
        let valor = percent_encoding::percent_decode_str(&valor.replace('+', " "))
            .decode_utf8_lossy()
            .to_string();
        out.entry(chave.to_string()).or_insert(valor);
    }
    out
}

async fn atender(State(estado): State<Estado>, pedido: Request) -> Response {
    if pedido.method() == Method::OPTIONS {
        let mut r = Response::builder().status(StatusCode::OK).body(Body::empty()).unwrap();
        cors(&mut r);
        return r;
    }

    let query = pedido.uri().query().unwrap_or("").to_string();
    let args = parametros(&query);
    let Some(destino) = args.get("url").cloned() else {
        return erro(StatusCode::BAD_REQUEST, "URL parameter is required");
    };
    if !destino.starts_with("http://") && !destino.starts_with("https://") {
        return erro(StatusCode::BAD_REQUEST, "Invalid URL protocol");
    }
    let referer = args.get("referer").cloned();
    let ua = args.get("ua").cloned();

    let Ok(origem) = url::Url::parse(&destino) else {
        return erro(StatusCode::BAD_REQUEST, "Invalid URL");
    };
    let referer_efetivo = referer.clone().unwrap_or_else(|| {
        format!("{}://{}/", origem.scheme(), origem.host_str().unwrap_or_default())
    });
    let origem_do_referer = url::Url::parse(&referer_efetivo)
        .ok()
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_else(|| {
            format!("{}://{}", origem.scheme(), origem.host_str().unwrap_or_default())
        });

    let faixa = pedido
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let mut cabecalhos: Vec<(String, String)> = vec![
        ("User-Agent".into(), ua.clone().unwrap_or_else(|| UA_PADRAO.into())),
        ("Referer".into(), referer_efetivo.clone()),
        ("Origin".into(), origem_do_referer.clone()),
        ("Accept".into(), "*/*".into()),
        ("Accept-Language".into(), "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7".into()),
    ];
    if let Some(f) = &faixa {
        cabecalhos.push(("Range".into(), f.clone()));
    }

    let mut atual = destino.clone();
    let mut resposta: Option<reqwest::Response> = None;

    for tentativa in 0..MAX_REDIRECIONAMENTOS {
        match buscar(&estado.cliente, &atual, &cabecalhos).await {
            Ok(r) => {
                let status = r.status().as_u16();
                if (300..400).contains(&status) {
                    let Some(local) = r
                        .headers()
                        .get(header::LOCATION)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string)
                    else {
                        resposta = Some(r);
                        break;
                    };
                    // O cookie do caminho vale para o próximo salto; o Referer
                    // volta ao original, porque quem o exige é a origem final.
                    let biscoitos: Vec<String> = r
                        .headers()
                        .get_all(header::SET_COOKIE)
                        .iter()
                        .filter_map(|v| v.to_str().ok())
                        .map(|v| v.split(';').next().unwrap_or(v).to_string())
                        .collect();
                    if !biscoitos.is_empty() {
                        juntar_cookie(&mut cabecalhos, &biscoitos.join("; "));
                    }
                    atual = resolver(&local, &atual);
                    continue;
                }
                resposta = Some(r);
                break;
            }
            Err(_) if tentativa < 2 => continue,
            Err(e) => return erro(StatusCode::BAD_GATEWAY, &format!("Failed to connect: {e}")),
        }
    }

    let Some(mut final_) = resposta else {
        return erro(StatusCode::INTERNAL_SERVER_ERROR, "Too many redirects or fetch failures");
    };

    // Origem que engasgou: repete antes de devolver erro. Sem isto o player
    // descia para outra fonte por causa de um soluço de dois segundos.
    for _ in 0..2 {
        if final_.status().as_u16() < 500 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        match buscar(&estado.cliente, &atual, &cabecalhos).await {
            Ok(r) => final_ = r,
            Err(_) => break,
        }
    }

    // 403/404: tenta outros cabeçalhos antes de desistir. Parte dos CDNs recusa
    // o par Referer+Origin que o resto exige.
    if final_.status() == StatusCode::FORBIDDEN || final_.status() == StatusCode::NOT_FOUND {
        let cookie = valor_de(&cabecalhos, "Cookie");
        let agente = valor_de(&cabecalhos, "User-Agent").unwrap_or_else(|| UA_PADRAO.into());
        let estrategias: Vec<Vec<(String, String)>> = vec![
            montar(&[("User-Agent", &agente), ("Referer", &referer_efetivo), ("Accept", "*/*")], &cookie, &faixa),
            montar(&[("User-Agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36")], &None, &faixa),
            montar(&[("User-Agent", "Lavf/58.29.100"), ("Accept", "*/*")], &None, &faixa),
            montar(&[], &None, &faixa),
        ];
        for tentativa in estrategias {
            if let Ok(r) = buscar(&estado.cliente, &atual, &tentativa).await {
                if r.status().is_success() || r.status() == StatusCode::PARTIAL_CONTENT {
                    final_ = r;
                    break;
                }
            }
        }
    }

    let tipo = final_
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let hls = e_m3u8(&atual, &tipo);
    let dash = e_mpd(&atual, &tipo);

    if !final_.status().is_success() && final_.status() != StatusCode::PARTIAL_CONTENT {
        let bloqueado = final_.status() == StatusCode::FORBIDDEN;
        let corpo = serde_json::json!({
            "error": format!("Failed to fetch: {}", final_.status()),
            "status": final_.status().as_u16(),
            "hint": if bloqueado { "proxy_blocked" } else { "" },
        })
        .to_string();
        let mut r = Response::builder()
            .status(final_.status())
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(corpo))
            .unwrap();
        cors(&mut r);
        return r;
    }

    let origem_proxy = format!(
        "http://{}",
        pedido
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("127.0.0.1")
    );

    if hls || dash {
        let status = final_.status();
        let Ok(corpo) = final_.text().await else {
            return erro(StatusCode::BAD_GATEWAY, "manifesto ilegível");
        };
        let (tipo_saida, reescrito) = if hls {
            (
                "application/vnd.apple.mpegurl",
                reescrever_m3u8(&corpo, &atual, &origem_proxy, referer.as_deref(), ua.as_deref()),
            )
        } else {
            (
                "application/dash+xml",
                reescrever_mpd(&corpo, &atual, &origem_proxy, referer.as_deref(), ua.as_deref()),
            )
        };
        return texto(status, tipo_saida, reescrito);
    }

    // Sub-playlists desse provedor usam URLs opacas (`/m3/token`) e MIME
    // text/plain. É preciso olhar o corpo para descobri-las; se passassem como
    // arquivo comum, os segmentos absolutos escapariam do proxy e o navegador
    // os bloquearia por CORS.
    if tipo.to_ascii_lowercase().contains("text/plain") {
        let status = final_.status();
        let Ok(bytes) = final_.bytes().await else {
            return erro(StatusCode::BAD_GATEWAY, "resposta de texto ilegível");
        };
        let corpo = String::from_utf8_lossy(&bytes).into_owned();
        if corpo.trim_start().starts_with("#EXTM3U") {
            return texto(
                status,
                "application/vnd.apple.mpegurl",
                reescrever_m3u8(&corpo, &atual, &origem_proxy, referer.as_deref(), ua.as_deref()),
            );
        }
        return texto(status, &tipo, corpo);
    }

    responder_em_fluxo(final_, faixa.as_deref())
}

/// Devolve o vídeo em fluxo, com o `Content-Range` conferido.
///
/// Parte das origens responde ao pedido de intervalo declarando o fim do
/// arquivo inteiro — pede-se `bytes=0-1`, chegam dois bytes e o cabeçalho diz
/// `bytes 0-2966290988/2966290989`. Player que confere isso trata a resposta
/// como truncada e para antes do primeiro quadro.
fn responder_em_fluxo(origem: reqwest::Response, faixa: Option<&str>) -> Response {
    let status = origem.status();
    let mut cabecalhos = HeaderMap::new();
    for nome in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::LAST_MODIFIED,
        header::ETAG,
    ] {
        if let Some(v) = origem.headers().get(&nome) {
            cabecalhos.insert(nome, v.clone());
        }
    }

    let tamanho = origem.content_length();
    let total = origem
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('/').next().map(str::to_string))
        .and_then(|v| v.trim().parse::<u64>().ok());

    if status == StatusCode::PARTIAL_CONTENT {
        let inicio = faixa.map(comeco_pedido).unwrap_or(0);
        let fim = inicio + tamanho.unwrap_or(1).max(1) - 1;
        let denominador = total.map(|t| t.to_string()).unwrap_or_else(|| "*".into());
        if let Ok(v) = HeaderValue::from_str(&format!("bytes {inicio}-{fim}/{denominador}")) {
            cabecalhos.insert(header::CONTENT_RANGE, v);
        }
    }

    cabecalhos.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    cabecalhos.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    cabecalhos.insert(
        HeaderName::from_static("access-control-expose-headers"),
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified"),
    );

    let mut resposta = Response::builder()
        .status(status)
        .body(Body::from_stream(origem.bytes_stream()))
        .unwrap();
    *resposta.headers_mut() = cabecalhos;
    cors(&mut resposta);
    resposta
}

fn comeco_pedido(faixa: &str) -> u64 {
    faixa
        .split_once('=')
        .map(|(_, resto)| resto)
        .unwrap_or(faixa)
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

async fn buscar(
    cliente: &reqwest::Client,
    url: &str,
    cabecalhos: &[(String, String)],
) -> Result<reqwest::Response, reqwest::Error> {
    let mut pedido = cliente.get(url).timeout(Duration::from_secs(45));
    for (chave, valor) in cabecalhos {
        pedido = pedido.header(chave.as_str(), valor.as_str());
    }
    pedido.send().await
}

fn valor_de(cabecalhos: &[(String, String)], chave: &str) -> Option<String> {
    cabecalhos
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(chave))
        .map(|(_, v)| v.clone())
}

fn juntar_cookie(cabecalhos: &mut Vec<(String, String)>, novo: &str) {
    if let Some((_, valor)) = cabecalhos.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case("Cookie")) {
        valor.push_str("; ");
        valor.push_str(novo);
    } else {
        cabecalhos.push(("Cookie".into(), novo.to_string()));
    }
}

fn montar(
    pares: &[(&str, &str)],
    cookie: &Option<String>,
    faixa: &Option<String>,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = pares
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    if let Some(c) = cookie {
        out.push(("Cookie".into(), c.clone()));
    }
    if let Some(f) = faixa {
        out.push(("Range".into(), f.clone()));
    }
    out
}

#[cfg(test)]
mod testes {
    use super::*;

    const PROXY: &str = "http://127.0.0.1:9000";

    #[test]
    fn proxia_com_os_cabecalhos_da_fonte() {
        let saida = proxiado("https://cdn.tv/a b.m3u8", PROXY, Some("https://site/"), None);
        assert_eq!(
            saida,
            "http://127.0.0.1:9000/api/proxy?url=https%3A%2F%2Fcdn.tv%2Fa%20b.m3u8&referer=https%3A%2F%2Fsite%2F"
        );
    }

    #[test]
    fn gabarito_do_dash_sobrevive_ao_encode() {
        let saida = proxiado_gabarito("https://cdn.tv/seg-$Number$.m4s", PROXY, None, None);
        assert!(saida.ends_with("seg-$Number$.m4s"), "{saida}");
    }

    #[test]
    fn segmento_vai_para_a_pasta_do_url_aninhado() {
        let playlist = "https://terceiro.net/tos-x/proxy.m3u8?url=https%3A%2F%2Forigem.tv%2Fdocs%2Ftelecine%2F__index.m3u8";
        let pedido = "https://terceiro.net/tos-x/seg-1.ts";
        // A pasta muda; o servidor continua sendo o que serve a playlist.
        assert_eq!(
            corrigir_caminho_aninhado(playlist, pedido),
            "https://terceiro.net/docs/telecine/seg-1.ts"
        );
    }

    #[test]
    fn a_propria_playlist_nao_muda_de_pasta() {
        let playlist = "https://terceiro.net/tos-x/proxy.m3u8?url=https%3A%2F%2Forigem.tv%2Fdocs%2Ft%2Fi.m3u8";
        assert_eq!(corrigir_caminho_aninhado(playlist, playlist), playlist);
    }

    #[test]
    fn reescreve_segmento_e_chave_do_hls() {
        let entrada = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:6,\nseg1.ts\n";
        let saida = reescrever_m3u8(entrada, "https://cdn.tv/live/i.m3u8", PROXY, None, None);
        assert!(saida.contains("URI=\"http://127.0.0.1:9000/api/proxy?url=https%3A%2F%2Fcdn.tv%2Flive%2Fkey.bin\""), "{saida}");
        assert!(saida.contains("proxy?url=https%3A%2F%2Fcdn.tv%2Flive%2Fseg1.ts"), "{saida}");
        assert!(saida.starts_with("#EXTM3U\n"));
    }

    #[test]
    fn linha_de_comentario_sem_uri_fica_igual() {
        let entrada = "#EXT-X-VERSION:3";
        assert_eq!(reescrever_m3u8(entrada, "https://cdn.tv/i.m3u8", PROXY, None, None), entrada);
    }

    #[test]
    fn dash_resolve_pela_base_e_some_com_ela() {
        let entrada = r#"<MPD><BaseURL>https://cdn.tv/dash/</BaseURL><SegmentTemplate initialization="init.mp4" media="seg-$Number$.m4s"/></MPD>"#;
        let saida = reescrever_mpd(entrada, "https://origem.tv/manifest.mpd", PROXY, None, None);
        assert!(!saida.contains("<BaseURL>"), "{saida}");
        assert!(saida.contains("url=https%3A%2F%2Fcdn.tv%2Fdash%2Finit.mp4"), "{saida}");
        assert!(saida.contains("seg-$Number$.m4s"), "{saida}");
    }

    #[test]
    fn atributo_do_dash_escapa_o_e_comercial() {
        let entrada = r#"<MPD><SegmentTemplate media="seg.m4s"/></MPD>"#;
        let saida = reescrever_mpd(entrada, "https://cdn.tv/m.mpd", PROXY, Some("https://site/"), None);
        assert!(saida.contains("&amp;referer="), "{saida}");
        assert!(!saida.contains("\"&referer"), "{saida}");
    }

    #[test]
    fn comeco_do_intervalo_sai_do_cabecalho() {
        assert_eq!(comeco_pedido("bytes=100000-100100"), 100_000);
        assert_eq!(comeco_pedido("bytes=0-"), 0);
        assert_eq!(comeco_pedido("lixo"), 0);
    }

    #[test]
    fn parametro_chega_decodificado_como_no_navegador() {
        let args = parametros("url=https%3A%2F%2Fa.tv%2Fx.m3u8%3Fa%3D1%26b%3D2&ua=Lavf%2F58");
        assert_eq!(args["url"], "https://a.tv/x.m3u8?a=1&b=2");
        assert_eq!(args["ua"], "Lavf/58");
    }
}
