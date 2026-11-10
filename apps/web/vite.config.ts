import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app talks to the API over REST. In development we proxy /api
// to the NestJS server so the browser never hits CORS and there is a single
// origin in production behind a reverse proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
