import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  // The vendored emscripten factory locates xatlas.wasm via the hashed asset URL.
  assetsInclude: ['**/*.wasm'],
});
