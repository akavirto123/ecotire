import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // caminhos relativos: o app funciona na raiz (Vercel) e em subpasta (GitHub Pages)
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true },
});
