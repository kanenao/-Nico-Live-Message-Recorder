const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { hasNonEmptyFile } = require("../electron/recording-file.cjs");

test("recording output validation accepts only existing non-empty regular files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nlmr-recording-file-"));
  const nonEmpty = path.join(directory, "recording.ts");
  const empty = path.join(directory, "empty.ts");
  try {
    fs.writeFileSync(nonEmpty, Buffer.from([1, 2, 3]));
    fs.writeFileSync(empty, "");
    assert.equal(hasNonEmptyFile(nonEmpty), true);
    assert.equal(hasNonEmptyFile(empty), false);
    assert.equal(hasNonEmptyFile(path.join(directory, "missing.ts")), false);
    assert.equal(hasNonEmptyFile(directory), false);
    assert.equal(hasNonEmptyFile(""), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("recording output validation safely handles inaccessible or invalid paths", () => {
  assert.equal(hasNonEmptyFile(null), false);
  assert.equal(hasNonEmptyFile(undefined), false);
  assert.equal(hasNonEmptyFile({}), false);
});
