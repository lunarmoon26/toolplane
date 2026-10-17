import { expect, test } from "bun:test"
import { compileInputSchema } from "../src/schema"
import { Broker } from "../src/broker"
import { Store } from "../src/store"

test("2020-12 tuple and dependent-required constraints are enforced", () => {
  const validate = compileInputSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
    properties: { tuple: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false }, a: {}, b: {} },
    dependentRequired: { a: ["b"] }, required: ["tuple"], additionalProperties: false,
  })
  expect(validate({ tuple: ["ok", 2], a: true, b: true })).toBe(true)
  expect(validate({ tuple: ["ok", "wrong"] })).toBe(false)
  expect(validate({ tuple: ["ok", 2, 3] })).toBe(false)
  expect(validate({ tuple: [], a: true })).toBe(false)
})
test("draft-07 remains supported; unrecognized dialects and unresolved refs fail closed", () => {
  expect(compileInputSchema({ $schema: "http://json-schema.org/draft-07/schema#", type: "object" })({})).toBe(true)
  expect(() => compileInputSchema({ $schema: "https://example.com/unknown", type: "object" })).toThrow()
  expect(() => compileInputSchema({ type: "object", $ref: "https://example.com/remote" })).toThrow()
})
test("broker uses 2020-12 both for catalog acceptance and before dispatch", async () => {
  const store = new Store(":memory:")
  let calls = 0
  const broker = new Broker(store, {
    async list() { return [{ name: "fixture", description: "2020 fixture", inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
      properties: { a: {}, b: {} }, dependentRequired: { a: ["b"] }, additionalProperties: false,
    } }] },
    async call(_s, _n, args, admit) { admit(); calls++; return args }, async close() {},
  })
  try {
    const source = store.addSource("Fixture", { kind: "demo" })
    const [tool] = await broker.refresh(source.id), caller = store.createCaller("Fixture")
    expect(tool.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
    store.setEnabled(source.id, true); store.grant(caller.id, tool.id, true)
    await expect(broker.call(caller.id, tool.id, { a: true })).rejects.toMatchObject({ code: "invalid_arguments" })
    expect(calls).toBe(0)
    await broker.call(caller.id, tool.id, { a: true, b: true })
    expect(calls).toBe(1)
  } finally { await broker.close(); store.close() }
})
test("larger provider schemas fit the bounded limit; oversized refresh preserves catalog", async () => {
  const store = new Store(":memory:")
  let size = 80 * 1024
  const broker = new Broker(store, {
    async list() { return [{ name: "query", description: "Synthetic large query schema", inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", description: "x".repeat(size), properties: {}, additionalProperties: false,
    } }] },
    async call() { throw Error("No calls expected") }, async close() {},
  })
  try {
    const source = store.addSource("Fixture", { kind: "demo" })
    await broker.refresh(source.id)
    expect(store.tools()).toHaveLength(1)
    size = 130 * 1024
    await expect(broker.refresh(source.id)).rejects.toMatchObject({ code: "unsupported_schema" })
    expect(store.tools()).toHaveLength(1)
    expect((store.tools()[0].inputSchema.description as string).length).toBe(80 * 1024)
  } finally { await broker.close(); store.close() }
})
