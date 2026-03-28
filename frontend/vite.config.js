import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:5000',
        ws: true,
        secure: false
      }
    }
  }
})
