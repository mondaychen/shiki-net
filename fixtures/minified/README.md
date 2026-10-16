# Minified fixtures

Minified code has long lines, so these files test the lite version's chunks and segments (`pnpm check:lite`).

| File | Source |
| --- | --- |
| `lodash.min.js`, `react.development.min.js`, `react-dom.development.min.js` | The fixtures of the same names, minified by rolldown 1.2.14 (`node scripts/minify-fixtures.ts`) |
| `oniguruma-parser.min.js` | `dist/oniguruma-parser.min.js` of oniguruma-parser 0.12.2 (MIT, `oniguruma-parser.LICENSE`) |
| `oniguruma-to-es.min.js` | `dist/index.min.js` of oniguruma-to-es 4.3.6 (MIT, `oniguruma-to-es.LICENSE`) |

shiki's `codeToTokens` stops a line after 500 ms by default (`tokenizeTimeLimit`), and these lines take longer. So the checks compare with shiki without that limit.
