/**
 * O que o Saimo Monitor fica sabendo deste navegador.
 *
 * Que o site abriu, o que está tocando de tempos em tempos, e quando uma fonte
 * falha, um canal cai ou a página quebra. O aparelho é um UUID sorteado aqui e
 * guardado no localStorage — sem conta, sem cookie de terceiro, e o IP não é
 * gravado: a cidade sai da borda da Cloudflare.
 *
 * Tudo sai como `text/plain` e por sendBeacon quando dá: nenhum preflight de
 * CORS, nada que atrase o vídeo, e a última batida ainda sai quando a aba fecha.
 */

const BASE = 'https://saimo-monitor.gabrielsaimo68.workers.dev/v1';
const PLATAFORMA = 'site';
const VERSAO = 'web';
/** Zapeando, cada canal que passa não vira batida: só quem ficou. */
const MINIMO_PARA_CONTAR_MS = 20_000;

export type Tipo = 'live' | 'vod';

interface Tocando { kind: Tipo; title: string; host: string | null }

let iniciado = false;
let intervaloMs = 300_000;
let relogio: number | undefined;
let tocando: Tocando | null = null;
let contandoDesde = Date.now();
let errosEnviados = 0;

function idDoAparelho(): string {
  const chave = 'saimo-telemetria-id';
  try {
    const salvo = localStorage.getItem(chave);
    if (salvo) return salvo;
    const novo = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
    localStorage.setItem(chave, novo);
    return novo;
  } catch {
    // Sem localStorage (aba privada estrita): um id por carregamento ainda
    // conta a sessão, só não reconhece a volta.
    return '00000000-0000-4000-8000-' + Math.floor(Math.random() * 1e12).toString().padStart(12, '0');
  }
}

const id = idDoAparelho();

function host(url?: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return null; }
}

type TipoDeAparelho = 'celular' | 'tablet' | 'computador' | 'tv';

interface Aparelho { model: string; browser: string; os: string; deviceType: TipoDeAparelho }

/**
 * Aparelho, navegador e sistema — sem guardar o user-agent inteiro.
 *
 * O aparelho é o que dá para saber de verdade: o código do Fire TV (AFTSS,
 * AFTKRT…) que o Silk anuncia, o modelo do Android (SM-A546E), iPhone ou iPad.
 * O Chrome novo esconde o modelo do Android no user-agent ("K"); nele o modelo
 * vem de `userAgentData`, que o painel traduz para nome de gente.
 */
export function descreverAparelho(ua: string, toques: number, modeloDeclarado = '', versaoDeclarada = ''): Aparelho {
  const ver = (re: RegExp) => { const m = re.exec(ua); return m ? m[1] : ''; };
  const fireTv = /\bAFT[A-Z0-9]+/.exec(ua);
  const tv = !!fireTv || /SmartTV|SMART-TV|Tizen|Web0S|webOS|BRAVIA|GoogleTV|Android TV|CrKey|HbbTV|NetCast|AppleTV|Roku/i.test(ua);
  const ipadDisfarcado = /Macintosh/.test(ua) && toques > 1;
  const androidTablet = /Android/.test(ua) && !/Mobile/.test(ua) && !tv;
  const deviceType: TipoDeAparelho =
    tv ? 'tv' :
    /iPad/.test(ua) || ipadDisfarcado || androidTablet ? 'tablet' :
    /Mobi|iPhone|iPod|Android/.test(ua) ? 'celular' : 'computador';

  const browser =
    /Instagram/.test(ua) ? 'Instagram' :
    /FBAN|FBAV|FB_IAB/.test(ua) ? 'Facebook' :
    /WhatsApp/.test(ua) ? 'WhatsApp' :
    /TikTok|musical_ly|BytedanceWebview/.test(ua) ? 'TikTok' :
    /Silk\/(\d+)/.test(ua) ? `Silk ${ver(/Silk\/(\d+)/)}` :
    /EdgiOS\/(\d+)/.test(ua) ? `Edge ${ver(/EdgiOS\/(\d+)/)}` :
    /EdgA?\/(\d+)/.test(ua) ? `Edge ${ver(/EdgA?\/(\d+)/)}` :
    /(?:OPR|OPiOS)\/(\d+)/.test(ua) ? `Opera ${ver(/(?:OPR|OPiOS)\/(\d+)/)}` :
    /SamsungBrowser\/(\d+)/.test(ua) ? `Samsung Internet ${ver(/SamsungBrowser\/(\d+)/)}` :
    /CriOS\/(\d+)/.test(ua) ? `Chrome ${ver(/CriOS\/(\d+)/)}` :
    /FxiOS\/(\d+)/.test(ua) ? `Firefox ${ver(/FxiOS\/(\d+)/)}` :
    /Firefox\/(\d+)/.test(ua) ? `Firefox ${ver(/Firefox\/(\d+)/)}` :
    /; wv\)/.test(ua) ? 'WebView Android' :
    /Chrome\/(\d+)/.test(ua) ? `Chrome ${ver(/Chrome\/(\d+)/)}` :
    /Version\/(\d+).*Safari/.test(ua) ? `Safari ${ver(/Version\/(\d+)/)}` :
    /iPhone|iPad|iPod/.test(ua) ? 'Navegador do iOS' : 'Navegador';

  // "Linux; Android 13; SM-A546E Build/TP1A" -> "SM-A546E". O "K" do user-agent
  // reduzido não é modelo nenhum.
  // Modelo pode ter parêntese ("moto g(30)"): corta no ") AppleWebKit", não no primeiro ")".
  const trecho = /Android [\d.]+; (?:[a-z]{2}[-_][A-Za-z]{2}; )?(.+?)\) AppleWebKit/.exec(ua);
  const doUa = trecho ? trecho[1].replace(/ Build\/.*$/, '').split(';')[0].trim() : '';
  const codigoAndroid = modeloDeclarado.trim() || (doUa && doUa !== 'K' ? doUa : '');
  const model =
    fireTv ? `Amazon ${fireTv[0]}` :
    /iPhone/.test(ua) ? 'Apple iPhone' :
    /iPad/.test(ua) || ipadDisfarcado ? 'Apple iPad' :
    /AppleTV/.test(ua) ? 'Apple TV' :
    /Tizen/.test(ua) ? 'TV Samsung (Tizen)' :
    /Web0S|webOS/.test(ua) ? 'TV LG (webOS)' :
    /Roku/.test(ua) ? 'Roku' :
    /CrKey/.test(ua) ? 'Chromecast' :
    /Android/.test(ua) ? (codigoAndroid || (tv ? 'TV Android' : androidTablet ? 'Tablet Android' : 'Android')) :
    /CrOS/.test(ua) ? 'Chromebook' :
    /Macintosh/.test(ua) ? 'Mac' :
    /Windows/.test(ua) ? 'PC Windows' :
    /Linux/.test(ua) ? 'PC Linux' : 'Desconhecido';

  const ios = /OS (\d+)[_.](\d+)/.exec(ua);
  const os =
    /iPhone|iPad|iPod/.test(ua) && ios ? `${/iPad/.test(ua) ? 'iPadOS' : 'iOS'} ${ios[1]}.${ios[2]}` :
    ipadDisfarcado ? 'iPadOS' :
    fireTv ? `Fire OS (Android ${ver(/Android (\d+(?:\.\d+)?)/)})` :
    /Android (\d+(?:\.\d+)?)/.test(ua) ? `Android ${versaoDeclarada || ver(/Android (\d+(?:\.\d+)?)/)}` :
    /Tizen ([\d.]+)/.test(ua) ? `Tizen ${ver(/Tizen ([\d.]+)/)}` :
    /Web0S|webOS/.test(ua) ? 'webOS' :
    /Windows NT 10/.test(ua) ? 'Windows 10/11' :
    /Windows NT ([\d.]+)/.test(ua) ? `Windows NT ${ver(/Windows NT ([\d.]+)/)}` :
    /Mac OS X/.test(ua) ? 'macOS' :
    /CrOS/.test(ua) ? 'ChromeOS' :
    /Linux/.test(ua) ? 'Linux' : 'outro';

  return { model, browser, os, deviceType };
}

/** Com o modelo que o Chrome só entrega se pedido, sem segurar a abertura por isso. */
async function aparelhoDesteNavegador(): Promise<Aparelho> {
  const toques = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0;
  let modelo = '';
  let versao = '';
  const uad = (navigator as unknown as { userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<{ model?: string; platformVersion?: string; platform?: string }> } }).userAgentData;
  if (uad?.getHighEntropyValues) {
    try {
      const dados = await Promise.race([
        uad.getHighEntropyValues(['model', 'platformVersion']),
        new Promise<null>((r) => setTimeout(() => r(null), 800)),
      ]);
      if (dados) {
        modelo = dados.model || '';
        if (dados.platform === 'Android' && dados.platformVersion) versao = dados.platformVersion.split('.').slice(0, 2).join('.').replace(/\.0$/, '');
      }
    } catch { /* fica o do user-agent */ }
  }
  return descreverAparelho(navigator.userAgent, toques, modelo, versao);
}

function enviar(rota: string, corpo: Record<string, unknown>, beacon = true): Promise<Response | null> {
  const texto = JSON.stringify({ ...corpo, deviceId: id, platform: PLATAFORMA, version: VERSAO });
  const url = `${BASE}/${rota}`;
  if (beacon && typeof navigator.sendBeacon === 'function') {
    try {
      if (navigator.sendBeacon(url, new Blob([texto], { type: 'text/plain' }))) return Promise.resolve(null);
    } catch { /* cai para o fetch */ }
  }
  return fetch(url, { method: 'POST', body: texto, keepalive: true, headers: { 'content-type': 'text/plain' } })
    .catch(() => null);
}

function baterAgora() {
  const agora = Date.now();
  const segundos = tocando ? Math.round((agora - contandoDesde) / 1000) : 0;
  contandoDesde = agora;
  void enviar('beat', { seconds: segundos, playing: tocando });
}

function agendar() {
  if (relogio !== undefined) window.clearInterval(relogio);
  relogio = window.setInterval(baterAgora, intervaloMs);
}

function evento(type: string, extra: Record<string, unknown> = {}) {
  iniciar();
  void enviar('event', { type, ...extra });
}

/** Uma vez por carregamento de página, no App. */
export function iniciar() {
  if (iniciado || typeof window === 'undefined') return;
  iniciado = true;
  aparelhoDesteNavegador().then((aparelho) => enviar('hello', { ...aparelho }, false)).then(async (r) => {
    if (!r || !r.ok) return;
    try {
      const corpo = await r.json();
      const s = Number(corpo.heartbeatSeconds);
      if (s >= 60 && s <= 3600) { intervaloMs = s * 1000; agendar(); }
    } catch { /* fica o padrão */ }
  });
  agendar();

  // Aba fechando: a última batida e o "parou", pelo beacon que sobrevive à saída.
  window.addEventListener('pagehide', () => {
    baterAgora();
    if (tocando) void enviar('event', { type: 'play_stop' });
  });

  const erro = (mensagem: string, pilha?: string) => {
    if (errosEnviados >= 5) return;
    // Ruído de navegador e de extensão que não diz nada sobre o site.
    if (/ResizeObserver|Script error\.?$|extension:\/\//.test(mensagem)) return;
    errosEnviados++;
    evento('error', { detail: `${mensagem}\n${location.pathname}\n${pilha || ''}`.slice(0, 2800) });
  };
  window.addEventListener('error', (e) => erro(e.message || 'erro', e.error?.stack));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    erro(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined);
  });
}

/** `nova` é falso quando é só a próxima fonte do mesmo título depois de uma falha. */
export function comecou(kind: Tipo, title: string, url: string, fonte: number, nova = true) {
  iniciar();
  const agora = Date.now();
  if (tocando && tocando.title !== title && agora - contandoDesde >= MINIMO_PARA_CONTAR_MS) baterAgora();
  if (tocando?.title !== title) contandoDesde = agora;
  tocando = { kind, title, host: host(url) };
  if (nova) evento('play_start', { kind, title, host: host(url), source: fonte });
}

export function tocou(kind: Tipo, title: string, url: string, fonte: number, ms: number) {
  evento('play_ok', { kind, title, host: host(url), source: fonte, detail: `${Math.round(ms)} ms` });
}

export function falhou(kind: Tipo, title: string, url: string, fonte: number, detalhe: string) {
  evento('source_fail', { kind, title, host: host(url), source: fonte, detail: detalhe.slice(0, 200) });
}

export function caiu(kind: Tipo, title: string, fontes: number) {
  evento('channel_down', { kind, title, detail: `nenhuma das ${fontes} fonte(s) abriu` });
}

export function parou() {
  if (!tocando) return;
  if (Date.now() - contandoDesde >= MINIMO_PARA_CONTAR_MS) baterAgora();
  tocando = null;
  evento('play_stop');
}
