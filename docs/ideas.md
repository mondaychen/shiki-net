# Ideas

These are ideas that we did not try, and two that are now done. Each one says what to do, why it can help, and how large the work is. The measurements are from [lessons.md](lessons.md) and the README. Section 10 of lessons.md tells what the performance work changed, and which ideas did not work.

Now the network takes 0.53 s for lodash and 0.97 s for three.min.js. The best order for value against effort: idea 11 (the longest line of three.min.js is in the first rounds, in the token run and at the end of stage A), then idea 7 (to show where the GPU wins), then idea 13 (to show that the result stays exact on more code).

## Quick changes (hours)

1. **Done: do not run captures in the speculation rounds.** The rounds use experts without captures, `pre`, capture slots and token registers. Only the final run makes tokens. A late round's step went from about 4 µs to 2.1 µs.
2. **Start the driver before stage A is complete.** Stage A runs in groups of 8,192 lines. Start round 1 on the lines of a group when that group is complete, instead of when all lines are complete. Now round 1 takes about 15 ms on lodash, so the gain is small.
3. **Keep the last rounds on the GPU.** After about round 10, a round runs only a few lines. On lodash, its cost is mostly fixed: a dispatch, a readback and a walk on the host, about 1 ms to 2 ms. A persistent kernel can run the last rounds and do the stitch on the GPU. On three.min.js, a late round waits for a line of about 1,500 steps, so the gain there is small.
4. **Run the demo's work in a Web Worker.** Then the page does not stop for some seconds on the large files.
5. **Do less in each driver step.** Part of this is done: without tokens, a walk goes to `post` directly, and `post` finds the match's scope itself.
   - A search step can examine 4 positions instead of 1, from 4 record rows. On three.min.js, 96% of the search runs find a match at their first position, so the gain there is small. On lodash, half of the search runs are longer than one position.
   - The token experts are larger than the experts without tokens (the walk has 334 live operations, not 204). The token run of three.min.js waits about 45 ms for its longest line. Fewer operations there make that run shorter.
   - Measure each change on the GPU. A shorter chain of reads with more reads made the walk slower (lessons.md, section 10).

## Larger changes (days)

6. **Bit-parallel automata in stage A.** Now each node is a unit with its own list of items. For each automaton, keep the states as bits of 32-bit words. Then a step can be shift-and-mask operations on words, as handwired's `bit-emit.ts` does for its regex search. Phase 1 now starts from the nodes that hold (lessons.md, section 10), and is about 20% of stage A's throughput on lodash. So the gain is now smaller than it was.
7. **Many files in one run.** The GPU is fastest when it has much independent work. Highlight all the files of a repository together: stage A for all files, then rounds for all files at the same time. The fixed cost of a round then applies to many files. This is the most probable way to be clearly faster than shiki.
8. **Short lines as bit lanes.** lodash has 16K short lines, and each line pays the full cost of the barriers at each position. Let one workgroup do 32 lines at the same time, one line per bit lane. Then each barrier serves 32 times the work.
9. **Highlight again after an edit.** When an editor changes some lines, run stage A again only for those lines. Start the speculation from the stacks that are already known. It should then need only one or two rounds. The design fits this use well.
10. **A smaller record.** A record row is 200 words, and stage A writes about 430 MB for each fixture. Most of these words are ok bits for the walk. A smaller row means fewer writes, and lets a dispatch hold more lines. Without the record writes, stage A on lodash is about 5% faster.
11. **Speculation inside long lines.** Divide the long lines of three.min.js into segments, and speculate on the state at the start of each segment, as for lines. The longest job then becomes shorter. The token merge between two segments needs care: the last token of a segment can merge with the first token of the next segment. The longest line (7,114 code points, about 9,000 steps) sets the time of rounds 1 to 3 and of the token run, about 110 ms together.
12. **The task levels of stage A.** On lodash, the levels are now the largest part of stage A's throughput: without them, stage A is about 35% faster. Level 1 has 1,011 lookahead start items, and level 2 has 510 guard predicates. A push pass from the ok bits was slower for the lookaheads (lessons.md, section 10). Other forms to try: fewer entries from items that can never hold together, or one load for each entry, not two.

## Confidence and research

13. **Test more code.** Two files are a small test set. Compare the network with shiki on more code: the TypeScript compiler's sources, JSX, test262, and random JavaScript from a fuzzer. Each difference shows a part of the semantics that the network does not copy, or a feature that the compiler does not accept.
14. **Other grammars and themes.** TypeScript and CSS will probably work. Markdown and HTML need injections, `while` rules and captures with patterns. This shows how general the compiler is.
15. **Stage A as a handwired circuit.** Now only the driver is made of handwired circuits. Stage A has the same arithmetic, but in a kernel that we wrote by hand. Build the step of stage A with handwired's `Circuit`, and compare it with the dense CPU evaluation. Then all of the network is handwired in the same sense.
16. **Use the network as a model that can learn.** This is the purpose of handwired. Use the network as an exact front end, with fixed weights, for a model that learns. Or let its weights change, to learn a highlighter for a dialect that has no grammar.
