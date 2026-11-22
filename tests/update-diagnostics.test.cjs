const test = require("node:test");
const assert = require("node:assert/strict");
const { explainUpdateError } = require("../electron/update-diagnostics.cjs");

test("update errors are classified without disclosing signed CDN URLs or secrets", () => {
  const message = "HttpError: 403 https://release-assets.githubusercontent.com/private?sig=SENSITIVE&jwt=SECRET";
  const error = explainUpdateError({ message, code: "ERR_HTTP" });
  assert.equal(error.category, "permission");
  assert.equal(error.retryable, false);
  assert.ok(!JSON.stringify(error).includes("SENSITIVE"));
  assert.ok(!JSON.stringify(error).includes("SECRET"));
});

test("transient network failures are retryable but integrity failures are not", () => {
  assert.equal(explainUpdateError({ message: "read ECONNRESET" }).retryable, true);
  assert.equal(explainUpdateError({ message: "sha512 checksum mismatch" }).category, "integrity");
  assert.equal(explainUpdateError({ message: "sha512 checksum mismatch" }).retryable, false);
  assert.equal(explainUpdateError({ message: "HTTP 404" }).category, "not-found");
});
