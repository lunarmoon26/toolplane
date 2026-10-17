// Separate process so default bridge environment cannot leak between tests.
import { createServer } from "node:net"
import { Broker } from "../src/broker"
import { Store } from "../src/store"
import { createUpstream } from "../src/upstream"
let requests = 0
const server = createServer(socket => {
  let data = ""
  socket.on("data", chunk => {
    data += chunk.toString()
    if (!data.includes("\0")) return
    const request = JSON.parse(data.split("\0")[0])
    if (request.type !== "execute" || typeof request.code !== "string") throw Error("Invalid bridge request")
    requests++
    socket.end(JSON.stringify({ status: "success", result: { fixture: true }, stdout: "", stderr: "" }) + "\0")
  })
})
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
if (!address || typeof address === "string") throw Error("No TCP fixture port")
process.env.BLENDER_HOST = "127.0.0.1"
process.env.BLENDER_PORT = String(address.port)
const store = new Store(":memory:"), broker = new Broker(store, createUpstream())
try {
  const source = store.addSource("Blender fixture", { kind: "pack", pack: "blender" })
  const tools = await broker.refresh(source.id), caller = store.createCaller("Fixture")
  store.setEnabled(source.id, true)
  const status = tools.find(t => t.name === "blender_status")!, execute = tools.find(t => t.name === "blender")!
  store.grant(caller.id, status.id, true); store.grant(caller.id, execute.id, true)
  const read = await broker.call(caller.id, status.id, {})
  if (!read.result || (read.result as any).structuredContent.result.fixture !== true || requests !== 1) throw Error("Inspection envelope lost")
  const args = { code: "result = {'fixture': True}" }
  const queued = await broker.call(caller.id, execute.id, args)
  if (!queued.approval || requests !== 1) throw Error("Write dispatched without approval")
  store.decideApproval(queued.approval.approvalId, "approved")
  await broker.call(caller.id, execute.id, args, undefined, queued.approval.approvalId)
  if (Number(requests) !== 2) throw Error("Approved write did not dispatch")
  console.log(JSON.stringify({ passed: true, requests }))
} finally {
  await broker.close(); store.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
