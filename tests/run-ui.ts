// Fixture-only launcher; the UI test must never target a real registry.
export {}
const server = Bun.spawn([process.execPath, "tests/ui_server.ts"], { stdout: "pipe", stderr: "inherit" })
try {
  const reader = server.stdout.getReader()
  let line = ""
  while (!line.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error("UI fixture exited before startup")
    line += new TextDecoder().decode(chunk.value)
  }
  const { url } = JSON.parse(line.split("\n")[0]) as { url: string }
  const test = Bun.spawn(["uv", "run", "--with", "playwright==1.63.0", "python", "tests/ui_smoke.py"], { stdout: "inherit", stderr: "inherit", env: { ...process.env, TOOLPLANE_UI_URL: url } })
  process.exitCode = await test.exited
} finally {
  server.kill("SIGTERM")
  await server.exited
}
