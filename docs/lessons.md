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
  | Lines with the same text share their runs | 20 | 64 |
  | The prediction for an invalid line pops only the frames where its run agrees, then pushes what the run pushed | 10 | 14 |

- **A prediction must not use what a run did past the frames that agree.** A run is the same as a run from the new start up to the moment when it reads the first frame that differs. So the line pops all the frames that agree. After that, the run's pops came from frames that the new start does not have. A run from a stack with extra `var` frames popped 6 frames where the true run pops 2, and the error went into every later prediction. With this rule, react-dom.development.js needs 9 rounds, not 347, and 6 when lines with the same text share their runs.
- **A run that falls off its start must count as invalid.** A run that pops past the bottom of a short predicted stack has read a frame that its start does not have. The first version continued from a dummy frame and accepted the result. That error changed lodash line 1548, and the end-to-end check found it.
- **Lines with the same text share their runs.** Without this, the same closer line (`  }`) failed again in each round, because each line kept only its own runs. With one trie of runs for each text, react-dom.development.js went from 347 rounds to 51, and react.development.js from 48 to 7. three.min.js has no lines with the same text, so it does not change. Idea 17 in ideas.md tells why the closers cost rounds.
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

The first version took 1.8 s for lodash and 4.1 s for three.min.js. Section 10 tells how they became 0.28 s and 0.71 s (shiki: about 0.42 s and 4.8 s). Now (the best of all runs for each part; stage A changes by up to 30% between runs on this machine):

| | lodash | three.min.js | react-dom.development.js |
| --- | --- | --- | --- |
| Stage A | 0.18 s | 0.50 s | 0.39 s |
| Driver rounds and the token run | 0.03 s | 0.15 s | 0.06 s |
| Host stitch | 0.03 s | less than 0.01 s | 0.05 s |

- lodash's stage A is limited by throughput: 7.7K distinct lines fill the GPU.
- three.min.js's stage A is limited by its longest line (7,114 code points) at the end, when the other lines are complete.
- The driver needs 10 rounds for lodash, 14 for three.min.js and 6 for react-dom.development.js. Rounds 1 and 2 run every line. On three.min.js, the first three rounds and the token run each wait for the longest line (about 9,000 steps).

[ideas.md](ideas.md) has the ideas that we did not try.

## 10. Performance work

The changes below took the network from 2.1 s to 0.28 s on lodash, and from 4.2 s to 0.71 s on three.min.js. Every change kept the output identical, and every check in the README passed after it.

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
- **Stage A once for each distinct line.** A line's record depends only on its text. lodash's 16K lines are 7.7K distinct texts, with 68% of the code points, and react-dom's are 82%. Stage A now runs once for each text, and a driver job reads the record of its line's text. Stage A went from about 230 ms to 160 ms on lodash, and from about 500 ms to 400 ms on react-dom (best of 4 calls, alternating with the earlier version).
- **No branches in the atomic group.** One thread runs the atomic group, and its checks stopped at the first match, so its loads came one after the other. Selects without branches let all its loads start together. The gain was a few percent, near the noise.

### The driver

- **Speculation rounds do not need tokens.** The captures, the event before them, the capture slots and the token registers change no frame. A second set of experts, without them, runs the rounds. Only the final run makes tokens. The walk went from 413 to 204 live operations, and the search from 139 to 75. A step of a late round went from about 4 µs to 2.1 µs.
- **Give a job its own SIMD group when there are few jobs.** In a late round, the few jobs were in one SIMD group, and jobs in different modes waited for each other. With fewer than 4,096 jobs, each job now has 32 threads, and 31 of them return. The driver for three.min.js went from 1.43 s to 0.66 s.
- **The count of operations matters more than the length of the chain.** Tables by scanner and by pattern made the search's chain of reads shorter, and a walk list is now named by its first item. But a walk that read all four candidates' values and then picked one, to make the chain shorter, was 25% slower than a walk that reads the chosen item's values after the pick.
- **One read for two guard bits.** The walk read a guard bit with and without `\G`, then selected one. The cell layout now pads the guard bits to whole words, as the record does, so one read at `guard + G × stride` gives the bit.

### The host

- **Interned keys as numbers.** The stitch made a string for each frame of each prefix of each job. A number made of the fields replaced the string, and the job prefixes are now key ids. The stitch on lodash went from 320 ms to 130 ms.
- **Lines with the same text share their runs.** Only 47% of lodash's lines are distinct, and 62% of react-dom's. A run depends only on the text, the first-line flag and the frames that it read, so a group of lines with the same text keeps one list of runs. Line runs went from 56K to 31K on lodash and from 72K to 46K on react-dom. The driver went from about 130 ms to 60 ms on lodash, and from about 380 ms to 130 ms on react-dom (best of 4 calls, alternating with the earlier version). The final token run is also one run for each distinct choice.
  - A first version found the runs with a string key for each line and each depth. The stitch on lodash took about 480 ms. Now each group has a trie of its runs, by the frames that each run read.
  - Two lines of a group with the same job in a round get one job. A string key of the prefix for this took most of the stitch's time, because prefixes can be 64 frames deep. Now the stitch compares the prefixes only with the other jobs of the same group in the round, and the stitch on lodash takes about 50 ms, as before.
  - The trie first kept the whole prefix of each job, up to 64 frames. The garbage collector then took most of the host's time. A run that agrees with a start in the frames that it read is valid, so a path needs only the frames that its run read. The best prediction does not change, because a run that agrees deeper than its read depth is valid.
- **Jump over the lines that do not change.** A line that got no run in a round, and whose start is the same stack object, keeps its choice and its end. So do the lines after it, up to the next line that got a run. The walk jumps over them. The stitch on lodash went from 130 ms to 60 ms, with the same rounds.
- **Predict a line only as far as its run agrees.** Section 6 tells the rule. Before lines with the same text shared their runs, the rounds went from 84 to 12 on lodash, from 64 to 14 on three.min.js, and from 347 to 9 on react-dom.development.js. With shared runs, they went from 20 to 10, from 64 to 14 and from 51 to 6. These predictors did not do better (rounds on lodash, react-dom.development.js and three.min.js):
  - Agreement by rule, without the theme states: the same rounds.
  - The pushed frames with their themes computed again on the new parent: 12, 9 and 13 rounds, but more runs.
  - The most recent run when two runs agree equally: 31, 33 and 25.
  - No change to the stack when no run agrees at the top: 36, 39 and 36.
  - A table, learned from all runs, of the frames that pop when a pop reveals them: 13, 7 and 93. A wrong guess of a pop is expensive in three.min.js, whose lines read up to 16 frames.
- **Send fewer start frames.** A job got up to 64 frames of its predicted start, so the host built and the GPU read many frames that no run reads. Now a job gets 16 frames, or the full stack when the line's runs read deeper. The rounds and the stitch on lodash went from about 92 ms to 53 ms, and on react-dom.development.js from about 150 ms to 84 ms. With 8 frames, three.min.js needed 23 rounds, not 14.
- **A long line waits for an exact start.** A round lasts as long as its longest run. In TypeScript's scanner.ts, four lines of 4,657 to 10,366 code points got a different speculative start in rounds 2, 3 and 5, and each of those rounds took about 40 ms. Now a line of more than 1,000 code points that has three runs gets a job only when it is the first invalid line. The rounds and the stitch on scanner.ts went from about 160 ms to 110 ms, and the other fixtures did not change. With lines that share their runs, scanner.ts needs 5 rounds before and after these changes, but it now takes about 30 ms (about 4%) longer: its long lines need a third run, in round 3, of about 40 ms. Before, their second run, from a wrong deep stack, was valid by chance. A limit of two runs would remove this, but it makes three.min.js much slower (below). Two rules were worse: with two runs, or with a limit of 300 code points, three.min.js needed 43 or 389 rounds, because its long lines then waited for each other.

### The lite version

The lite version (README, "The lite version") gives up exactness. `pnpm check:lite` measures how many characters have shiki's color and font style.

- **Chunks of long lines in stage A worked.** Stage A on three.min.js went from about 530 ms to about 300 ms, with chunks of 512 positions and overlaps of 32 to 64 positions before and 64 to 128 after. Chunks of 1,024 and 2,048 gave about 350 ms, and chunks of 128 gave 350 ms, because of the overlaps' extra work. With chunks, stage A of three.min.js is limited by throughput, not by its longest line.
- **The overlaps can be small.** All overlaps from 16/32 to 64/256 gave output identical to shiki on all fixtures. With 8/16, 67 characters of three.min.js were wrong. With 4/8 and less, a walk lost its path and its run hit the step limit. So the lite version runs stage A again, without chunks, for the lines whose runs fail. With no overlap, the result was then 99.2% correct.
- **Stopping the rounds early was a bad trade.** After k rounds, each line that is not valid runs with tokens from its predicted start. The percentage of correct characters:

  | Rounds | lodash | three.min.js | react | react-dom |
  | --- | --- | --- | --- | --- |
  | 4 | 98.23% | 96.74% | 99.70% | 99.79% |
  | 8 | 99.92% | 97.44% | 100% | 100% |
  | 16 | 99.987% | 98.70% | 100% | 100% |
  | 32 | 100% | 99.62% | 100% | 100% |

  The errors are not in a few lines. In lodash, whole lines of jsdoc examples lost their comment color, because the predicted start had no comment frame. In three.min.js, about 10 characters of many lines were wrong: `function` had the color of a function name, because a frame below the top was wrong. The time gain was small, because the late rounds are short. Only three.min.js gained, about 100 ms to 150 ms, and that was near the noise. react-dom needs 51 rounds, but its output is already identical after 8: its late rounds only make the frames below the top correct.
- **After the stitch fix, the round limit is still a bad trade.** The stitch now predicts a line only as far as its run agrees (section 6), and the full version needs 6 to 14 rounds. With the lite default, three.min.js needs 24. The table above is from before the fix. After it, with a limit of 2, 4 and 8 rounds, three.min.js had 87.8%, 91.2% and 96.0% of its characters correct, and lodash 88.8%, 97.2% and 99.94%.
- **Segments of long lines in the driver worked, when the boundaries move.** The table below is from before the stitch fix, when three.min.js needed 64 rounds. A segment's run starts its search at the segment's start and stops when its search gets to the segment's end, and the host stitches segments as lines. The best of 8 calls:

  | Segment size | three.min.js driver | Rounds | scanner.ts driver |
  | --- | --- | --- | --- |
  | none | 317 ms | 64 | 212 ms |
  | 1,024 | 293 ms | 62 | 48 ms |
  | 512 | 307 ms | 70 | 34 ms |
  | 256 | 289 ms | 107 | 29 ms |
  | 128 | 198 ms | 107 | 27 ms |
  | 64 | 182 ms | 134 | |

  Most lines of three.min.js have about 500 to 600 code points, so only segments shorter than that help it. A round with one short job took from 0.5 ms to 3.8 ms, and an empty round trip to the GPU takes 0.2 ms. Where the rest of a late round's time goes is not measured yet. With boundaries at fixed places, segments of 128 gave 608 wrong characters on three.min.js, and segments of 32 gave 5,459. A boundary moved to just after `;`, `,`, `{` or `}`, in the 32 code points before it, gave none.
- **After the stitch fix, segments help three.min.js less.** The best of 8 calls: without segments, the driver took 150 ms in 14 rounds. With segments of 512, 256 and 128, it took 130, 131 and 97 ms, in 15, 21 and 24 rounds. Segments of 1,024 took 216 ms in 49 rounds: their segments are longer than 1,000 code points, so they wait for exact starts (see "A long line waits for an exact start", above). On scanner.ts, segments of 128 still took the driver from 243 ms to 27 ms.
- **The stop costs the full version nothing measurable.** The search expert checks `q >= segEnd`, and the full version sets segEnd to n + 1. This adds 5 operations to the search expert (139 to 144 with tokens). The driver on three.min.js took 326 ms to 333 ms, against 328 ms to 344 ms before (three runs each, in alternation). The search expert does not make the content token up to the segment's end, because that adds 22 operations. The host makes it, from the content scope of the end stack's top frame.
- **Test on the code that the change is for.** The six fixtures have few lines longer than 1,000 code points, and the first version of the segments was identical to shiki on all of them. On real minified code (now `fixtures/minified`), only 57% of the characters of oniguruma-parser.min.js and 66% of a minified react-dom were correct. A segment then started at a fixed position. In `` `...kind "${t}"` ``, a boundary fell between `$` and `{`: the segment before it matched `${` and pushed a frame, and the next segment read the `{` again as a block. The stack then stayed wrong until the end of the file. The snap to `;`, `,`, `{` or `}` had hidden this on the fixtures.
- **A segment starts from the state where the segment before it stopped.** The stitch now checks the start state as it checks the stack, and keeps a trie of runs for each state. With the state as linePos, q and the anchor, three.min.js needed 71 rounds, not 26: the anchor differs often, but only its equality with linePos changes a run. A key of q and two bits (linePos = q, anchor = linePos) loses nothing, which `check:driver-gpu` shows: on all fixtures, the joined segments are equal to the run of the whole line. A guess of the stack from runs at other states, when no run started at this state, made minified react-dom need 721 rounds, not 490, so it is not used.
- **At most 64 segments in a line.** Minified react-dom has lines of up to 46,671 code points, and with segments of 128 it needed 490 rounds and 1.45 s. With at most 64, 32 and 16 segments in a line: 148, 116 and 181 rounds, and 0.96 s, 0.85 s and 1.22 s. Minified lodash took 0.14 s, 0.28 s and 0.34 s, so 64 is the best of the three.
- **shiki is not exact on very long lines.** shiki's `codeToTokens` stops a line after 500 ms by default (`tokenizeTimeLimit`), and gives the rest of the line one plain token. On minified lodash, only 24% of the characters then agree with shiki without the limit. The network has no such limit, and the full version is identical to shiki without it.
- **The full version can lose the GPU device on very long lines.** On the minified fixtures, the full version lost the device in 2 of 3 processes (Metal: "Discarded (victim of GPU error/recovery)"), and the lite version in none of 36 runs. Its driver runs a line of tens of thousands of code points as one job in one command buffer. `check:lite` then makes a new device.
- **Order changes the times.** When the lite version always ran second, it was up to 25% slower on files where it does the same work as the full version. `check:lite` now changes the order in each repeat.
