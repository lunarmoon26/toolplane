import { Buffer } from "node:buffer"
import net from "node:net"

export type BlenderBridge = { host: string; port: number }

export function resolveBlenderBridge(environment = process.env): BlenderBridge {
  const host = environment.BLENDER_HOST?.trim() || "127.0.0.1"
  const configuredPort = environment.BLENDER_PORT
  if (!configuredPort) return { host, port: 9876 }
  if (!/^[1-9]\d{0,4}$/.test(configuredPort)) throw new Error("BLENDER_PORT must be an integer between 1 and 65535")
  const port = Number(configuredPort)
  if (port > 65535) throw new Error("BLENDER_PORT must be an integer between 1 and 65535")
  return { host, port }
}

export const blenderBridge = resolveBlenderBridge()

const timeoutMs = 15_000
const maxResponseBytes = 10 * 1024 * 1024

export type BridgeResponse = {
  status?: string
  result?: unknown
  message?: string
  stdout?: string
  stderr?: string
}

export function executeBlenderCode(code: string, bridge: BlenderBridge = blenderBridge): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(bridge)
    let responseBuffer = Buffer.alloc(0)
    let settled = false

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }

    socket.setTimeout(timeoutMs)
    socket.once("connect", () => {
      socket.write(JSON.stringify({ type: "execute", code, strict_json: true }) + "\0")
    })
    socket.on("data", (chunk) => {
      if (typeof chunk === "string") chunk = Buffer.from(chunk)
      if (responseBuffer.length + chunk.length > maxResponseBytes) {
        fail(new Error(`Blender MCP bridge response exceeds ${maxResponseBytes} bytes`))
        return
      }
      responseBuffer = Buffer.concat([responseBuffer, chunk])
      const delimiter = responseBuffer.indexOf(0)
      if (delimiter < 0 || settled) return

      try {
        const response = JSON.parse(responseBuffer.subarray(0, delimiter).toString("utf8")) as BridgeResponse
        settled = true
        socket.end()
        resolve(response)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.once("timeout", () => fail(new Error(`Blender MCP bridge timed out after ${timeoutMs}ms`)))
    socket.once("error", fail)
    socket.once("close", () => {
      if (!settled) fail(new Error("Blender MCP bridge closed before returning a response"))
    })
  })
}
