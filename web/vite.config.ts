import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Media Sommelier web app. Dev server on 5180; /api is proxied to the
// src/server2 API server on 4178 so the React app and the engine-backed
// API speak through one origin in development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4178',
        changeOrigin: true,
      },
    },
  },
});
