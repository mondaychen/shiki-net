import {defineConfig} from 'vite'

// The demo page at /demo/. Vite serves the project root, and the sibling handwired checkout that src/ imports.
export default defineConfig({
  server: {fs: {allow: ['..']}, open: '/demo/'},
  build: {target: 'esnext'},
})
