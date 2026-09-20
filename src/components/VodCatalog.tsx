/**
 * Catálogo de filmes e séries, lido do mesmo repositório que o aplicativo usa.
 *
 * A navegação é por letra porque o acervo é publicado por letra: trinta mil
 * títulos não cabem numa página, e pedir a letra inteira custa uns cem
 * quilobytes. A busca é a exceção — o índice de nomes é pequeno o bastante para
 * procurar no acervo todo sem baixá-lo.
 */

import * as telemetria from '../services/telemetria';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Movie, MovieSource } from '../types/movie';
import {
  LETRAS,
  buscar,
  capa,
  colecao,
  destaques,
  episodios,
  filme as buscarFilme,
  filmes as listarFilmes,
  indice,
  serie as buscarSerie,
  series as listarSeries,
  type Achado,
  type Episodio,
  type FilaDestaque,
  type ItemDestaque,
  type Filme,
  type Gaveta,
  type Serie,
  type SerieColecao,
} from '../services/vodService';
import './VodCatalog.css';

type Aba = 'inicio' | 'filmes' | 'series' | 'animes' | 'doramas' | 'extra';

/** Quantos cartões entram por vez ao rolar. */
const PAGINA = 120;

interface VodCatalogProps {
  onSelectMovie: (movie: Movie) => void;
  onBack: () => void;
  /// Mesma trava de 18+ dos canais — sem ela a aba nem aparece, e é o que
  /// faltava aqui: o app já esconde/mostra "extra" junto com o desbloqueio,
  /// o site nunca recebia esse estado.
  isAdultUnlocked: boolean;
}

interface Item {
  chave: string;
  titulo: string;
  rotulo: string;
  serie: boolean;
  letra: string;
  filme?: Filme;
  dados?: Serie;
  colecao?: SerieColecao;
}

const eColecao = (aba: Aba): aba is 'animes' | 'doramas' =>
  aba === 'animes' || aba === 'doramas';

function letraDe(texto: string): string {
  const primeira = normalizar(texto).trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(primeira) ? primeira : '#';
}

function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase();
}

function nomeDaFonte(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return 'Servidor alternativo'; }
}

/** Capa buscada só quando o cartão aparece: são vinte na tela, não trinta mil. */
function Poster({ titulo, serie }: { titulo: string; serie: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [visivel, setVisivel] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisivel(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visivel) return;
    let vivo = true;
    capa(titulo, serie).then((url) => { if (vivo) setSrc(url); });
    return () => { vivo = false; };
  }, [visivel, titulo, serie]);

  return (
    <div className="vod-poster" ref={ref}>
      {src
        ? <img src={src} alt={titulo} loading="lazy" />
        : <div className="vod-poster-vazio">{titulo.slice(0, 2).toUpperCase()}</div>}
    </div>
  );
}

/**
 * A primeira tela do acervo: fileiras de capa que correm para o lado.
 *
 * Uma grade alfabética serve para achar o que já se sabe que existe; não serve
 * para descobrir. As fileiras mostram o que há, e a busca continua no mesmo
 * lugar, filtrando dentro delas — a fileira que fica sem nada sai da tela, em
 * vez de virar um título com o vazio embaixo.
 *
 * As capas chegam prontas do destaques.txt, então esta tela não pergunta nada
 * ao TMDB: o `src` do pôster já veio no arquivo.
 */
function Fileiras({
  filas, termo, aoAbrir,
}: {
  filas: FilaDestaque[];
  termo: string;
  aoAbrir: (destaque: ItemDestaque) => void;
}) {
  const procurado = normalizar(termo.trim());
  const visiveis = useMemo(() => {
    if (!procurado) return filas;
    return filas
      .map((fila) => ({
        ...fila,
        itens: fila.itens.filter((item) => normalizar(item.titulo).includes(procurado)),
      }))
      .filter((fila) => fila.itens.length > 0);
  }, [filas, procurado]);

  if (!filas.length) return <p className="vod-aviso">Carregando…</p>;
  if (!visiveis.length) return <p className="vod-aviso">Nada por aqui. Tente outra busca.</p>;

  return (
    <div className="vod-fileiras">
      {visiveis.map((fila) => (
        <section className="vod-fileira" key={fila.titulo}>
          <h3>{fila.titulo}</h3>
          <div className="vod-fileira-pista">
            {fila.itens.map((destaque) => (
              <button
                key={`${fila.titulo}:${destaque.titulo}`}
                className="vod-card"
                onClick={() => aoAbrir(destaque)}
              >
                <div className="vod-poster">
                  {destaque.capa
                    ? <img src={destaque.capa} alt={destaque.titulo} loading="lazy" />
                    : <div className="vod-poster-vazio">{destaque.titulo.slice(0, 2).toUpperCase()}</div>}
                </div>
                <span className="vod-card-titulo">{destaque.titulo}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function VodCatalog({ onSelectMovie, onBack, isAdultUnlocked }: VodCatalogProps) {
  const [aba, setAba] = useState<Aba>('inicio');
  const [filas, setFilas] = useState<FilaDestaque[]>([]);

  // Se travar de novo com a aba extra aberta, ela não pode continuar visível.
  useEffect(() => {
    if (!isAdultUnlocked && aba === 'extra') setAba('filmes');
  }, [isAdultUnlocked, aba]);
  const [letra, setLetra] = useState('A');
  const [gavetas, setGavetas] = useState<Gaveta[]>([]);
  const [itens, setItens] = useState<Item[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [termo, setTermo] = useState('');
  const [busca, setBusca] = useState<Achado[] | null>(null);
  const [buscaExtra, setBuscaExtra] = useState<Item[] | null>(null);
  const [aberto, setAberto] = useState<Item | null>(null);
  const [episodiosAbertos, setEpisodiosAbertos] = useState<Episodio[] | null>(null);
  const [fontesAbertas, setFontesAbertas] = useState<MovieSource[] | null>(null);
  const [modalCarregando, setModalCarregando] = useState(false);
  const [erroModal, setErroModal] = useState<string | null>(null);
  const [temporada, setTemporada] = useState(1);
  const [erro, setErro] = useState<string | null>(null);
  const abertura = useRef(0);
  /*
   * A letra A traz três mil e quinhentos filmes, e três mil e quinhentos
   * cartões de uma vez travam a rolagem antes de a primeira capa aparecer. A
   * lista inteira já está na memória; o que cresce aqui é só o que vai para a
   * tela, conforme a pessoa chega ao fim.
   *
   * A contagem anda junto da lista a que pertence: trocar de letra devolve a
   * primeira página sozinho, sem um efeito que zere o número depois de a lista
   * nova já ter sido desenhada inteira.
   */
  const [pagina, setPagina] = useState({ lista: '', quantos: PAGINA });
  const sentinela = useRef<HTMLDivElement>(null);

  useEffect(() => {
    indice().then(setGavetas).catch(() => setGavetas([]));
    destaques().then(setFilas).catch(() => setFilas([]));
  }, []);

  const contagem = useMemo(() => {
    const mapa = new Map<string, Gaveta>();
    gavetas.forEach((g) => mapa.set(g.letra, g));
    return mapa;
  }, [gavetas]);

  // Termo em busca dentro do próprio 18+ — não usa o índice geral (ver
  // abaixo), então tem letra própria de "buscando".
  const buscandoExtra = aba === 'extra' && termo.trim().length >= 2;
  const buscandoColecao = eColecao(aba) && termo.trim().length >= 2;
  const buscaAtiva = aba === 'extra' ? buscandoExtra : eColecao(aba) ? buscandoColecao : !!busca;

  // Lista da letra escolhida. A busca, quando ativa, manda na tela.
  useEffect(() => {
    if (buscaAtiva && !eColecao(aba)) return;
    let vivo = true;
    setCarregando(true);
    setErro(null);

    const trabalho = eColecao(aba)
      ? colecao(aba).then((lista) => lista
        .filter((s) => buscandoColecao || letraDe(s.titulo) === letra)
        .map<Item>((s) => ({
          chave: `${aba}:${s.tmdbId}:${s.titulo}`,
          titulo: s.titulo,
          rotulo: s.nomeCompleto,
          serie: true,
          letra,
          colecao: s,
        })))
      : aba === 'series'
      ? listarSeries(letra).then((lista) => lista.map<Item>((s) => ({
        chave: `s:${s.titulo}:${s.ano}`,
        titulo: s.titulo,
        rotulo: s.nomeCompleto,
        serie: true,
        letra,
        dados: s,
      })))
      : listarFilmes(letra, aba === 'extra').then((lista) => lista.map<Item>((f) => ({
        chave: `${aba === 'extra' ? 'x' : 'f'}:${f.titulo}`,
        titulo: f.titulo,
        rotulo: f.titulo,
        serie: false,
        letra,
        filme: f,
      })));

    trabalho
      .then((lista) => { if (vivo) setItens(lista); })
      .catch(() => { if (vivo) { setItens([]); setErro('Não foi possível carregar esta letra.'); } })
      .finally(() => { if (vivo) setCarregando(false); });

    return () => { vivo = false; };
  }, [aba, letra, buscaAtiva, buscandoColecao]);

  // Busca no acervo inteiro, com folga para quem ainda está digitando. Fica
  // de fora quando a aba é o 18+ — o índice geral nunca traz título
  // reservado (ver gerar_vod.py), então essa chamada não acharia nada lá.
  useEffect(() => {
    const alvo = termo.trim();
    if (alvo.length < 2 || aba === 'extra' || eColecao(aba)) { setBusca(null); return; }
    const tempo = window.setTimeout(() => {
      setCarregando(true);
      buscar(alvo)
        .then((achados) => {
          setBusca(achados);
          telemetria.buscou('vod', alvo, () => achados.length > 0);
        })
        .catch(() => setBusca([]))
        .finally(() => setCarregando(false));
    }, 350);
    return () => window.clearTimeout(tempo);
  }, [termo, aba]);

  /// Busca dentro do 18+: como o título reservado não está no índice geral,
  /// aqui é o próprio acervo reservado (pequeno: nove mil títulos) que é
  /// vasculhado, uma letra de cada vez, só nas letras que têm alguma.
  useEffect(() => {
    if (!buscandoExtra) { setBuscaExtra(null); return; }
    const alvo = normalizar(termo.trim());
    let vivo = true;
    const tempo = window.setTimeout(() => {
      setCarregando(true);
      const letras = gavetas.filter((g) => g.reservados > 0).map((g) => g.letra);
      Promise.all(letras.map((l) => listarFilmes(l, true).then((lista) => ({ letra: l, lista }))))
        .then((porLetra) => {
          if (!vivo) return;
          const achados = porLetra.flatMap(({ letra: l, lista }) => lista
            .filter((f) => normalizar(f.titulo).includes(alvo))
            .map<Item>((f) => ({
              chave: `x:${f.titulo}`,
              titulo: f.titulo,
              rotulo: f.titulo,
              serie: false,
              letra: l,
              filme: f,
            })));
          setBuscaExtra(achados);
        })
        .catch(() => { if (vivo) setBuscaExtra([]); })
        .finally(() => { if (vivo) setCarregando(false); });
    }, 350);
    return () => { vivo = false; window.clearTimeout(tempo); };
  }, [buscandoExtra, termo, gavetas]);

  const resultados = useMemo<Item[]>(() => {
    if (aba === 'extra') return buscandoExtra ? buscaExtra ?? [] : itens;
    if (eColecao(aba)) {
      if (!buscandoColecao) return itens;
      const alvo = normalizar(termo.trim());
      return itens.filter((item) => normalizar(item.rotulo).includes(alvo));
    }
    if (!busca) return itens;
    return busca
      .filter((a) => (aba === 'series' ? a.serie : !a.serie))
      .map((a) => ({
        chave: `${a.serie ? 's' : 'f'}:${a.titulo}:${a.ano}`,
        titulo: a.titulo,
        rotulo: a.nomeCompleto,
        serie: a.serie,
        letra: a.letra,
      }));
  }, [busca, buscaExtra, buscandoExtra, buscandoColecao, itens, aba, termo]);

  const fecharModal = useCallback(() => {
    abertura.current += 1;
    setAberto(null);
    setEpisodiosAbertos(null);
    setFontesAbertas(null);
    setErroModal(null);
    setModalCarregando(false);
  }, []);

  /**
   * Abre o título no player, levando todas as fontes.
   *
   * A primeira é a preferida — o catálogo já sai com a melhor resolução na
   * frente. As outras vão junto para a pessoa poder trocar dentro do player,
   * sem voltar à lista, inclusive quando nenhuma abre no site.
   */
  const tocar = useCallback((titulo: string, fontes: MovieSource[], tipo: 'movie' | 'series') => {
    const primeira = fontes[0]?.url;
    if (!primeira) return;
    fecharModal();
    onSelectMovie({
      id: `${tipo}-${titulo}-${primeira}`.slice(0, 200),
      name: titulo,
      url: primeira,
      sources: fontes,
      category: tipo === 'series' ? 'Séries' : 'Filmes',
      type: tipo,
    });
  }, [onSelectMovie, fecharModal]);

  useEffect(() => {
    if (!aberto) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const aoTeclado = (event: KeyboardEvent) => {
      if (event.key === 'Escape') fecharModal();
    };
    window.addEventListener('keydown', aoTeclado);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', aoTeclado);
    };
  }, [aberto, fecharModal]);

  /** Todo cartão abre suas opções no modal, sem mover a página para o topo. */
  const abrir = useCallback(async (item: Item) => {
    setErro(null);
    setErroModal(null);
    setAberto(item);
    setEpisodiosAbertos(null);
    setFontesAbertas(null);
    setModalCarregando(true);
    const tentativa = ++abertura.current;
    try {
      if (!item.serie) {
        const dados = item.filme
          ?? await buscarFilme({ titulo: item.titulo, serie: false, letra: item.letra, ano: '', nomeCompleto: item.titulo });
        const fontes: MovieSource[] = Object.entries(dados?.fontes ?? {})
          .flatMap(([versao, urls]) => urls.map((url) => ({ url, versao })));
        if (tentativa !== abertura.current) return;
        setFontesAbertas(fontes);
        if (!fontes.length) setErroModal(`Sem fonte disponível para "${item.titulo}".`);
        return;
      }

      if (item.colecao) {
        setEpisodiosAbertos(item.colecao.episodios);
        setTemporada(item.colecao.episodios[0]?.temporada ?? 1);
        return;
      }

      const ano = item.dados?.ano ?? item.chave.split(':')[2] ?? '';
      const dados = item.dados
        ?? await buscarSerie({ titulo: item.titulo, serie: true, letra: item.letra, ano, nomeCompleto: item.rotulo });
      if (tentativa !== abertura.current) return;
      if (!dados) { setErroModal(`Não foi possível abrir "${item.rotulo}".`); return; }
      setAberto({ ...item, dados });
      const lista = await episodios(item.letra, dados);
      if (tentativa !== abertura.current) return;
      setEpisodiosAbertos(lista);
      setTemporada(lista[0]?.temporada ?? 1);
      if (!lista.length) setErroModal('Nenhum episódio encontrado.');
    } catch {
      if (tentativa === abertura.current) setErroModal(`Não foi possível abrir "${item.rotulo}".`);
    } finally {
      if (tentativa === abertura.current) setModalCarregando(false);
    }
  }, []);

  /**
   * Abre um destaque da tela inicial.
   *
   * Filme e série passam pelo caminho de sempre. Anime e dorama, não: eles não
   * moram no acervo por letra, e sim nas coleções, que já vêm com os episódios
   * dentro. Sem buscar o título ali antes, o modal tentava achá-lo entre as
   * séries comuns — com a letra vazia, ainda por cima — e só sabia dizer que
   * não deu para abrir.
   */
  const abrirDestaque = useCallback(async (destaque: ItemDestaque) => {
    const serie = destaque.tipo !== 'f';
    const base: Item = {
      chave: `${destaque.tipo}:${destaque.titulo}`,
      titulo: destaque.titulo,
      rotulo: destaque.titulo,
      serie,
      letra: destaque.letra,
    };

    if (destaque.tipo !== 'a' && destaque.tipo !== 'd') {
      await abrir(base);
      return;
    }

    const tipo = destaque.tipo === 'a' ? 'animes' : 'doramas';
    setAberto(base);
    setModalCarregando(true);
    setErroModal(null);
    try {
      const lista = await colecao(tipo);
      const achada = lista.find(
        (s) => normalizar(s.titulo) === normalizar(destaque.titulo));
      if (!achada) {
        setErroModal(`Não foi possível abrir "${destaque.titulo}".`);
        return;
      }
      await abrir({
        ...base,
        chave: `${tipo}:${achada.tmdbId}:${achada.titulo}`,
        rotulo: achada.titulo,
        colecao: achada,
      });
    } catch {
      setErroModal(`Não foi possível abrir "${destaque.titulo}".`);
    } finally {
      setModalCarregando(false);
    }
  }, [abrir]);

  const temporadas = useMemo(() => {
    if (!episodiosAbertos) return [];
    return [...new Set(episodiosAbertos.map((e) => e.temporada))].sort((a, b) => a - b);
  }, [episodiosAbertos]);

  const listaAtual = buscaAtiva ? `busca:${termo.trim()}:${aba}` : `${aba}:${letra}`;
  const visiveis = pagina.lista === listaAtual ? pagina.quantos : PAGINA;

  useEffect(() => {
    const alvo = sentinela.current;
    if (!alvo) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setPagina((atual) => ({
        lista: listaAtual,
        quantos: (atual.lista === listaAtual ? atual.quantos : PAGINA) + PAGINA,
      }));
    }, { rootMargin: '600px' });
    observer.observe(alvo);
    return () => observer.disconnect();
  }, [listaAtual]);

  const daTemporada = useMemo(
    () => (episodiosAbertos ?? [])
      .filter((e) => e.temporada === temporada)
      .sort((a, b) => a.numero - b.numero),
    [episodiosAbertos, temporada],
  );

  return (
    <>
    <div className="vod-catalog">
      <header className="vod-header">
        <button className="vod-voltar" onClick={onBack} aria-label="Voltar">←</button>
        <div className="vod-abas">
          <button
            className={aba === 'inicio' ? 'ativa' : ''}
            onClick={() => { setAba('inicio'); setAberto(null); setTermo(''); }}
          >
            Início
          </button>
          <button
            className={aba === 'filmes' ? 'ativa' : ''}
            onClick={() => { setAba('filmes'); setAberto(null); }}
          >
            Filmes
          </button>
          <button
            className={aba === 'series' ? 'ativa' : ''}
            onClick={() => { setAba('series'); setAberto(null); }}
          >
            Séries
          </button>
          <button
            className={aba === 'animes' ? 'ativa' : ''}
            onClick={() => { setAba('animes'); setAberto(null); setTermo(''); setLetra('A'); }}
          >
            Animes
          </button>
          <button
            className={aba === 'doramas' ? 'ativa' : ''}
            onClick={() => { setAba('doramas'); setAberto(null); setTermo(''); setLetra('A'); }}
          >
            Doramas
          </button>
          {isAdultUnlocked && (
            <button
              className={aba === 'extra' ? 'ativa' : ''}
              onClick={() => { setAba('extra'); setAberto(null); setTermo(''); }}
            >
              18+
            </button>
          )}
        </div>
        <input
          className="vod-busca"
          type="search"
          placeholder={aba === 'extra' ? 'Buscar no 18+…'
            : eColecao(aba) ? `Buscar em ${aba}…`
            : 'Buscar em todo o acervo…'}
          value={termo}
          onChange={(e) => setTermo(e.target.value)}
        />
        {/* Esta tela não usa o cabeçalho do site, e é onde se passa mais tempo:
            os mesmos dois atalhos precisam estar aqui também. */}
        <a
          className="vod-link"
          href="https://discord.gg/8DKqT3xJvD"
          target="_blank"
          rel="noreferrer noopener"
          title="Comunidade no Discord"
          aria-label="Comunidade no Discord"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3c-.164.293-.355.686-.487.998a18.27 18.27 0 0 0-4.14 0A12.6 12.6 0 0 0 11.437 3a19.74 19.74 0 0 0-3.76 1.369C3.29 10.02 2.24 15.53 2.76 20.96a19.9 19.9 0 0 0 5.99 3.04c.484-.66.915-1.362 1.286-2.1a12.9 12.9 0 0 1-2.025-.973c.17-.124.336-.254.496-.388 3.9 1.79 8.12 1.79 11.973 0 .162.134.328.264.497.388-.647.38-1.325.706-2.03.974.372.737.802 1.439 1.286 2.099a19.86 19.86 0 0 0 5.994-3.04c.6-6.28-1.06-11.74-4.91-16.59ZM9.68 17.65c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.951-2.42 2.157-2.42 1.213 0 2.18 1.096 2.157 2.42 0 1.334-.951 2.42-2.157 2.42Zm7.64 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.951-2.42 2.157-2.42 1.213 0 2.18 1.096 2.157 2.42 0 1.334-.944 2.42-2.157 2.42Z" />
          </svg>
        </a>
        <a
          className="vod-link"
          href="https://github.com/gabrielsaimo/SaimoPlayer"
          target="_blank"
          rel="noreferrer noopener"
          title="Lista de canais no GitHub"
          aria-label="Lista de canais no GitHub"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2.1c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.26 5.69.41.36.78 1.06.78 2.15v3.19c0 .31.21.67.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
          </svg>
        </a>
      </header>

      {aba !== 'inicio' && !buscaAtiva && (
        <nav className="vod-letras">
          {LETRAS.map((l) => {
            const g = contagem.get(l);
            const quantos = eColecao(aba) ? undefined
              : aba === 'series' ? g?.series ?? 0
              : aba === 'extra' ? g?.reservados ?? 0
              : g?.filmes ?? 0;
            return (
              <button
                key={l}
                className={l === letra ? 'ativa' : ''}
                disabled={!eColecao(aba) && gavetas.length > 0 && quantos === 0}
                onClick={() => { setLetra(l); setAberto(null); }}
                title={quantos ? `${quantos} títulos` : undefined}
              >
                {l}
              </button>
            );
          })}
        </nav>
      )}

      {erro && <p className="vod-erro">{erro}</p>}

      {aba !== 'inicio' && carregando && <p className="vod-aviso">Carregando…</p>}

      {aba === 'inicio' ? (
        <Fileiras filas={filas} termo={termo} aoAbrir={abrirDestaque} />
      ) : (
      <div className="vod-grade">
        {resultados.slice(0, visiveis).map((item) => (
          <button key={item.chave} className="vod-card" onClick={() => abrir(item)}>
            <Poster titulo={item.rotulo} serie={item.serie} />
            <span className="vod-card-titulo">{item.rotulo}</span>
          </button>
        ))}
      </div>
      )}

      <div ref={sentinela} className="vod-sentinela" aria-hidden="true" />

      {aba !== 'inicio' && !carregando && resultados.length === 0 && (
        <p className="vod-aviso">Nada por aqui. Tente outra letra ou outra busca.</p>
      )}
    </div>
    {aberto && createPortal(
      <div className="vod-modal-fundo" onMouseDown={fecharModal}>
        <section
          className="vod-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="vod-modal-titulo"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="vod-serie-topo">
            <div>
              <span className="vod-modal-tipo">
                {aberto.serie
                  ? (aberto.colecao
                    ? (aberto.chave.startsWith('animes:') ? 'Anime' : 'Dorama')
                    : 'Série')
                  : 'Filme'}
              </span>
              <h2 id="vod-modal-titulo">{aberto.rotulo}</h2>
            </div>
            <button className="vod-modal-fechar" onClick={fecharModal} aria-label="Fechar">×</button>
          </div>

          {modalCarregando && <p className="vod-aviso">Carregando opções…</p>}
          {erroModal && <p className="vod-erro">{erroModal}</p>}

          {!aberto.serie && fontesAbertas && fontesAbertas.length > 0 && (
            <div className="vod-fontes">
              <p>Escolha a versão e a fonte:</p>
              {fontesAbertas.map((fonte, indice) => (
                <button
                  key={`${fonte.url}-${indice}`}
                  onClick={() => tocar(
                    aberto.titulo,
                    [fonte, ...fontesAbertas.filter((_, outro) => outro !== indice)],
                    'movie',
                  )}
                >
                  <span>
                    <strong>{fonte.versao === 'leg' ? 'Legendado' : 'Dublado'}</strong>
                    <small>{nomeDaFonte(fonte.url)}</small>
                  </span>
                  <em>Fonte {indice + 1}</em>
                </button>
              ))}
            </div>
          )}

          {aberto.serie && (
            <>
              {temporadas.length > 1 && (
                <div className="vod-temporadas">
                  {temporadas.map((t) => (
                    <button
                      key={t}
                      className={t === temporada ? 'ativa' : ''}
                      onClick={() => setTemporada(t)}
                    >
                      T{t}
                    </button>
                  ))}
                </div>
              )}
              <ul className="vod-episodios">
                {daTemporada.map((e) => (
                  <li key={`${e.temporada}-${e.numero}-${e.versao}`}>
                    <button onClick={() => tocar(`${aberto.rotulo} — T${e.temporada}E${e.numero}`,
                                              e.urls.map((url) => ({ url, versao: e.versao })), 'series')}>
                      <span className="vod-ep-numero">T{e.temporada}E{e.numero}</span>
                      <span className="vod-ep-versao">
                        {e.versao === 'leg' ? 'Legendado' : 'Dublado'} · {e.urls.length} fonte{e.urls.length === 1 ? '' : 's'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>,
      document.body,
    )}
    </>
  );
}
