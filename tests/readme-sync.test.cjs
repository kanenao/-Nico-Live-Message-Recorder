import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("README version and recent release history are synchronized", () => {
  const result = spawnSync(process.execPath, ["scripts/update-readme.mjs", "--check"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
