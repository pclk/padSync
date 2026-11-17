import { expect, it } from "vitest";
import { BridgeApi, MAX_OUTPUT, prepareJobDir, removeJobDir } from "../bridge/lib";

it("does not split a surrogate pair at the bridge output limit", async () => {
  let body = "";
  const api = new BridgeApi({ server: "https://example.com", token: "test" }, async (_url, init) => {
    body = String(init?.body);
    return Response.json({ status: "running", cancelled: false });
  });
  await api.update("job", { output: "a".repeat(MAX_OUTPUT - 1) + "😀" });
  expect(JSON.parse(body).output.length).toBe(MAX_OUTPUT - 1);
});

it.skipIf(process.platform !== "darwin")("rejects case-insensitive input path collisions on macOS", async () => {
  let dir: string | undefined;
  try {
    await expect(prepareJobDir({ image: null, context: "", files: [
      { path: "A.txt", mime: "text/plain", text: "a" },
      { path: "a.txt", mime: "text/plain", text: "b" },
    ] }).then(d => { dir = d.dir; })).rejects.toThrow();
  } finally {
    if (dir) await removeJobDir(dir);
  }
});

it("does not start an already cancelled agent", async () => {
  const { runAgent } = await import("../bridge/lib");
  const result = await runAgent({ cwd: process.cwd(), prompt: "", command: { bin: "/does-not-exist", args: [], parse: () => null }, timeoutMs: 1000, signal: AbortSignal.abort(), onText: () => {} });
  expect(result.status).toBe("cancelled");
});

it("bounds streamed output before notifying the bridge", async () => {
  const { runAgent } = await import("../bridge/lib");
  let longest = 0;
  const result = await runAgent({ cwd: process.cwd(), prompt: "", command: {
    bin: process.execPath, args: ["-e", 'console.log(JSON.stringify({text:"x".repeat(300000)}))'], parse: line => JSON.parse(line),
  }, timeoutMs: 5000, onText: text => { longest = Math.max(longest, text.length); } });
  expect(result.status).toBe("done");
  expect(longest).toBeLessThanOrEqual(MAX_OUTPUT);
  expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT);
});

it("does not follow the agent final-message symlink", async () => {
  const { mkdtemp, writeFile, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runAgent } = await import("../bridge/lib");
  const root = await mkdtemp(join(tmpdir(), "padsync-test-"));
  try {
    await writeFile(join(root, "private.txt"), "private secret");
    await symlink(join(root, "private.txt"), join(root, "final.md"));
    const result = await runAgent({ cwd: root, prompt: "", command: { bin: process.execPath, args: ["-e", ""], parse: () => null, finalFile: "final.md" }, timeoutMs: 5000, onText: () => {} });
    expect(result.output).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("timeout terminates descendants holding inherited output pipes", async () => {
  const { runAgent } = await import("../bridge/lib");
  const start = Date.now();
  const result = await runAgent({ cwd: process.cwd(), prompt: "", command: {
    bin: process.execPath,
    args: ["-e", 'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{}, 1500)"],{stdio:"inherit"}); setInterval(()=>{},1000)'],
    parse: () => null,
  }, timeoutMs: 200, onText: () => {} });
  expect(result.status).toBe("error");
  expect(Date.now() - start).toBeLessThan(1100);
});

it("parses JSON lines split across chunks including the final unterminated line", async () => {
  const { runAgent, parseCodexLine } = await import("../bridge/lib");
  const result = await runAgent({ cwd: process.cwd(), prompt: "", command: {
    bin: process.execPath, args: ["-e", 'process.stdout.write(\'{"type":"item.com\'); setTimeout(()=>process.stdout.write(\'pleted","item":{"type":"agent_message","text":"😀"}}\'),30)'], parse: parseCodexLine,
  }, timeoutMs: 5000, onText: () => {} });
  expect(result.output).toBe("😀");
});
