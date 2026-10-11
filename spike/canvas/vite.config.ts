import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5273, strictPort: true },
  preview: { port: 5273, strictPort: true },
  build: { target: 'es2020', sourcemap: false },
});
