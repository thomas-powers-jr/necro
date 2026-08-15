import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { scan } from "../src/engine/index.js";
import { createNecroServer } from "../src/mcp/server.js";
import { toJson } from "../src/report/json.js";

/** First text block of a tool result. */
function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  const block = result.content?.find((c) => c.type === "text");
  return block?.text ?? "";
}

/** Connect a fresh in-process client to a fresh necro MCP server over a linked
 * in-memory transport pair (no stdio, no subprocess). */
async function connectClient(deps?: Parameters<typeof createNecroServer>[0]): Promise<Client> {
  const server = createNecroServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("necro MCP server", () => {
  test("completes the MCP handshake exposing the necro server identity (AC-1)", async () => {
    const client = await connectClient();
    expect(client.getServerVersion()?.name).toBe("necro");
  });

  test("exposes exactly the read-only tools — no mutating or LLM tool (AC-1, AC-4)", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "necro_explain",
      "necro_scan",
      "necro_verify",
      "necro_verify_removal",
    ]);
  });

  test("malformed tool input is a structured error and the server stays alive (AC-4)", async () => {
    const client = await connectClient();
    let errored = false;
    try {
      // `edits` must be a non-empty array of {file, content}; a string violates the schema.
      const r = (await client.callTool({ name: "necro_verify", arguments: { edits: "nope" } })) as {
        isError?: boolean;
      };
      errored = r.isError === true;
    } catch {
      errored = true; // rejected with a structured McpError
    }
    expect(errored).toBe(true);
    // The server still serves a subsequent valid request.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("necro_verify");
  });

  describe("necro_scan", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "necro-mcp-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("is listed as a tool (AC-1)", async () => {
      const client = await connectClient();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("necro_scan");
    });

    test("returns exactly `scan() + toJson()` for the same path — no logic fork (AC-2)", async () => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fx" }));
      await writeFile(join(dir, "util.ts"), "function dead() { return 1; }\nexport const used = 2;\n");

      // The tool loads config relative to the scan target, not the server cwd.
      const cfg = await loadConfig(dir);
      const { findings, complexity, hotspots, duplication } = await scan(dir, cfg);
      const expected = toJson({ findings, complexity, hotspots, duplication });

      const client = await connectClient();
      const result = await client.callTool({ name: "necro_scan", arguments: { path: dir } });
      expect(textOf(result as { content?: Array<{ type: string; text?: string }> })).toBe(expected);
    });

    test("resolves necro.config.json from the scan target, not the server cwd (AC-2)", async () => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fx" }));
      await writeFile(join(dir, "ignored.ts"), "function dead() { return 1; }\n");
      await writeFile(
        join(dir, "necro.config.json"),
        JSON.stringify({ ignore: ["**/node_modules/**", "**/dist/**", "ignored.ts"] }),
      );

      const client = await connectClient();
      const result = await client.callTool({ name: "necro_scan", arguments: { path: dir } });
      const parsed = JSON.parse(textOf(result as { content?: Array<{ type: string; text?: string }> })) as {
        findings: Array<{ file?: string }>;
      };
      expect(parsed.findings.some((f) => f.file?.includes("ignored.ts"))).toBe(false);
    });
  });

  describe("necro_verify", () => {
    /** A fake VerifyRunner that records the orchestration order and lets the test
     * choose the check outcome. */
    function recordingRunner(checkOk: boolean) {
      const events: string[] = [];
      const runner = {
        async createWorktree() {
          events.push("create");
          return "/wt";
        },
        async writeEdit(_wt: string, edit: { file: string; content: string }) {
          events.push(`write:${edit.file}`);
        },
        async runCheck(_wt: string, command: string) {
          events.push(`check:${command}`);
          return { ok: checkOk, output: checkOk ? "" : "tsc: error TS1234" };
        },
        async removeWorktree() {
          events.push("remove");
        },
      };
      return { runner, events };
    }

    test("is listed as a tool (AC-1)", async () => {
      const client = await connectClient();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("necro_verify");
    });

    test("description carries a duration hint for the typecheck+test cycle (AC-3)", async () => {
      const client = await connectClient();
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "necro_verify");
      expect(tool?.description).toMatch(/minutes/);
    });

    test("applies edits in an isolated worktree, runs checks, tears down — green (AC-3)", async () => {
      const { runner, events } = recordingRunner(true);
      const client = await connectClient({ runnerFactory: () => runner });
      const result = await client.callTool({
        name: "necro_verify",
        arguments: { edits: [{ file: "a.ts", content: "export const x = 1;" }], checks: ["echo hi"] },
      });
      expect(JSON.parse(textOf(result as { content?: Array<{ type: string; text?: string }> }))).toEqual({
        ok: true,
        output: "",
      });
      expect(events).toEqual(["create", "write:a.ts", "check:echo hi", "remove"]);
    });

    test("a failing check yields ok:false with output, worktree still removed (AC-3)", async () => {
      const { runner, events } = recordingRunner(false);
      const client = await connectClient({ runnerFactory: () => runner });
      const result = await client.callTool({
        name: "necro_verify",
        arguments: { edits: [{ file: "a.ts", content: "bad" }], checks: ["npm run typecheck"] },
      });
      const out = JSON.parse(textOf(result as { content?: Array<{ type: string; text?: string }> }));
      expect(out.ok).toBe(false);
      expect(out.output).toContain("TS1234");
      expect(events).toContain("remove"); // torn down despite the red check
    });
  });

  describe("README MCP docs (AC-3)", () => {
    test("shows a `claude mcp add` one-liner alongside the JSON registration snippet", async () => {
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
      const readme = await readFile(join(repoRoot, "README.md"), "utf8");
      expect(readme).toContain("claude mcp add necro -- npx -y @thomas-powers-jr/necro mcp");
    });
  });
});
