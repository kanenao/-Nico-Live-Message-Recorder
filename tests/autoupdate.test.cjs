const test = require("node:test");
const assert = require("node:assert/strict");
const packageJson = require("../package.json");
const fs = require("node:fs");
const path = require("node:path");

test("production dependencies include electron-updater", () => {
  assert.equal(packageJson.dependencies["electron-updater"], "6.8.12");
});

test("GitHub beta channel is configured for auto-update metadata", () => {
  assert.equal(packageJson.build.generateUpdatesFilesForAllChannels, true);
  assert.deepEqual(packageJson.build.win.publish, [{
    provider: "github",
    owner: "kanenao",
    repo: "nicolive-recorder",
    releaseType: "prerelease",
    channel: "beta"
  }]);
});

test("release build explicitly publishes Windows NSIS update assets", () => {
  assert.match(packageJson.scripts["dist:win:release"], /electron-builder --win nsis zip --publish always/);
});

test("release workflow is tag-triggered and can be run manually", () => {
  const workflowPath = path.join(__dirname, "..", ".github", "workflows", "nicolive-recorder-release.yml");
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});
