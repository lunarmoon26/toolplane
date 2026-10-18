# Low-latency, token-efficient tool routing

Research date: 2026-10-16. Status: **recommendation, not implemented runtime**.
Audience: maintainers of the first-party integrations and portable plugin stack.

## Recommendation

Build a small **capability catalog and invocation broker**, not another
embedding-first MCP proxy or a new agent harness. Separate discovery, execution,
and model-facing presentation. Use native deferred loading and CodeMode where
available; provide compact search/call and a CLI as portable fallbacks.

Keep Harness Alchemist as the packaging/scaffold layer, Agent Skill Runtime as
the skill-process execution layer, MCPorter as one MCP transport/client option,
and the existing integration executors as the authority for domain operations.
The new responsibility is a unified, scoped catalog and efficient presentation.

Start exact-name + lexical. Add optional multilingual semantic retrieval only
where evaluation demonstrates misses. Do not put an inference server or a
decision model on every call's critical path.

## 1. What actually changed

| Approach | Mechanism and benefit | Limitation relevant to us |
| --- | --- | --- |
| MCPorter / CLI [10] | Makes MCP operations callable from scripts and shell without permanently injecting every schema; runtime/daemon supports connection reuse | Discoverability, process startup, structured results, permissions and output volume still matter; CLI conversion is not by itself authorization or sandboxing |
| OpenClaw Tool Search [1] | Policy-filtered catalog, exact lookup, BM25, compact search signatures, describe and dispatch; normal target policy pipeline | Experimental OpenClaw surface; English lexical queries have explicit language limitations; extra discovery turns can cost more for small catalogs |
| Claude tool search [2] | Regex or BM25, deferred definitions, tool references expanded inline; stable prompt prefix | Full deferred definitions still go in every API request; native references are provider-specific, not generic MCP results |
| Claude programmatic calling [3] | Code loops, concurrency, filtering and aggregation avoid repeated model inference | Client still handles tool-result protocol continuations; hosted MCP connector tools cannot currently be invoked this way; `allowed_callers` is explicitly not an authorization boundary |
| Pi CodeMode [4] | A JavaScript orchestration sandbox combines MCP/tools/classifiers and retains intermediate state | Requires structured data and host metadata; article evidence, not a benchmark reproduced here; our local Pi checkout predates the announcement |
| MCP 2026-07-28 [5] | Self-describing requests, stateless core, method/name HTTP headers, deterministic cacheable lists, MRTR and extensions | Improves transport/catalog economics; does not standardize semantic ranking, a CodeMode API, domain permissions or cross-service transactions |

These approaches are complementary. Tool search saves schema context; CodeMode
saves model inference turns and intermediate-result context; transport reuse
saves connection/setup work. A single tool can still return megabytes of text.

**Important distinction:** MCP is not inherently context-bloated. Eagerly
presenting all schemas is a harness choice. A CLI can also bloat context with
huge help pages or outputs.

## 2. First-party baseline: retain the idea, replace the hot path

Direct source evidence, pinned identities:

- `openclaw-mcp-router` @ `e2f52a4b3a270cfd35d3e90e301acdbe19563ad6`:
  - `src/tools/mcp-search-tool.ts:86–105`: every query awaits embeddings;
    embedding failure prevents search. No lexical fast path in this function.
  - `src/mcp-registry.ts:4–27`: owner map keys only tool name; collisions
    overwrite the previous server. Retrieval instead deduplicates on server/name
    (`mcp-search-tool.ts:107–118`). A discovered identity can therefore be more
    precise than invocation identity.
  - `src/tools/mcp-call-tool.ts:82–109`: connect/call/disconnect per invocation.
    This is avoidable overhead for legacy/sessionful servers and local processes.
  - `src/tools/mcp-search-tool.ts:134–163`: verbose cards repeat CLI and JSON
    instructions, and schema strings can be sliced at 2,000 characters. A sliced
    schema is not a usable exact contract; similarity displayed as a percentage
    should not be interpreted as calibrated confidence.
- `opencode-blender` @ `fb62028`: `plugin/blender-mcp.ts:5–35` preserves six
  focused tools and argument-dependent Poly Haven permission routing. Arbitrary
  Python is write-gated even if a snippet claims to inspect only.
- `opencode-cloudflare` @ `834a6ba`: `plugin/bridge.ts:9–43` already caches an
  instance-scoped lazy MCPorter client and catalog; `plugin/cloudflare-mcporter.ts:22–35`
  keeps native write approval. This is an existing execution owner, not a reason
  to build another Cloudflare client.
- Notion: `plugin/notion.ts:22–37` owns `notion.write` approval;
  `plugin/bridge.ts:6–19` has an explicit read allowlist and gates unknown methods.
  Private Notion catalogs/content were not used in the lab fixture.
- `harness-alchemist` @ `64a49449fe5056bb244eab90512fed42255aeea4`:
  `src/opencode.ts:14–40` loads `createSkillRuntime`, registers manifest tools,
  and projects permissions into the host; `package.json:64–66` pins runtime
  `0.1.1`. `skills/harness-alchemist/skill-runtime.json:38–47` declares the
  entrypoint and behavior annotations. The sample tool is an echo workflow,
  not evidence of implemented semantic routing.
- Agent Skill Runtime's published contract [6] already defines schema validation,
  JSON-in/out, output byte limits, timeouts, cancellation and explicit engine
  preparation. Its native Node/Python execution is **not an OS sandbox**.

OpenClaw source @ `c86d0f80023d8dc22dcd1f8ed1cc1b7271414336` independently
supports the lexical design: `src/agents/tool-search-runtime.ts:240–310` filters
visibility, checks exact matches before ranking, and builds/reuses an index;
`tool-search-ranking.ts:36–39,368–399` implements Okapi BM25. Do not copy its
whole runtime: the policy/hook/session ownership is OpenClaw-specific.

## 3. Proposed boundaries

Conceptual flow; these modules are **not** implemented in this lab:

```text
MCP servers / skill manifests / explicit CLI adapters / native tool providers
                | normalized descriptors + origin + full schemas
                v
       Scoped catalog snapshots and retrieval
                | selected capability IDs and schema references
                v
Native host tool loading OR compact search/call OR CLI
                | exact ID + arguments + host-owned invocation context
                v
  Invocation broker -> owning permission/execution path -> target
                | structured results + bounded presentation + receipts
                v
Native CodeMode (preferred) OR optional isolated orchestration runner
```

### Catalog owns discovery, not authority

Use qualified identities such as `source::tool`, plus a schema revision/hash.
Include input/output schemas, source provenance/trust, compact description,
operation kind, optional workflow/skill reference and availability. Preserve
mixed operations: Poly Haven search and import have different effects.
Unknown effect is unknown, never inferred read-only by an LLM.

Index tool-sized records rather than arbitrary chunks. Keep extensive examples
and workflow instructions separately fetchable. For Cloudflare's existing
search/execute API, index the service capability and delegate endpoint discovery
to it; do not expand ~2,500 endpoints just to recompress them at another layer.
Similarly do not run search -> router -> MCPorter CLI -> Cloudflare search when
the exact endpoint or service search tool is already known.

Filter visibility before retrieval and corpus statistics. Cache by source
identity, credential/principal scope, catalog revision and relevant policy
scope—not merely by server URL. Follow advertised MCP TTL/cacheScope when
supported; older sources need bounded refresh/invalidation. Never share
user-scoped catalogs or cached results across principals. Revalidate authority
at invocation; cached discovery does not confer access.

### Retrieval is a cascade, not an inference pipeline by default

1. Exact qualified ID: constant-time lookup, no embedding or describe round trip.
2. Lexical index: names, descriptions, curated aliases, and bounded schema fields
   where source trust permits. Split snake/camel identifiers; support stemming
   and stopwords in production. Keep deterministic tie-breaking.
3. If recall is inadequate, use multilingual embeddings alongside lexical search
   and fuse candidate ranks with RRF. RRF combines rankings; it is not a model
   or an accuracy guarantee. Embed catalog entries on change, not per task.
4. Optionally rerank a small shortlist using a cross-encoder/decision model, only
   when measured benefit pays for latency and operational cost.
5. Return no match/ambiguity honestly. A BM25 margin is not a probability. Choose
   escalation thresholds against labeled validation data, not intuition alone.

For bilingual use, try curated bilingual aliases and the agent's existing
English query formulation first, but evaluate native Chinese queries explicitly.
Do not add a separate query-rewriting LLM call to every request by default.

**StartLux/Jev:** StartLux's README and API [7] describe typed choices with
probabilities, optional thinking, and vLLM/llama.cpp/MLX engines. This makes it a
candidate shortlist selector or in-workflow classifier. The Pi article's Jev
example classifies issue sentiment; it does not demonstrate tool-routing quality.
Do not assume Jev and StartLux checkpoints are interchangeable, that reported
probabilities are calibrated on our catalog, or that sub-billion parameter size
guarantees lower end-to-end latency. No decision model was run in this research.

### Expose as little as useful, not exactly two tools at all costs

Portable fallback: `search` plus `call`. Search supports a batch of queries and
returns a few qualified IDs with compact signatures; full schemas can be requested
through discovery by exact ID, without another permanently exposed describe tool.
Never return broken/truncated JSON Schema. A compact signature must say when it
is incomplete. Permit exact invocation without mandatory search.

Native deferred loading: project the same catalog into host/provider references
instead of wrapping it in another search tool. Native CodeMode: register callable
operations there and reuse the host interpreter. OpenCode V2 documents namespaces,
`options.codemode`, stable executable snapshots and permission assertions [8].
Do not build a second interpreter inside a host that already provides one.

A generic execute tool is an optional negotiated adapter, not an MVP requirement.
Fallback hosts can use an explicit CLI or typed batch invocation initially.
Keep frequently used coding primitives directly visible; for a small focused
Blender session, six direct tools may beat search-plus-call.

### Execution stays with its existing owner

The broker must invoke the real executor with native session/agent/source and
cancellation context, not bypass it with a direct MCPorter/HTTP call. Authorization
uses an adapter callback; absent approval capability means fail closed for gated
operations or return an explicit approval-required outcome. CLI/MCP adapters
need their own explicit grants; they cannot pretend to inherit an OpenCode UI
approval. MCP annotations and classifier decisions are hints, not grants.

Reuse connections for sessionful MCP and local subprocess servers. For stateless
2026-07-28 HTTP servers, use HTTP connection reuse, source-aware caches and
bounded concurrency rather than recreating obsolete protocol sessions. Confirm
actual upstream version support; an installed MCPorter package is not proof it
implements the newest protocol. Current upstream MCPorter documentation [10]
explicitly supports negotiation of 2026-07-28 and legacy revisions; the installed
integration dependency versions were not qualified against both here.

For orchestration: structured values, bounded concurrency, cancellation between
calls, per-source limits and ordered writes where needed. Preserve raw results
outside the model transcript when allowed; return selected fields plus count,
pagination/completeness, freshness and accessible artifact references. Treat
tool descriptions and output as untrusted data, not system instructions.

An eventual isolated JS/WASM runner should have no ambient network, filesystem,
environment secrets or process access; only brokered tool capabilities, execution
budgets and bounded output. Node `vm` is not a security boundary. A Docker
container without these controls is not enough either. The benchmark container
here runs trusted fixed Python, **not generated code**.

Write receipts distinguish success, failure, partial completion and unknown
effect. Cancellation prevents new work but may not undo in-flight remote work.
Use target-supported idempotency/conditional writes where available; never
advertise universal exactly-once execution or automatic rollback. An ambiguous
Notion move or Cloudflare mutation needs inspection before retry.

## 4. Standards: use the right layer

Your article [9] correctly separates interaction, authorization and recovery.
Its standards list is complementary, not a unified routing specification:

- **MCP:** tool/resource transport, schemas and authorization machinery.
- **Agent Skills:** portable procedural guidance; `skill-runtime.json` is your
  versioned first-party execution contract, not an industry-wide standard.
- **ACP:** client-agent sessions, permissions, progress and cancellation.
- **AG-UI:** UI events, shared state and interruption presentation.
- **A2A:** agent/task delegation, not needed for local tool dispatch.
- **OpenTelemetry GenAI conventions:** observability vocabulary, not approval or
  correctness proof. Avoid exporting private tool arguments/results by default.

Adopt MCP/JSON Schema and existing skill contracts. Adapt host permission and
CodeMode surfaces. Experiment with retrieval and reranking. Defer a new universal
task format, ACP/A2A server, scheduler or governance framework until a concrete
interoperability workflow requires it. Keep minimal operation receipts local.

## 5. What the experiment establishes

Pinned image: `python@sha256:2d9aefe2fef018a7eb2c13064c89c71929800fd2e5dccdbf52ea5da5bb8d929a`.
Docker Desktop server 29.8.0 and Docker Engine server 29.9.0; both runs passed
five focused tests. No container network, credentials or writable mount.

| Catalog | Desktop build / warm p95 | Engine build / warm p95 |
| --- | --- | --- |
| 12 handwritten capabilities | 0.186 / 0.009 ms | 0.147 / 0.0055 ms |
| + synthetic distractors to 1,000 | 3.83 / 0.0055 ms | 2.90 / 0.0057 ms |
| + synthetic distractors to 10,000 | 46.1 / 0.0055 ms | 28.6 / 0.0054 ms |

Each run measured 1,600 warm searches per catalog without result caching. These
are single-run diagnostic timings, not statistically rigorous engine comparisons.
The distractors have little lexical overlap, so the inverted index touches few
postings; **this does not establish realistic 10k-tool p95**.

All sizes: top-1 12/16, hit@3 13/16. Both Chinese queries missed. The paraphrase
"how big is the cube" incorrectly matched a generic description via common
words. This weak baseline has no stemming/stopwords or bilingual aliases and the
queries are not held out. Evidence supports a cheap baseline and a real semantic
gap, not that BM25 is production-ready or better than embeddings.

The composition simulation reduces 104,581 raw JSON bytes to a 47-byte selected
answer. This illustrates filtering, not a claimed token savings percentage:
control schemas, program text, model behavior and API billing are excluded.

## 6. Next implementation cut and acceptance evidence

1. A TypeScript core with scoped catalog snapshots, qualified identity, exact
   lookup/BM25 and pluggable retrieval. Use in-process execution first; add a
   daemon only if connection lifetime or multi-client reuse demands it.
2. Manifest adapter for Agent Skill Runtime; MCP discovery through MCPorter after
   checking supported protocol versions. JSON CLI plus compact MCP search/call
   facade for compatibility. Reuse Harness Alchemist for distribution, not as
   the router's execution engine.
3. One native OpenCode adapter that preserves existing integration permission
   paths and uses host CodeMode; verify denied nested calls through the real host.
4. Evaluate direct schemas, lexical search/call, hybrid search/call and native
   CodeMode on the same tasks. Only then test a decision reranker and standalone
   sandbox. Keep Sketch/Xcode execution excluded on this Linux machine.

Build a larger labeled set with English/Chinese paraphrases, overlapping services,
tool-name collisions, unsupported requests and multi-step tasks. Split development
queries from held-out tasks. Track hit@k/MRR and abstention, but optimize **task
completion and wrong effects**, not retrieval score alone.

Record actual input/output/cache tokens, request bytes, model-inference turns,
backend request count, cold/warm p50/p95, time-to-first-useful-result, connection
starts, schema/argument errors and permission interruptions. Vendor token savings
and third-party retrieval tables are not substitutes for these measurements.

Proposed gates: warm local exact/lexical discovery p95 <10 ms on representative
1,000-tool catalogs; zero denied or stale-authority effects in conformance tests;
no meaningful task-success regression against direct exposure. A target such as
>=70% fewer model-visible schema/intermediate tokens on large-catalog tasks is an
experiment goal, not an achieved result. Measure small catalogs separately.

Approximate latency model:

`T = model inference + discovery + schema hydration + backend critical path + orchestration startup`.

Saving milliseconds of retrieval cannot compensate for an unnecessary model
turn taking seconds. Avoid forced search/describe, repeated process launches,
unbounded outputs and cache-prefix churn before optimizing ranking arithmetic.
Concurrency changes the critical path, not the number of external requests;
CodeMode can reduce model turns while increasing backend fan-out.

## Sources and evidence limits

1. [OpenClaw Tool Search](https://docs.openclaw.ai/tools/tool-search), current docs
   read 2026-10-16; source identity above.
2. [Claude tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool),
   current docs read 2026-10-16. Vendor-reported savings were not reproduced.
3. [Claude programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling),
   current docs read 2026-10-16, including connector restrictions and caller caveat.
4. [Earendil: You Said No MCP](https://earendil.com/posts/you-said-no-mcp/),
   2026-09-29. Local Pi `2b0a123de98318c2ff8069661721ce0c3794c34e`
   is dated 2026-09-26 and was not used as implementation proof of newer CodeMode.
5. [MCP 2026-07-28 announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
   and [versioned tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
6. [Agent Skill Runtime contract](https://github.com/lunarmoon26/agent-skill-runtime/blob/main/docs/contract.md),
   current main documentation, not independently pinned/reproduced here.
7. [StartLux-Decision README](https://github.com/StartLuxLabs/StartLux-Decision)
   and [API](https://github.com/StartLuxLabs/StartLux-Decision/blob/main/docs/api.md),
   current main documentation only. Clone timed out; model/server not evaluated.
8. [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins), current docs
   read 2026-10-16. Host integration behavior remains to be tested for the new broker.
9. [When the Caller Is an Agent](https://blog.haochuanz.net/posts/when-the-caller-is-an-agent),
   2026-10-15, especially context budgets, recovery and standards boundaries.
10. [MCPorter README](https://github.com/openclaw/mcporter), current main docs
    read 2026-10-16; runtime reuse, generated CLI and modern/legacy protocol
    support. Upstream CI claims were not independently reproduced here.

Existing source repositories were only read. No integrations were replaced,
no production routing benchmark or native permission conformance suite was run,
and no GitHub archive, commit, push or publication was performed.
