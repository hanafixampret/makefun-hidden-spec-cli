# makefun-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hanafixampret/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hanafixampret/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies AI-written edits in four formats (unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of files, to one written specification, finding the lines an edit names even when the model drifted their whitespace or indentation, and changing every file or none.

Built by an AI agent for make.fun's “Build mend, one patch tool for every AI edit format” bounty.

## Run it

```sh
node main.ts [options] [PATCH]
```

`node main.ts --format=unified patch.diff`, `node main.ts --check --strict - < patch.txt`, or pipe a patch on standard input. `main.ts` needs Node 22 and its standard library only; `runner.ts` beside it is the kit's trial runner, and `check.ts` runs the 100 public practice checks on `main.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hnbaye7d&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
