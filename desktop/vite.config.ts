import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * A mesma tela do site, empacotada para a janela do aplicativo.
 *
 * A raiz continua sendo a do site — `index.html` e `src/` são os mesmos
 * arquivos, não uma cópia. É isso que garante que uma correção feita para o
 * site chegue ao Windows na compilação seguinte, em vez de virar duas telas que
 * divergem com o tempo.
 *
 * O que muda aqui é o que só faz sentido numa janela: nada de `/api/proxy` do
 * servidor de desenvolvimento, porque quem responde é o proxy em Rust, e os
 * caminhos saem relativos, porque o `tauri://` não tem raiz de site.
 */
const raiz = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  root: raiz,
  base: './',
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    // A janela roda num WebView2 atual, então não há navegador antigo para
    // acomodar: alvo moderno sai menor e sem transpilação desnecessária.
    target: 'chrome120',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-dom') || id.includes('react-router')) return 'vendor-react'
            if (id.includes('hls.js')) return 'vendor-hls'
            if (id.includes('shaka-player')) return 'vendor-shaka'
            return 'vendor'
          }
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
})
