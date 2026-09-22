import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDpad } from '../contexts/DpadContext';
import { Brand } from './Brand';
import './HomeSelector.css';

interface HomeSelectorProps {
  onSelect: (mode: 'tv' | 'movies') => void;
}

export function HomeSelector({ onSelect }: HomeSelectorProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hoveredCard, setHoveredCard] = useState<'tv' | 'movies' | null>(null);
  const { focusFirst, isUsingDpad } = useDpad();
  const navigate = useNavigate();
  
  const tvCardRef = useRef<HTMLButtonElement>(null);
  const moviesCardRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Trigger entrada com animação
    const timer = setTimeout(() => setIsLoaded(true), 100);
    return () => clearTimeout(timer);
  }, []);

  // Auto-foca no primeiro card quando usando D-pad
  useEffect(() => {
    if (isLoaded && isUsingDpad) {
      setTimeout(() => focusFirst(), 200);
    }
  }, [isLoaded, isUsingDpad, focusFirst]);

  // Atualiza o estado visual quando focado via D-pad
  const handleTvFocus = useCallback(() => {
    setHoveredCard('tv');
  }, []);

  const handleMoviesFocus = useCallback(() => {
    setHoveredCard('movies');
  }, []);

  const handleBlur = useCallback(() => {
    if (!isUsingDpad) {
      setHoveredCard(null);
    }
  }, [isUsingDpad]);

  return (
    <div className={`home-selector ${isLoaded ? 'loaded' : ''}`}>
      {/* Background animado */}
      <div className="home-bg">
        <div className="gradient-orb orb-1" />
        <div className="gradient-orb orb-2" />
        <div className="gradient-orb orb-3" />
        <div className="noise-overlay" />
      </div>

      {/* Logo/Brand */}
      <header className="home-header">
        <Brand size="hero" tagline="Entretenimento sem limites" />

        <button
          className="home-download-btn"
          onClick={() => navigate('/app')}
          data-focusable="true"
          data-focus-key="home-download"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span>Baixar app</span>
          <small>TV Box · Celular · Windows · Mac</small>
        </button>
      </header>

      {/* Seletor de modo */}
      <main className="home-main">
        <h2 className="select-title">O que você quer assistir?</h2>
        
        <div className="mode-cards">
          {/* Card TV ao Vivo */}
          <button 
            ref={tvCardRef}
            className={`mode-card tv-card ${hoveredCard === 'tv' ? 'hovered' : ''}`}
            onClick={() => onSelect('tv')}
            onMouseEnter={() => setHoveredCard('tv')}
            onMouseLeave={() => setHoveredCard(null)}
            onFocus={handleTvFocus}
            onBlur={handleBlur}
            data-focusable="true"
            data-focus-key="tv-card"
          >
            <div className="card-bg">
              <div className="card-gradient" />
              <div className="card-pattern" />
            </div>
            
            <div className="card-content">
              <div className="card-icon">
                <svg viewBox="0 0 64 64" fill="none">
                  <rect x="4" y="8" width="56" height="36" rx="4" stroke="currentColor" strokeWidth="3" />
                  <path d="M24 44H40" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  <path d="M32 44V52" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  <path d="M20 52H44" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  {/* Antenna */}
                  <path d="M24 8L32 0L40 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  {/* Signal waves */}
                  <path d="M48 16C48 16 52 18 52 26C52 34 48 36 48 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
                  <path d="M52 12C52 12 58 16 58 26C58 36 52 40 52 40" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.3" />
                </svg>
              </div>
              
              <div className="card-info">
                <h3>TV ao Vivo</h3>
                <p>Canais de TV em tempo real</p>
                <ul className="card-features">
                  <li>📺 +150 canais</li>
                  <li>⚡ Streaming HD</li>
                  <li>📡 Programação EPG</li>
                </ul>
              </div>
              
              <div className="card-action">
                <span>Assistir agora</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </div>
            </div>
            
            <div className="card-glow" />
          </button>

          {/* Divisor */}
          <div className="mode-divider">
            <span>ou</span>
          </div>

          {/* Card Filmes e Séries */}
          <button 
            ref={moviesCardRef}
            className={`mode-card movies-card ${hoveredCard === 'movies' ? 'hovered' : ''}`}
            onClick={() => onSelect('movies')}
            onMouseEnter={() => setHoveredCard('movies')}
            onMouseLeave={() => setHoveredCard(null)}
            onFocus={handleMoviesFocus}
            onBlur={handleBlur}
            data-focusable="true"
            data-focus-key="movies-card"
          >
            <div className="card-bg">
              <div className="card-gradient" />
              <div className="card-pattern" />
            </div>
            
            <div className="card-content">
              <div className="card-icon">
                <svg viewBox="0 0 64 64" fill="none">
                  {/* Film reel */}
                  <rect x="8" y="12" width="48" height="40" rx="4" stroke="currentColor" strokeWidth="3" />
                  {/* Film holes left */}
                  <circle cx="16" cy="20" r="3" stroke="currentColor" strokeWidth="2" />
                  <circle cx="16" cy="32" r="3" stroke="currentColor" strokeWidth="2" />
                  <circle cx="16" cy="44" r="3" stroke="currentColor" strokeWidth="2" />
                  {/* Film holes right */}
                  <circle cx="48" cy="20" r="3" stroke="currentColor" strokeWidth="2" />
                  <circle cx="48" cy="32" r="3" stroke="currentColor" strokeWidth="2" />
                  <circle cx="48" cy="44" r="3" stroke="currentColor" strokeWidth="2" />
                  {/* Play button */}
                  <path d="M28 24L40 32L28 40V24Z" fill="currentColor" />
                  {/* Popcorn stars */}
                  <path d="M4 8L6 12L2 12L4 8Z" fill="currentColor" opacity="0.5" />
                  <path d="M60 8L62 12L58 12L60 8Z" fill="currentColor" opacity="0.5" />
                </svg>
              </div>
              
              <div className="card-info">
                <h3>Filmes e Séries</h3>
                <p>Catálogo completo sob demanda</p>
                <ul className="card-features">
                  <li>🎬 +500.000 títulos</li>
                  <li>🌟 Lançamentos</li>
                  <li>📚 Todas as categorias</li>
                </ul>
              </div>
              
              <div className="card-action">
                <span>Explorar catálogo</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </div>
            </div>
            
            <div className="card-glow" />
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="home-footer">
        <p>© 2026 TV Ligada • Entretenimento em todos os seus dispositivos</p>
        <div className="footer-links">
          <span>Feito com ❤️</span>
        </div>
      </footer>
    </div>
  );
}
