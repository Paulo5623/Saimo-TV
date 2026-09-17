/** Uma origem do mesmo título: o endereço e em que idioma ele está. */
export interface MovieSource {
  url: string;
  /** "dub", "leg" — como vem do catálogo. */
  versao?: string;
}

export interface Movie {
  id: string;
  name: string;
  url: string;
  /**
   * Todas as origens do título, na ordem publicada (a melhor primeiro).
   * Quando vem vazia, `url` é a única. Serve para a pessoa trocar de fonte
   * sem voltar para a lista — inclusive quando nenhuma abre aqui dentro.
   */
  sources?: MovieSource[];
  logo?: string;
  category: string;
  year?: string;
  type: 'movie' | 'series';
  rating?: number; // Nota do TMDB/IMDB (0-10)
}

export interface MovieCategory {
  name: string;
  movies: Movie[];
}
