import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setupTests.js',
    globals: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5060',
        changeOrigin: true,
      },
    },
  },
})
