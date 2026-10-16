# handwired (vendored)

These files are copies from [handwired](https://github.com/chenglou/handwired), by Cheng Lou, under the MIT license (`LICENSE`). Do not change them here.

Source: https://github.com/chenglou/handwired
Commit: `4ea7fcb27ebe93acf49b9f29a93e162b975bad46`

| File | Used by |
| --- | --- |
| `src/runtime/numeric-ui-core.ts` | `src/driver/circuit.ts`, `src/net/stage-a-circuit.ts` (`Circuit`, `Wire`) |
| `src/json-search/emit.ts` | `src/gpu/driver-kernel.ts` (the WGSL row writer) |

To copy the files again from a different commit:

```sh
pnpm vendor:handwired <commit>
```

Then run all the checks again. The network's output must stay identical to shiki.
