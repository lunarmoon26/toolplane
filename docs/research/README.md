# Tool-routing research archive

Research conducted 2026-10-16; consolidated from the separate `tool-routing-lab`
directory into Toolplane on 2026-10-18. This archive preserves rationale,
citations, reproducible experiments and their limitations. It is not a second
product or a runtime dependency.

## Read by purpose

- [Original research memo](tool-routing.md): source-grounded comparison, design
  recommendation, pinned source identities, standards boundaries, diagnostic
  findings and proposed evaluation gates. Preserved without rewriting history.
- [Benchmark reproduction](routing-benchmark/README.md): trusted Python baseline,
  handwritten English/Chinese fixtures, five tests, original Docker Desktop and
  Engine result files, and the original pinned-container command.
- [Current behavior contract](../contract.md): authoritative implemented
  behavior, security boundaries and acceptance evidence.

## Conclusions carried into Toolplane

- Separate discovery from authority and execution; qualify tool identities.
- Filter caller-visible tools before retrieval and corpus statistics.
- Start with exact lookup and lexical retrieval, without an inference dependency
  on every call. Add multilingual/hybrid retrieval only with evaluation evidence.
- Preserve complete schemas and structured results; expose a compact search/call
  interface rather than eagerly loading every definition into model context.
- Reuse transports and keep Cloudflare's hosted search/execute abstraction.
- Recheck authorization at dispatch. Hints and generated code do not grant access;
  ambiguous external effects must not trigger automatic mutation retries.

## Historical proposal versus implemented behavior

The memo describes the state of research on its original date. Its "next cut"
and "not implemented" statements are historical, not Toolplane's current roadmap.
Toolplane now has a persistent standalone broker and per-call approvals, with
standalone migrated domain executors. It does **not** inherit native OpenCode
session permission approval. Native deferred-loading/CodeMode adapters,
skill-manifest execution adapters and an isolated orchestration runner remain
research proposals, not implemented capabilities.

The benchmark is a separate Python implementation, not `src/search.ts`. Its
12/16 top-1 and 13/16 hit@3 results use handwritten, non-held-out queries; both
Chinese queries miss. Synthetic distractors and warm microsecond timings do not
establish realistic large-catalog latency or production routing quality. The
104,581-to-47-byte simulation measures JSON filtering, not actual token savings.
No decision model, generated-code sandbox or end-to-end agent comparison was run.

## Preservation and verification

The original memo, benchmark source, fixtures, five tests, both result JSON files
and ignore rules were copied byte-for-byte. Only the benchmark README was adapted
for its new location; generated `__pycache__` files were not retained. There was
no Git repository/history in the old directory to migrate.

From the Toolplane repository root:

```sh
PYTHONPATH=docs/research/routing-benchmark python3 -m unittest discover -s docs/research/routing-benchmark/tests
python3 docs/research/routing-benchmark/bench.py
```

The benchmark README also provides commands to run from its own directory. New
timings vary by machine; the archived result files remain unchanged.
