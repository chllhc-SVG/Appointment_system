import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = 'http://localhost:4020';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});