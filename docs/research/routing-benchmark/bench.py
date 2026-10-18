"""Diagnostic retrieval baseline, not production dispatch or authorization."""
import collections
import json
import math
import pathlib
import platform
import re
import time


def terms(text):
    return re.findall(r"[^\W_]+", text.lower())


class Catalog:
    def __init__(self, tools, visible=None):
        # Visibility is applied BEFORE corpus statistics; callers own policy.
        self.tools = {t["id"]: t for t in tools if visible is None or t["id"] in visible}
        self.postings = collections.defaultdict(dict)
        self.lengths = {}
        for key, tool in self.tools.items():
            counts = collections.Counter(terms(key + " " + tool["description"]))
            self.lengths[key] = sum(counts.values())
            for term, frequency in counts.items():
                self.postings[term][key] = frequency
        self.average = sum(self.lengths.values()) / max(1, len(self.tools))

    def search(self, query, limit=3):
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
            raise ValueError("limit must be an integer from 1 to 20")
        query = query.strip()
        if query in self.tools:
            return [query]
        scores = collections.defaultdict(float)
        for term in set(terms(query)):
            matches = self.postings.get(term, {})
            idf = math.log(1 + (len(self.tools) - len(matches) + 0.5) / (len(matches) + 0.5))
            for key, frequency in matches.items():
                norm = 1.2 * (0.25 + 0.75 * self.lengths[key] / self.average)
                scores[key] += idf * frequency * 2.2 / (frequency + norm)
        return sorted(scores, key=lambda key: (-scores[key], key))[:limit]


def byte_size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def percentile(values, fraction):
    return sorted(values)[math.ceil(len(values) * fraction) - 1]


def main():
    fixture = json.loads(pathlib.Path(__file__).with_name("fixtures.json").read_text())
    report = {"python": platform.python_version(), "platform": platform.platform(),
              "limitations": "Handwritten diagnostic fixtures; synthetic scale; no model, tokens, network, dispatch or sandbox evaluation.",
              "retrieval": []}
    for size in (len(fixture["tools"]), 1000, 10000):
        distractors = [{"id": f"synthetic-{i}::metric", "description": f"Observe unrelated telemetry sensor {i}", "effect": "read"}
                       for i in range(size - len(fixture["tools"]))]
        start = time.perf_counter_ns()
        catalog = Catalog(fixture["tools"] + distractors)
        build_ms = (time.perf_counter_ns() - start) / 1e6
        cases = []
        timings = []
        for case in fixture["queries"]:
            hits = catalog.search(case["query"])
            cases.append({**case, "hits": hits, "hit1": case["expected"] in hits[:1],
                          "hit3": case["expected"] in hits})
        for _ in range(100):
            for case in fixture["queries"]:
                start = time.perf_counter_ns()
                catalog.search(case["query"])
                timings.append((time.perf_counter_ns() - start) / 1e6)
        report["retrieval"].append({"tools": size, "build_ms": build_ms,
                                    "warm_p50_ms": percentile(timings, 0.5),
                                    "warm_p95_ms": percentile(timings, 0.95),
                                    "hit1": sum(c["hit1"] for c in cases),
                                    "hit3": sum(c["hit3"] for c in cases),
                                    "queries": len(cases), "cases": cases})
    # The same source records yield a small answer; not an LLM performance claim.
    records = [{"id": i, "title": f"Example page {i}", "body": "x" * 1000} for i in range(100)]
    answer = {"total": len(records), "ids": [r["id"] for r in records if r["id"] < 5], "complete": True}
    report["composition_simulation"] = {"raw_result_bytes": byte_size(records),
                                         "selected_answer_bytes": byte_size(answer),
                                         "note": "Excludes control schemas and generated program bytes; not total task cost."}
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
