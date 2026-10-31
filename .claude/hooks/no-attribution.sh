#!/bin/bash
# Blocks any GitHub write that carries an attribution footer or a Co-Authored-By line.
# Seb writes every commit, pull request and comment of this repository.
# The cloud routines read this repository's settings, so the block applies to them too.
input="$(cat)"
pattern='(Gene''rated (by|with) \[?Clau''de)|(claude\.ai/code)|(Co-Authored-By: *Clau''de)|(noreply@anthropic\.com)'
if printf '%s' "$input" | grep -qiE "$pattern"; then
  echo "BLOCKED: remove the attribution footer, the claude.ai link and any Co-Authored-By line. Seb writes this text in the first person. Send it again without them." >&2
  exit 2
fi
exit 0
