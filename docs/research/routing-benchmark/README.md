# Historical tool-routing benchmark

Harness-neutral research and reproducible, secretless microbenchmarks. This is
not a production router, MCP server, or security sandbox.

Originally maintained as `tool-routing-lab`; consolidated into Toolplane on
2026-10-18. This is a historical diagnostic, not Toolplane's production search
implementation or a current performance claim.

Read [the research memo](../tool-routing.md) for the recommendation and sources.
Run the following commands from this directory:

```sh
python3 -m unittest discover -s tests
python3 bench.py
```

Container reproduction (no network, credentials, Docker socket, or writable mounts):

```sh
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 1 --user 65534:65534 --mount type=bind,src="$PWD",dst=/lab,readonly --workdir /lab -e PYTHONDONTWRITEBYTECODE=1 python@sha256:2d9aefe2fef018a7eb2c13064c89c71929800fd2e5dccdbf52ea5da5bb8d929a python bench.py
```

The same command works with `docker --context default run` when that engine
has the image. It does not change the selected Docker context.

## Scope of evidence

- Handwritten descriptors represent public Blender, Notion, Cloudflare and
  Harness Alchemist capabilities; they are **not live catalogs or full schemas**.
- Lexical retrieval uses an inverted index and BM25, without embeddings,
  learned ranking, stemming, translation, or query-result caching.
- A small English/Chinese query set is diagnostic, not a held-out evaluation.
- Scale rows add synthetic unrelated distractors. They measure this code's
  mechanics, not real-world retrieval accuracy at 1,000 or 10,000 tools.
- Byte counts are UTF-8 JSON bytes, **not model tokens or API usage**.
- Composition is a deterministic local data simulation, not agent evaluation.
- No generated code is evaluated; no live tools are called.

Results are in `results-desktop.json` and `results-engine.json`. Existing integrations are unchanged.

Those JSON files retain the original measurements; new local runs print to stdout
and do not replace them. Runtime behavior is defined by
[Toolplane's contract](../../contract.md), not this benchmark.
