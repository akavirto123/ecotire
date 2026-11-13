import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // caminhos relativos: o app funciona na raiz (Vercel) e em subpasta (GitHub Pages)
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true },
  build: {
    // bibliotecas grandes em arquivos separados: o navegador guarda em cache e só baixa de novo quando mudam
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'maplibre', test: /node_modules[\\/]maplibre-gl/ },
            { name: 'three', test: /node_modules[\\/]three/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
