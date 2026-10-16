// Writes fixtures/minified/{lodash,react.development,react-dom.development}.min.js: the fixtures minified by rolldown,
// which vite brings. Usage: node scripts/minify-fixtures.ts
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'

// rolldown is vite's dependency, not this package's, so it is found from vite's directory.
const fromVite = createRequire(createRequire(import.meta.url).resolve('vite'))
const {build} = await import(pathToFileURL(fromVite.resolve('rolldown')).href)
for (const name of ['lodash', 'react.development', 'react-dom.development']) {
  await build({input: `fixtures/${name}.js`, write: true, logLevel: 'silent', output: {file: `fixtures/minified/${name}.min.js`, format: 'iife', minify: true, name: 'x'}})
}
