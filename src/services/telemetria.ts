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

/** "Chrome 140 · Windows", sem guardar o user-agent inteiro. */
function navegador(): { model: string; os: string } {
  const ua = navigator.userAgent;
  const achar = (re: RegExp) => { const m = re.exec(ua); return m ? m[1] : null; };
  const nome =
    (achar(/Edg\/(\d+)/) && `Edge ${achar(/Edg\/(\d+)/)}`) ||
    (achar(/OPR\/(\d+)/) && `Opera ${achar(/OPR\/(\d+)/)}`) ||
    (achar(/SamsungBrowser\/(\d+)/) && `Samsung Internet ${achar(/SamsungBrowser\/(\d+)/)}`) ||
    (achar(/Firefox\/(\d+)/) && `Firefox ${achar(/Firefox\/(\d+)/)}`) ||
    (achar(/Chrome\/(\d+)/) && `Chrome ${achar(/Chrome\/(\d+)/)}`) ||
    (achar(/Version\/(\d+).*Safari/) && `Safari ${achar(/Version\/(\d+).*Safari/)}`) ||
    'Navegador';
  const os =
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /CrOS/.test(ua) ? 'ChromeOS' :
    /Linux/.test(ua) ? 'Linux' : 'outro';
  const tv = /SmartTV|SMART-TV|Tizen|Web0S|webOS|BRAVIA|AFT\w|GoogleTV|Android TV/i.test(ua) ? ' · TV' : '';
  return { model: `${nome}${tv}`, os };
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
  const { model, os } = navegador();
  enviar('hello', { model, os }, false).then(async (r) => {
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
