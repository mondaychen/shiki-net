# shiki-net

shiki-net is shiki's JavaScript tokenizer as a handwired neural network. The network runs on the GPU. Its output is identical to shiki's `codeToTokens`.

Demo: https://mengdi.dev/shiki-net/ (a browser with WebGPU, such as a recent Chrome)

The network follows [handwired](https://github.com/chenglou/handwired): its operations are weighted sums, ReLU products (ReGLU) and table reads over float32 values. A compiler writes all weights from shiki's grammar and theme. There is no training. All values are bits or integers below 2^24, so each float32 operation is exact.

## Results

The test compares the network's `ThemedToken[][]` with shiki's `codeToTokens(code, {lang: 'javascript', theme: 'github-dark'}).tokens`. The comparison is `isDeepStrictEqual` on the full arrays.

| File | Lines | Tokens | Result | Network (GPU) | shiki (CPU) |
| --- | --- | --- | --- | --- | --- |
| [lodash@4.17.21](https://unpkg.com/lodash@4.17.21/lodash.js) | 17,210 | 59,873 | identical | 0.53 s | 0.5 s |
| [three@0.97.0 min](https://unpkg.com/three@0.97.0/build/three.min.js) | 967 | 116,082 | identical | 0.97 s | 5.2 s |
| [react@18.3.1 development](https://unpkg.com/react@18.3.1/umd/react.development.js) | 3,344 | 11,640 | identical | 0.16 s | 0.15 s |
| [react-dom@18.3.1 development](https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js) | 29,925 | 102,423 | identical | 1.6 s | 1.4 s |

Times are from an Apple M2 Pro (19-core GPU, 16 GB), Node 24, WebGPU through the `webgpu` package (Dawn on Metal). The network time is the best of three calls. It includes stage A, all driver rounds, the host's stitch and the decode. It does not include the one-time compile of the weights and the shaders. Other work on the machine changes the times by up to about 30%.

## Run

You need Node 24 or later, pnpm, and a GPU that WebGPU can use. The two handwired files that the code imports are in `vendor/handwired` (see its README).

```sh
pnpm install
pnpm test          # the network on the GPU against shiki, on the four fixtures
pnpm typecheck     # tsc, with handwired's imported code included
```

### The demo page

```sh
pnpm demo          # Vite opens http://localhost:5173/demo/ in your browser
pnpm demo:build    # writes the page to dist/, for a static host; the page is dist/demo/index.html
```

At each push to `main`, `.github/workflows/pages.yml` builds the page and puts it on GitHub Pages.

Use a recent Chrome, or another browser with WebGPU. The page compiles the weights and shaders in about 1.5 s. Then it highlights the code in the text box on your GPU, runs shiki on the same code and compares the two outputs. The buttons load the sample and the two fixtures. `pnpm check:demo` runs the page in a headless Chrome and gives the page's result for the sample and the two fixtures. `pnpm check:demo --built` does the same for the page in `dist/`.

Each stage also has its own check. The table in [How the result is verified](#how-the-result-is-verified) gives the commands.

## How it works

```txt
code ─► lines ─► stage A: the regex network ─► one record per position (GPU)
                                │
                                ▼
          stage B: the driver network, one thread per (line, start) ◄─┐  (GPU)
                                │                                     │
                                ▼                                     │
          host: stitch lines into one chain ── wrong predictions ─────┘
                                │
                                ▼
          decode: ThemedToken[][] (string slices and colors only)
```

### The weights

`src/compile/tables.ts` reads shiki's compiled grammar and theme. It does not parse the grammar itself:

- **Scanners.** For each rule that can be on the stack, `rule.compileAG(grammar, endRule, allowA, allowG)` gives the list of patterns that vscode-textmate searches with. There are 732 scanner variants and 149 distinct pattern lists.
- **Patterns.** `src/regex/nfa.ts` turns each Oniguruma pattern into an automaton with ordered epsilon edges. The order of the edges is the order in which Oniguruma's backtracking tries alternatives. Anchors, word boundaries and lookarounds become predicates of a position. A lookaround body is an automaton of its own.
- **Closures.** `src/regex/closure.ts` gives, for each node, the next char nodes in priority order. Each item records the predicates that it needs (a "guard list") and the capture marks that it sets. The closures also apply Oniguruma's rule for empty loop iterations.
- **Code point classes.** Oniguruma itself (the WASM build that shiki uses) gives the members of `\w`, `\s`, `[:alnum:]` and the other named sets (`scripts/extract-named-sets.ts`). All sets of the grammar divide the code points into 96 classes.
- **Theme.** The theme becomes a state machine over scope pushes. A state is the token attributes and, for each parent selector of the theme, the suffixes that the scope path matches. vscode-textmate's own `AttributedScopeStack` computes the attributes. There are 279 states and 294 scope names.

### Stage A: the regex network

Stage A finds, for each position of a line, which pattern of each scanner matches first at that position. Lines are independent, so the GPU runs one workgroup per line (`src/gpu/stage-a-kernel.ts`). The kernel computes the recurrence below from the bits that hold: at a position, about 1% of the nodes hold. For example, each node that holds at p + 1 sets its predecessors that are members of the class at p.

The main recurrence goes backward over the positions of the line. For each of the 19,765 automaton nodes:

```txt
ok[c](p) = member(c, class(p)) AND OR over follow items i of c: (guard_i(p + 1) AND ok[target_i](p + 1))
```

`ok[c](p)` is 1 when the rest of the pattern can match from node c at position p. With bits, AND of n inputs is `relu(Σ - (n - 1))` and OR is `1 - relu(1 - Σ)`. So each node is one ReLU unit with 0/1 weights, and stage A is a sparse recurrent network. A forward pass first gives the lookbehind bits. Then, at each position and in dependency order, stage A computes:

- the guard lists;
- the lookahead bits;
- one atomic group;
- each pattern's start bit;
- each scanner's first matching pattern: `first = Σ_j relu(1 - Σ_{i<j} m_i)`, the number of leading zeros.

The record of a position holds the ok bits that a walk can read, the guard bits and the first pattern of each scanner. It is 200 words per position.

### Stage B: the driver network

The driver is vscode-textmate's tokenizer loop (`_tokenizeString`, `handleCaptures`, `LineTokens`). Its step is a set of handwired `Circuit`s, one per mode (`src/driver/circuit.ts`). The modes are: search, walk, pre, capture, post, guard and two line-end steps.

The step is a mixture of experts gated by the exact one-hot of the mode. Exactly one gate is 1, so the kernel evaluates only that expert. The experts use exact integer constructions:

- `[d >= 0]` is `relu(d + 1) - relu(d)`;
- `[x = c]` is `relu(1 - relu(x - c) - relu(c - x))`;
- a select is `off + (on - off) × bit`, as one ReGLU product;
- a table lookup is a handwired index read.

A step reads source cells: registers, tables, and windows. Before each step, the host fills the windows from registers: the record row at `q`, the class at `q`, the frame at `top` and the frame at `guardPtr`. A step writes at most one token and one frame. The stack is an append-only tape of frames, like vscode-textmate's immutable `StateStack`.

handwired compiles each expert (`compileTensorProgram`). handwired's row writer (`json-search/emit.ts`) writes it as WGSL statements. `src/gpu/driver-kernel.ts` puts each expert in one case of a `switch` on the mode. It maps cells to registers and index reads to buffer reads.

There are two sets of experts. The set with tokens runs the final run of each line. The set without tokens runs the speculation rounds. It has no captures, no event before the captures, no capture slots and no token registers, because they change no frame. Its walk and search have about 40% fewer operations.

### The host: lines in parallel

A line's run depends on its start stack only through the frames that it reads: the top frame, and the frames that its pops reveal. Frames from earlier lines have no live positions, because vscode-textmate resets them. So lines can run in parallel from predicted starts (`stitchLines` in `src/driver/line-driver.ts`):

1. Run every line from a predicted start.
2. Walk the lines in order. A line is valid when its start agrees with its prediction in every frame that it read. A valid line's end is the next line's start.
3. Run each invalid line again from its new predicted start. Repeat until a walk finds every line valid.

The final chain is exact by induction: line 0 starts from the root, and a valid line's end is exact when its start is exact. Each round, the first invalid line has an exact start. Thus it is valid after its run, and the rounds stop. lodash needs 84 rounds and three.min.js needs 64. Most rounds run few lines. The host only compares frame keys and joins stacks. It does no tokenizing.

### Decode

`src/decode.ts` turns each line's tokens, `[start position, metadata id]`, into shiki's `ThemedToken`. It slices the strings, converts positions to UTF-16 offsets and looks up the colors. This is the loop in shiki's `_tokenizeWithTheme`.

## How the result is verified

Each check compares two independent implementations. `pnpm test` runs on the four fixtures. The other checks run on lodash and three.min.js unless the table says otherwise. Each script also takes file paths.

| Command | Compares | Result |
| --- | --- | --- |
| `pnpm check:engine` | the reference matcher (`src/regex/reference-engine.ts`) with Oniguruma, on every scanner call that shiki makes | 396k calls, 0 differences |
| `pnpm check:driver` | the reference driver with the reference matcher, against vscode-textmate's `tokenizeLine2` | all lines identical |
| `pnpm check:stage-a` | stage A on the CPU, dense, with the reference matcher, every bit (a sample of lines) | 0 differences |
| `pnpm check:stage-a-gpu` | stage A on the GPU with stage A on the CPU, every record bit (a sample of lines) | 0 differences |
| `pnpm check:circuit` | the expert circuits, run by handwired's evaluator, with the JS line driver, every register and write at every step | 0 mismatches |
| `pnpm check:driver-gpu` | the driver kernel with the JS line driver, every line from its exact start | 0 differences |
| `pnpm check:lines` | the host's stitch with the JS line driver, against `codeToTokens` | identical |
| `pnpm test` | the full network on the GPU, against `codeToTokens` | identical |
| `pnpm check:demo` | the demo page in a headless Chrome, which compares the network with shiki in the browser | identical |

## Grammar features and how the network covers them

- **Captures inside a lookahead.** Oniguruma reports these captures, and vscode-textmate uses them when they start at or before the end of the match. A walk also walks the lookahead's first path in priority order.
- **An atomic group inside a loop.** The jsdoc pattern for `[name=default]` has `(?>...)` inside `(...)*`, and the group can match nothing. Then Oniguruma ends the loop. Each atomic item therefore records its loop context. Stage A keeps the first end of the group as an integer.
- **An end pattern with a backreference.** `(\3)|(?=$|\*/)` refers to a group that captures `"` or `'`. The rule has one end variant for each value. The class of the captured code point selects the variant.
- **`\G` and `\A`.** vscode-textmate compiles each scanner in four variants. Stage A computes the first pattern both with and without `\G` at the position.
- **The endless-loop guards.** The checks after a pop, a push (`hasSameRuleAs`) and a match without progress are part of the driver.
- **Empty lines.** shiki does not tokenize empty lines and does not change the stack for them. The network gets only the lines that are not empty.

## Limits

- The compiler accepts grammars with the features above. It stops with an error for other features: captures with patterns, `while` rules, injections, names with `$n`, more than one atomic group, or a backreference to a group that does not capture one code point of a small set.
- A line must be shorter than 65,536 code points. A line may leave at most 32 frames on top of its start. Captures may nest at most 8 deep. The kernel reports a status when a run goes past a limit, and the host stops with an error.
- macOS stops a GPU command buffer that runs too long. So stage A runs in dispatches of 192 steps, and keeps the state of each line in a buffer between dispatches.
- The `webgpu` package (0.6.2) crashes when the garbage collector frees the Dawn instance, and in `createComputePipelineAsync`. `src/gpu/device.ts` works around both.

## Performance

Stage A takes about two thirds of the time: 0.36 s for lodash and 0.63 s for three.min.js. A workgroup does one position at a time, with about 10 barriers per position. lodash's 16K lines fill the GPU, so its stage A is limited by throughput. three.min.js's stage A ends with its longest line alone, at about 26 µs per position. The driver takes 0.12 s for lodash and 0.32 s for three.min.js. There, a late round lasts as long as its longest line, about 1,500 steps at about 2 µs per step.

[docs/lessons.md](docs/lessons.md) (section 10) tells what made the network four times faster than its first version, and what did not work.

`pnpm time:stage-a` and `pnpm time:driver` measure the two kernels.

## Files

| Path | Contents |
| --- | --- |
| `src/regex/` | Oniguruma patterns as automata (`nfa.ts`), closures in priority order (`closure.ts`), code point classes (`charsets.ts`), the reference matcher and a shiki `RegexEngine` made from it (`reference-engine.ts`, `engine.ts`) |
| `src/compile/tables.ts` | The grammar's rules and scanners, and the theme as a state machine |
| `src/net/` | Stage A: its schedule and a dense CPU evaluation (`stage-a.ts`), its GPU layout (`layout.ts`) |
| `src/driver/` | The reference driver (`reference-driver.ts`), the line driver and the host's stitch (`line-driver.ts`), the driver's tables (`driver-tables.ts`), the expert circuits (`circuit.ts`) |
| `src/gpu/` | The WebGPU device, the stage A kernel and the driver kernel |
| `src/highlighter.ts` | `createGpuHighlighter(device)`: the whole pipeline |
| `demo/` | The demo page |
| `docs/lessons.md` | What the project taught us: semantics to copy, design decisions with their measurements, bugs, and WebGPU problems |
| `src/decode.ts` | The network's output as shiki's tokens |
| `scripts/` | The checks and the timers |
| `fixtures/` | The four test files: lodash, three.min.js, and React's two development builds |
| `generated/named-sets.json` | The members of Oniguruma's named sets |
