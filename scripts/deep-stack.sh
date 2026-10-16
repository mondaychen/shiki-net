#!/bin/sh
# Runs node with a deep stack, for the reference matcher's recursion: the OS stack limit first, then V8's.
ulimit -s 65520 && exec node --stack-size=60000 "$@"
