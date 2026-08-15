import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url));
const action = readFileSync(root(".github/actions/necro/action.yml"), "utf8");
const workflow = readFileSync(root(".github/workflows/necro-scan.yml"), "utf8");

describe("necro composite Action", () => {
  test("is a composite action declaring the documented inputs (AC-2)", () => {
    expect(action).toMatch(/using:\s*composite/);
    for (const input of ["path:", "fail-on:", "sarif-file:", "version:"]) {
      expect(action).toContain(input);
    }
  });

  test("runs necro with --sarif and conditional --fail-on (AC-2)", () => {
    expect(action).toContain("@thomas-powers-jr/necro");
    expect(action).toContain("--sarif");
    expect(action).toContain("--fail-on");
    // fail-on is only appended when non-empty (surface-only when unset)
    expect(action).toMatch(/if \[ -n "\$NECRO_FAIL_ON" \]/);
  });

  test("uploads the SARIF to code-scanning, even on gate failure (AC-2)", () => {
    expect(action).toContain("github/codeql-action/upload-sarif");
    expect(action).toMatch(/always\(\)/);
  });

  test("dogfood workflow runs the local action on PRs with SARIF perms (AC-2)", () => {
    expect(workflow).toMatch(/pull_request/);
    expect(workflow).toMatch(/security-events:\s*write/);
    expect(workflow).toContain("uses: ./.github/actions/necro");
  });
});
