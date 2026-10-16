import {defineConfig} from 'vite'

// The demo page at /demo/. Vite serves the project root. The build writes dist/demo/index.html, with relative
// paths, so dist/ can go on any static host and at any path.
export default defineConfig({
  base: './',
  server: {open: '/demo/'},
  build: {target: 'esnext', rolldownOptions: {input: 'demo/index.html'}},
})
