import {defineConfig} from 'vite'

// The demo page at /demo/. Vite serves the project root.
export default defineConfig({
  server: {open: '/demo/'},
  build: {target: 'esnext'},
})
