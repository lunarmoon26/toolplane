import { describe, expect, test } from "bun:test"
import { searchRankingInput } from "../src/contracts"
import { SearchRanking, SystemOneSearchRanker, searchRankingFromEnv, type SearchCard } from "../src/rerank"

const config = searchRankingInput.parse({ url: "http://127.0.0.1:8765/v1/systemone", model: "fixture-model" })
const cards: SearchCard[] = [
  { id: "one::search", name: "search_email", description: "Search email", fingerprint: "a" },
  { id: "two::send", name: "send_email", description: "Send email", fingerprint: "b" },
]
const abort = () => new AbortController().signal
const reply = (answers: unknown, model = config.model) => Response.json({ model, answers })
const nouls = { t0: { type: "noul", noul: 0.1 }, t1: { type: "noul", noul: 0.9 } }
const choice = { rank: { type: "choice", choice: "t1", probabilities: { t0: 0.1, t1: 0.9 }, confidence: 0.8 } }

describe("local System One search adapter", () => {
  test("configuration defaults off; rejects remote, DNS, credentials and unknown settings", () => {
    expect(searchRankingFromEnv({})).toBeUndefined()
    expect(searchRankingFromEnv({ TOOLPLANE_SEARCH_RANKER: JSON.stringify(config) })).toBeInstanceOf(SearchRanking)
    for (const url of ["https://api.example/v1/systemone", "http://localhost:8765/v1/systemone", "http://127.0.0.1.evil/v1/systemone", "http://127.0.0.2/v1/systemone", "http://user:secret@127.0.0.1/v1/systemone", "http://127.0.0.1/v1/systemone?key=secret", "http://127.0.0.1/v1/systemone#x"]) {
      expect(searchRankingInput.safeParse({ ...config, url }).success).toBe(false)
    }
    expect(searchRankingInput.safeParse({ ...config, url: "http://[::1]:8765/v1/systemone" }).success).toBe(true)
    for (const extra of [{ poolSize: 51 }, { timeoutMs: 0 }, { maxConcurrent: 9 }, { apiKey: "secret" }]) {
      expect(searchRankingInput.safeParse({ ...config, ...extra }).success).toBe(false)
    }
    expect(() => searchRankingFromEnv({ TOOLPLANE_SEARCH_RANKER: "private bad configuration" })).toThrow("Invalid TOOLPLANE_SEARCH_RANKER")
  })
  test("batches per-candidate Noul without forwarding fingerprints or auth", async () => {
    let sent: BunFetchRequestInit | undefined
    const ranker = new SystemOneSearchRanker(config, async (url, init) => {
      expect(url).toBe(config.url); sent = init
      return reply(nouls)
    })
    expect(await ranker.rank("email my manager", cards, abort())).toEqual([cards[1].id, cards[0].id])
    const body = JSON.parse(sent!.body as string)
    expect(body.state).toEqual({ query: "email my manager" })
    expect(Object.keys(body.questions)).toEqual(["t0", "t1"])
    expect(body.questions.t0.instructions.candidate).toEqual({ id: cards[0].id, name: cards[0].name, description: cards[0].description })
    expect(sent!.redirect).toBe("error")
    expect(sent!.proxy).toBe(false)
    expect(sent!.credentials).toBe("omit")
    expect(sent!.headers).toEqual({ "content-type": "application/json" })
    expect(JSON.stringify(body)).not.toContain("fingerprint")
  })
  test("Choice sorts the whole pool, with stable ties and no pruning", async () => {
    const ranker = new SystemOneSearchRanker({ ...config, mode: "choice" }, async (_url, init) => {
      const body = JSON.parse(init.body as string)
      expect(body.questions.rank.type).toBe("choice")
      expect(Object.keys(body.questions.rank.criteria)).toEqual(["t0", "t1"])
      return reply(choice)
    })
    expect(await ranker.rank("send email", cards, abort())).toEqual([cards[1].id, cards[0].id])
    const tied = new SystemOneSearchRanker(config, async () => reply({ t0: { type: "noul", noul: 0 }, t1: { type: "noul", noul: 0 } }))
    expect(await tied.rank("none relevant", cards, abort())).toEqual(cards.map(c => c.id))
  })
  test("rejects missing, extra, wrong-type and invalid probability answers", async () => {
    for (const answers of [{}, { t0: nouls.t0 }, { ...nouls, t2: nouls.t0 },
      { ...nouls, t0: { type: "choice", noul: 0.8 } }, { ...nouls, t0: { type: "noul", noul: "0.9" } },
      { ...nouls, t0: { type: "noul", noul: -1 } }, { ...nouls, t0: { type: "noul", noul: 2 } }]) {
      const ranker = new SystemOneSearchRanker(config, async () => reply(answers))
      await expect(ranker.rank("email", cards, abort())).rejects.toMatchObject({ reason: "invalid_response" })
    }
    for (const value of [
      { ...choice.rank, probabilities: { t0: 0.8, t1: 0.8 } },
      { ...choice.rank, probabilities: { t0: 0.1, foreign: 0.9 } },
      { ...choice.rank, choice: "foreign" }, { ...choice.rank, choice: "t0" },
    ]) {
      const ranker = new SystemOneSearchRanker({ ...config, mode: "choice" }, async () => reply({ rank: value }))
      await expect(ranker.rank("email", cards, abort())).rejects.toMatchObject({ reason: "invalid_response" })
    }
  })
  test("rejects returned model mismatch, malformed JSON and oversized streaming bodies", async () => {
    for (const response of [reply(nouls, "other-model"), new Response("not JSON"), new Response("x".repeat(65537)),
      new Response("", { headers: { "content-length": "65537" } })]) {
      const ranker = new SystemOneSearchRanker(config, async () => response)
      await expect(ranker.rank("email", cards, abort())).rejects.toMatchObject({ reason: "invalid_response" })
    }
  })
  test("HTTP errors have one attempt and no raw error leakage", async () => {
    let calls = 0
    const ranker = new SystemOneSearchRanker(config, async () => { calls++; return new Response("private upstream secret", { status: 503 }) })
    await expect(ranker.rank("email", cards, abort())).rejects.toMatchObject({ message: "unavailable" })
    expect(calls).toBe(1)
  })
  test("oversized input is not submitted", async () => {
    let calls = 0
    const ranker = new SystemOneSearchRanker(config, async () => { calls++; return reply(nouls) })
    await expect(ranker.rank("x".repeat(70000), cards, abort())).rejects.toMatchObject({ reason: "invalid_response" })
    expect(calls).toBe(0)
  })
})

describe("ranking admission and failure isolation", () => {
  test("invalid, duplicate or partial adapter IDs fall back, never add or remove tools", async () => {
    for (const ids of [[cards[0].id], [cards[0].id, cards[0].id], [cards[0].id, "foreign"], [cards[0].id, cards[1].id, "foreign"]]) {
      const ranking = new SearchRanking({ async rank() { return ids } }, config)
      expect(await ranking.rank("email", cards)).toEqual({ ids: cards.map(c => c.id), status: "fallback", reason: "invalid_response" })
    }
  })
  test("abstention preserves lexical order", async () => {
    const ranking = new SearchRanking({ async rank() { return null } }, config)
    expect(await ranking.rank("email", cards)).toMatchObject({ status: "fallback", reason: "abstained" })
  })
  test("three failures open a circuit; a success resets consecutive failures", async () => {
    let calls = 0
    const ranking = new SearchRanking({ async rank() { calls++; throw Error("private") } }, config)
    for (let i = 0; i < 3; i++) expect((await ranking.rank("email", cards)).reason).toBe("unavailable")
    expect((await ranking.rank("email", cards)).reason).toBe("circuit_open")
    expect(calls).toBe(3)
    let fail = true
    const reset = new SearchRanking({ async rank() { if (fail) throw Error(); return cards.map(c => c.id) } }, config)
    await reset.rank("email", cards); await reset.rank("email", cards)
    fail = false; expect((await reset.rank("email", cards)).status).toBe("reranked")
    fail = true
    expect((await reset.rank("email", cards)).reason).toBe("unavailable")
  })
  test("deadline aborts inference but holds capacity until underlying work settles", async () => {
    let release!: (ids: string[]) => void
    let receivedSignal!: AbortSignal
    const ranking = new SearchRanking({ rank(_q, _c, signal) {
      receivedSignal = signal
      return new Promise(resolve => { release = resolve })
    } }, { ...config, timeoutMs: 5, maxConcurrent: 1 })
    expect((await ranking.rank("email", cards)).reason).toBe("timeout")
    expect(receivedSignal.aborted).toBe(true)
    expect((await ranking.rank("email", cards)).reason).toBe("busy")
    release(cards.map(c => c.id)); await Bun.sleep(0)
    const pending = ranking.rank("email", cards)
    await Bun.sleep(0); release(cards.map(c => c.id))
    expect((await pending).status).toBe("reranked")
  })
  test("request cancellation aborts work and does not open the failure circuit", async () => {
    const ranking = new SearchRanking({ rank(_q, _c, signal) {
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(Error()), { once: true }))
    } }, config)
    for (let i = 0; i < 4; i++) {
      const controller = new AbortController()
      const pending = ranking.rank("email", cards, controller.signal)
      await Bun.sleep(0); controller.abort()
      expect((await pending).reason).toBe("cancelled")
    }
  })
  test("a stalled response body is covered by the deadline", async () => {
    let cancelled = false
    const adapter = new SystemOneSearchRanker(config, async () => new Response(new ReadableStream({ cancel() { cancelled = true } })))
    const ranking = new SearchRanking(adapter, { ...config, timeoutMs: 5 })
    expect((await ranking.rank("email", cards)).reason).toBe("timeout")
    await Bun.sleep(0)
    expect(cancelled).toBe(true)
  })
  test("adapter mutation cannot change the broker's card snapshot", async () => {
    const ranking = new SearchRanking({ async rank(_q, candidates) {
      candidates[0].fingerprint = "changed"
      return candidates.map(c => c.id)
    } }, config)
    expect((await ranking.rank("email", cards)).status).toBe("fallback")
    expect(cards[0].fingerprint).toBe("a")
  })
})

test("real loopback HTTP verifies the wire protocol and does not follow redirects", async () => {
  let calls = 0, redirected = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++
    const path = new URL(request.url).pathname
    if (path === "/redirect") return Response.redirect(new URL("/unexpected", request.url), 302)
    if (path === "/unexpected") redirected++
    const body = await request.json() as { model: string; state: { query: string }; questions: Record<string, { type: string }> }
    expect(body.state.query).toBe("email")
    expect(request.headers.has("authorization")).toBe(false)
    return reply(body.questions.rank ? choice : nouls, body.model)
  } })
  try {
    for (const mode of ["noul", "choice"] as const) {
      const ranker = new SystemOneSearchRanker({ ...config, url: new URL("/v1/systemone", server.url).href, mode })
      expect(await ranker.rank("email", cards, abort())).toEqual([cards[1].id, cards[0].id])
    }
    const redirect = new SystemOneSearchRanker({ ...config, url: new URL("/redirect", server.url).href })
    await expect(redirect.rank("email", cards, abort())).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(3)
    expect(redirected).toBe(0)
  } finally { await server.stop(true) }
})
