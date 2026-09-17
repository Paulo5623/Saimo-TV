/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Proxy de streaming fora da Cloudflare; vazio usa a própria origem. */
  readonly VITE_PROXY_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
