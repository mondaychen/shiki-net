# Lessons

This document records what the project taught us: facts about shiki, vscode-textmate and Oniguruma that the network had to copy, the design decisions and the measurements behind them, the bugs and how the checks found them, and the WebGPU problems. Each section is independent.

## 1. What to copy: the target and its edges

- **Target `codeToTokens`, not `codeToHast`.** The HAST is a function of the tokens. Whitespace merging (`mergeWhitespaceTokens`) happens only in `codeToHast`, so `codeToTokens(...).tokens` is exactly `tokenizeLine2` plus a color lookup.
- **shiki skips empty lines.** An empty line gives `[]`, and shiki does not call `tokenizeLine2` for it. So the grammar state does not change on an empty line, and `isFirstLine` stays true until the first line that is not empty. The network must get only the lines that are not empty.
- **The time limit can make shiki's own output change.** `tokenizeTimeLimit` is 500 ms per line by default. When a line takes longer, the rest of the line becomes one token. Check that no line of a test file comes near the limit. Here, the longest line is 7,113 characters and takes much less.
- **Every token has the balanced-bracket bit.** shiki passes `balancedBracketSelectors: ['*']`, which always matches, so every token's metadata has bit 10 set. Tokens merge only when their whole metadata is equal, so this bit must be correct too.
- **`LineTokens.getBinaryResult` changes the end of the line.** It removes a last token that starts at the `\n`. When no token is left, it adds one token at 0 with the stack's scopes.

## 2. Oniguruma semantics as automata

- **Priority is the order of epsilon edges.** Backtracking tries alternatives in a fixed order. Make a Thompson automaton whose epsilon edges keep that order. The first accepting path in that order is Oniguruma's match.
- **"Can the rest match" bits plus a priority walk give the backtracking result.** For patterns without backreferences, the result of a search from (node, position) does not depend on the path to it. So `ok[c](p)` is a bit computed backward. A walk that takes, at each step, the first item whose guards hold and whose target is ok gives Oniguruma's path and captures. The dual engine (`scripts/check-engine.ts`) proved this on 396,351 scanner calls.
- **Empty loop iterations need the loop context.** Oniguruma ends a loop when an iteration read nothing. In a closure, a loop whose iteration started inside the closure has read nothing when its end comes again, so the path leaves the loop. A loop that started before the closure has read at least one code unit, so its end goes back.
- **An atomic group that matches nothing continues as an epsilon path.** The jsdoc pattern for `[name=default]` has `(?>...)` inside `(...)*`. When the group matches nothing, the loop's empty check applies. So each atomic item needs the loop context of its closure. Without it, the reference matcher recursed forever.
- **Oniguruma reports captures inside a positive lookahead, and vscode-textmate uses them.** A capture that starts at or before the end of the match produces tokens, even past the match. Begin patterns that are only a lookahead, e.g. `(?=...(export)...(const)...)`, depend on this. The walk must also walk the lookahead's first path. Lookaheads are atomic, so that path is fixed.
- **Get the named sets from Oniguruma itself.** The Unicode meanings of `\w`, `\s`, `[:alnum:]` and `\p{upper}` differ between engines. A search over all code points with the shiki WASM build took about 1 s and removed the question. 96 classes cover all sets of the JavaScript grammar.
- **Small facts that matter:**
  - `^` does not match at the end of the string after the final `\n`.
  - `$` matches before a `\n` and at the end.
  - vscode-textmate rewrites `\z` to `$(?!\n)(?<!\n)`.
  - vscode-textmate turns `\A` and `\G` into `￿` when they are not allowed, so each scanner has four variants.
  - In Oniguruma, `[^]*\[\s]` is one negated class.
- **Deduplicate lookarounds.** The 673 lookaheads of the grammar are 192 distinct automata, and the 564 lookbehinds are 42. Most of the network's 19,765 nodes are lookahead internals (15,069).

## 3. vscode-textmate details the driver must copy

- **`beforePush.hasSameRuleAs(stack)` goes in one direction only.** It walks down from the frame before the push while frames entered at the current position, and it looks for the new rule. Our first version reversed the roles. That error made lodash line 258 stop early, and the reference-driver check found it.
- **`reset()` changes old frames at each line.** At the start of a line, every frame's `enterPos` and `anchorPos` become -1. An append-only tape cannot change frames, so a frame records its line instead. Both positions count only on that line.
- **The line's anchor comes from the top frame.** `_checkWhileConditions` sets `anchorPosition = stack.beginRuleCapturedEOL ? 0 : -1` even for grammars without `while` rules.
- **A match rule pushes and pops a frame.** Its captures use the name scopes of that pushed frame. When it reads nothing, `safePop` also removes the frame below, except the root, and that change continues to the next line.
- **No capture rule and a capture rule without a name are different.** A rule without a name still produces tokens up to the capture's start. Only groups below `min(captures.length, groups)` count.
- **An end pattern with a backreference is a family of rules.** `(\3)|(?=$|\*/)` gets the text of a begin group that holds `"` or `'`. So the rule has one end variant per value, and the class of the captured code point selects it.
- **The root frame uses the root scope list as is.** Do not push the root scope name again. Our first reference driver pushed `source.js` twice. Its output was the same because the theme ignored the extra scope, but its state did not match vscode-textmate's.

## 4. The theme is a small state machine

A push of a scope depends on the token attributes, and on which theme selectors with parent scopes match the path. For each parent selector, keep a bit for each suffix of its parent list, nearest scope first. The recurrence on a push is `m'(i) = m(i) OR (x matches parents[i] AND m(i + 1))`. vscode-textmate's own `AttributedScopeStack` computes the attributes. For github-dark this gives 279 states over 294 scope names, and only 78 distinct metadata values. One table read does a push.

## 5. The network

- **Bits and small integers make float32 exact.** AND of n bits is `relu(Σ - (n - 1))`. OR is `1 - relu(1 - Σ)`. `[d >= 0]` is `relu(d + 1) - relu(d)` for an integer d. A select is `off + (on - off) × bit` as one ReGLU product. The first matching pattern of a list is `Σ_j relu(1 - Σ_{i<j} m_i)`, the count of leading zeros.
- **The driver is a gated mixture of experts.** The modes exclude each other, so the step is `Σ_m [mode = m] × expert_m`. Evaluating only the active expert gives the same value. Each expert stays small: 36 to 411 live operations.
- **Windows keep the circuits small.** A step reads big memories only at positions that registers name: the record row at `q`, the frame at `top` and the frame at `guardPtr`. The host fills these as source cells before each step, in the same way as handwired's host loop. The driver tables are then the only large source cells.
- **Reuse handwired's tools.** `compileTensorProgram` and the row writer in `json-search/emit.ts` turned the experts into WGSL with no changes. Index reads over runs of cells become buffer reads. All values are integers below 2^24, so Metal's fused multiply-add and changed order of addition cannot change a result.
- **An integer that a step reads at a different position can become bits.** The atomic group's first end is an integer, and the group reads the record at that end. A recurrent step can read only p + 1. So stage A's step circuit keeps two bits for each body node: E, the body can end from the node, and A, the items after the group hold at the first end. Both follow the first item in priority order, as the end does. At an accept, A is the OR of the items after the group at p + 1. The check against the dense CPU evaluation, which keeps the integer, found 0 differences.
- **A lockstep check is stricter than an output check.** The circuit check compares every register at every step. It found a difference in `wChunk` that changed no token, because the register is reset before the next read. The fix made the two machines equal register for register.

## 6. Parallel lines: from rounds to exactness

- **One GPU thread is too slow for a sequential driver.** Measured on an M2 Pro: a dependent load takes 0.13 to 0.3 µs, and a dependent ALU operation about 30 ns. 3.5 million micro-steps would take minutes.
- **A line depends on its start only through the frames that it reads.** These are the top frame, and each frame that a pop below the start reveals. Frames from earlier lines have no live positions. So the rule is: a run is valid for a start when the start agrees in the frames that the run read, not in its whole prefix. With the rule on the whole prefix, the depth went up by one frame per round.
- **The stop rule makes the chain exact.** Rounds stop only when a walk finds every line valid. Line 0 starts from the root, and a valid line's end is exact when its start is exact. Each round, the first invalid line has an exact start, so it becomes valid and the rounds stop.
- **Bad predictions cost rounds, not correctness.** Measured rounds:

  | Change | lodash | three.min.js |
  | --- | --- | --- |
  | Every line from the root | 1,341 | 457 |
  | One candidate prefix per round | 110 | not measured |
  | A run that popped past its predicted prefix "collapsed" the predicted stack to the root | 1,042 | 280 |
  | That run means "the whole prefix popped" | 344 | 268 |
  | Validity by the frames read, jobs from the full predicted stack | 84 | 64 |

- **A run that falls off its start must count as invalid.** A run that pops past the bottom of a short predicted stack has read a frame that its start does not have. The first version continued from a dummy frame and accepted the result. That error changed lodash line 1548, and the end-to-end check found it.
- **Data shapes the method.** In lodash, 84% of lines read only the top frame, and there are 15 distinct top frames. three.min.js is one large expression in 966 lines. Its lines read up to 16 frames deep, and it has 247 distinct start stacks.

## 7. WebGPU and the platform

- **macOS stops long command buffers.** Dawn reports "Impacting Interactivity", and the device is lost. One long line already takes 0.5 s. So stage A runs in dispatches of 192 steps, and each line's state waits in a buffer between dispatches.
- **The `webgpu` package (0.6.2) has these problems:**
  - The process crashes when the garbage collector frees the Dawn instance or the adapter. Keep a reference to them.
  - `createComputePipelineAsync` crashes. Use the synchronous call.
  - Calls to `destroy()` caused later dispatches to fail without an error. Reuse buffers instead.
  - A dispatch that fails, e.g. because there is not enough memory for a second 445 MB buffer, gives no error message: the run only finishes in 1 ms. Look for impossible times.
- **WGSL:**
  - A barrier must be in uniform control flow. A value from a storage buffer is not uniform, so get it through `workgroupUniformLoad`.
  - `target` is a reserved word.
  - A private array with a dynamic index goes to slow thread memory. Our attempt to batch loads that way made phase 1 slower.
- **Workgroup memory limits stage A's occupancy.** 256 threads per workgroup is best for both files. But with 16 KB of workgroup memory per line, 8 KB more made lodash 37% slower. Section 10 tells how the memory became smaller, and what happened next.
- **Divergence costs about 2×.** When jobs of different modes share a SIMD group, a driver step goes from 3.3 µs to 7.6 µs.
- **Counts before code.** Measuring sizes first (nodes, items, follow-list lengths, distinct mark sets, read depths) decided each layout. Some examples: 92% of follow lists have at most 4 items, so the walk weighs 4 items per step. 7,270 walk items have only 139 distinct mark sets, so 32 mark tables became small hot tables.

## 8. How the checks found the bugs

Each stage has an oracle that does not share its code:

| Check | What it found |
| --- | --- |
| Dual engine against Oniguruma | Captures inside lookaheads; the atomic group's endless recursion |
| Reference driver against `tokenizeLine2` | The reversed `hasSameRuleAs` |
| Dense stage A against the lazy matcher | Nothing; it confirmed the schedule on all 19,765 nodes |
| GPU stage A against the CPU | Nothing; it confirmed each kernel change, and it caught the silent dispatch failures |
| Circuits against `lineStep`, in lockstep | Constants confused with wires (below); the `wChunk` difference |
| Stage A's step circuits against the dense CPU | Nothing. A test with two wrong weights in the atomic group gave 7,187 differences, so the check can find an error |
| Stitch against `codeToTokens` | The run that fell off its start; the collapsed prediction (in round counts) |

The confusion of constants with wires came from handwired's `Wire` type. A wire is a number at runtime, so a helper that took "a number or a wire" took wires as constants, and the circuit returned wire indices as values. `selk` now takes two constants, and `selwk` takes a wire and a constant.

## 9. Where the time goes

The first version took 1.8 s for lodash and 4.1 s for three.min.js. Section 10 tells how they became 0.44 s and 0.98 s (shiki: about 0.48 s and 5.4 s). Now:

| | lodash | three.min.js | react-dom.development.js |
| --- | --- | --- | --- |
| Stage A | 0.23 s | 0.61 s | 0.66 s |
| Driver rounds and the token run | 0.13 s | 0.33 s | 0.37 s |
| Host stitch | 0.06 s | 0.01 s | 0.08 s |

- lodash's stage A is limited by throughput: 16K lines fill the GPU.
- three.min.js's stage A is limited by its longest line (7,114 code points) at the end, when the other lines are complete.
- react-dom.development.js's driver has 347 rounds. [ideas.md](ideas.md) (idea 17) tells why.
- three.min.js's driver has 64 rounds. A late round runs a line of about 500 code points, about 1,500 steps at about 2 µs per step. The first three rounds and the token run each wait for the longest line (about 9,000 steps).

[ideas.md](ideas.md) has the ideas that we did not try.

## 10. Performance work

The changes below took the network from 2.1 s to 0.44 s on lodash, and from 4.2 s to 0.98 s on three.min.js. Every change kept the output identical, and every check in the README passed after it.

### How to measure

- **The machine is noisy.** The same run took from 154 ms to 191 ms, because other processes used the CPU and the GPU. So compare variants in alternation, in separate processes, several times, and compare the minimums. A comparison of single runs gave a wrong decision once (the unroll below).
- **Latency and throughput are different.** `time:stage-a` measures one line, alone on the GPU. A whole file measures throughput. Some changes made one of them better and the other worse. Unrolling phase 1 by two made one line 5% faster and lodash 15% to 35% slower, probably because it used more registers. Measure both, and decide with the whole files.
- **Remove a phase to find its cost.** The `skip` set of `createStageA` removes the work of a phase but keeps its barriers. On a whole file, this shows which phase uses the GPU's throughput. On one line, it shows which phase is on the critical path. The two lists were different.

### Stage A

- **Pack the bits that the threads only read.** The ok bits, guard bits, lookahead bits and main start bits went from one word per bit to 32 bits per word, and a third copy of the ok bits went away. Workgroup memory went from 16 KB to about 6.5 KB, and lodash became about 10% faster. After this, 8 KB more had no effect: the memory no longer limited occupancy.
- **Contention on a packed word was not the problem.** Many threads clear guard bits in the same few words with `atomicAnd`. A word per guard bit made lodash slower (370 ms against 288 ms), probably because of the memory and the loop that packs the bits for the record.
- **Push from the bits that hold, not pull over all candidates.** About 1% of the nodes hold at a position (about 213 of 19,765).
  - Phase 1 now starts from each node that holds at p + 1, and sets its predecessors in the class at p. A table per class and per target gives the predecessors and their guard lists, so no member check is necessary. Phase 1 looked at about 4,160 members per position; now it looks at about 500 edges and 470 accepting items. Stage A on lodash went from 589 ms to 301 ms.
  - Each list's first matching pattern now starts from the main start bits that hold (about 17 per position), and `atomicMin`s their places in the lists (about 80). The chunks of 16 patterns read 361 × 24 words per position. Stage A on lodash went from 395 ms to 301 ms.
  - The same idea did not work for the lookahead start items (1,011) and the main start items (907): 358 ms against 302 ms. Their loops are short and regular, and the push pass is not.
  - It also did not work for the lookahead predicates of level 2 (370 of its 510 entries). A thread for each lookahead that holds (about 14 of 192) set or cleared the bits of its guard lists, and a step after the level put the bits together. Level 2 then had 152 entries, but stage A was 10% to 15% slower on lodash and react-dom (8 and 6 alternating runs). The extra barrier and the irregular loops cost more than the entries.
- **Remove the loads that depend on each other.**
  - Phase 1 read a member's node, then its items at that node. Now the items are in member order, so the two loads are independent and neighbor threads read neighbor words.
  - The `||` chain over four items made branches. Bitwise operations without branches made one line 15% faster.
  - The atomic group's `bodyIndex` searched 20 global words for each item, in one thread. A table, and then constants in the shader code, made one line 20% faster.
  - In A0, a guard list's anchors depend only on 7 bits of context. A table of guard bits per context replaced a loop over predicates.
- **A long line needs latency, not throughput.** The state of each line waits in a buffer between dispatches. So the last dispatches, where at most 8 lines are still running, use a second pipeline with 1024 threads per workgroup. One line then takes 26 µs per position, not 38 µs. Stage A on three.min.js went from about 650 ms to 540 ms. lodash does not change.
- **Check only the items that can hold in the class at p.** A char node holds at p only when the class at p is in its set. So an item can hold only when its target is a member of the class, accepts, or is the atomic node. Lists per class of the lookahead start items (85 of 1,011 for each class, on average), of the main start items (185 of 907) and of A0's lookbehind start items made stage A on lodash about 20% faster, and on react-dom about 30% faster.
- **No branches in the atomic group.** One thread runs the atomic group, and its checks stopped at the first match, so its loads came one after the other. Selects without branches let all its loads start together. The gain was a few percent, near the noise.

### The driver

- **Speculation rounds do not need tokens.** The captures, the event before them, the capture slots and the token registers change no frame. A second set of experts, without them, runs the rounds. Only the final run makes tokens. The walk went from 413 to 204 live operations, and the search from 139 to 75. A step of a late round went from about 4 µs to 2.1 µs.
- **Give a job its own SIMD group when there are few jobs.** In a late round, the few jobs were in one SIMD group, and jobs in different modes waited for each other. With fewer than 4,096 jobs, each job now has 32 threads, and 31 of them return. The driver for three.min.js went from 1.43 s to 0.66 s.
- **The count of operations matters more than the length of the chain.** Tables by scanner and by pattern made the search's chain of reads shorter, and a walk list is now named by its first item. But a walk that read all four candidates' values and then picked one, to make the chain shorter, was 25% slower than a walk that reads the chosen item's values after the pick.
- **One read for two guard bits.** The walk read a guard bit with and without `\G`, then selected one. The cell layout now pads the guard bits to whole words, as the record does, so one read at `guard + G × stride` gives the bit.

### The host

- **Interned keys as numbers.** The stitch made a string for each frame of each prefix of each job. A number made of the fields replaced the string, and the job prefixes are now key ids. The stitch on lodash went from 320 ms to 130 ms.
- **Jump over the lines that do not change.** A line that got no run in a round, and whose start is the same stack object, keeps its choice and its end. So do the lines after it, up to the next line that got a run. The walk jumps over them. The stitch on lodash went from 130 ms to 60 ms, with the same rounds.
