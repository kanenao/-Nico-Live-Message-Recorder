const test = require("node:test");
const assert = require("node:assert/strict");
const packageJson = require("../package.json");
const fs = require("node:fs");
const path = require("node:path");

test("production dependencies include electron-updater", () => {
  assert.equal(packageJson.dependencies["electron-updater"], "6.8.12");
});

test("GitHub alpha channel is configured for auto-update metadata", () => {
  assert.equal(packageJson.build.generateUpdatesFilesForAllChannels, true);
  assert.deepEqual(packageJson.build.win.publish, [{
    provider: "github",
    owner: "kanenao",
    repo: "-Nico-Live-Message-Recorder",
    releaseType: "prerelease",
    channel: "alpha"
  }]);
});

test("release build explicitly publishes Windows NSIS update assets", () => {
  assert.match(packageJson.scripts["dist:win:release"], /electron-builder --win nsis zip --publish always/);
});

test("auto-update is enabled only for the registered NSIS install location", () => {
  const installerScript = fs.readFileSync(path.join(__dirname, "..", "build", "installer.nsh"), "utf8");
  const mainProcess = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(installerScript, /WriteRegStr SHELL_CONTEXT .*InstallLocation/);
  assert.match(installerScript, /WriteRegStr SHELL_CONTEXT .*InstallType.*NSIS/);
  assert.match(installerScript, /DeleteRegKey SHELL_CONTEXT/);
  assert.equal(packageJson.build.nsis.include, "build/installer.nsh");
  assert.ok(mainProcess.includes("function isNsisInstalled()"));
  assert.ok(mainProcess.includes("return isNsisInstalled()"));
  assert.match(mainProcess, /HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall/);
  assert.match(mainProcess, /HKLM\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall/);
  assert.match(mainProcess, /UninstallString/);
  assert.match(mainProcess, /isExecutableInsideInstallDirectory/);
});

test("main and renderer JavaScript files pass Node syntax checks", () => {
  const { execFileSync } = require("node:child_process");
  for (const file of ["electron/main.cjs", "electron/preload.cjs", "electron/monitor.cjs", "renderer.js"]) {
    const sourcePath = path.join(__dirname, "..", file);
    execFileSync(process.execPath, ["--check", sourcePath], { stdio: "pipe" });
  }
});

test("release workflow is tag-triggered and can be run manually", () => {
  const workflowPath = path.join(__dirname, "..", ".github", "workflows", "nicolive-recorder-release.yml");
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /tags:\s*\n\s*- "v\*-alpha\*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});


test("unsupported update mode is visible to the user", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer.js"), "utf8");
  assert.match(renderer, /case "unsupported":[\s\S]*payload\.message/);
  const mainProcess = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(mainProcess, /sendUpdateState\("unsupported"/);
});

test("alpha update download is preserved and installs on safe app exit", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(main, /autoUpdater\.autoInstallOnAppQuit = true/);
  assert.match(main, /if \(downloadedUpdateInfo\) \{[\s\S]*?downloaded: true/);
  const handler = main.slice(main.indexOf('ipcMain.handle("updates:install"'), main.indexOf("async function getNicoAuthCookies()"));
  assert.match(handler, /await shutdownGracefully\(\);[\s\S]*?isQuitting = true;\s*autoUpdater\.quitAndInstall\(false, true\)/);
  assert.match(main, /closeToTray && !isQuitting/);
});

test("alpha full-download fallback is wired through main, preload and renderer", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(main, /autoUpdater\.disableDifferentialDownload = true/);
  assert.match(main, /automaticUpdateRetryUsed = true/);
  assert.match(main, /ipcMain\.handle\("updates:retry-download", \(\) => retryUpdateDownloadNow\(\)\)/);
  assert.match(preload, /retryUpdateDownload: \(\) => ipcRenderer\.invoke\("updates:retry-download"\)/);
  assert.match(renderer, /async function retryAppUpdateDownload\(\)/);
  assert.match(renderer, /case "retrying":/);
  assert.match(renderer, /api\.retryUpdateDownload\(\)/);
  for (const id of ["retry-update-download-button","settings-retry-update-download-button","update-releases-button"]) {
    assert.ok(html.includes('id="' + id + '"'), "Missing user recovery button: " + id);
  }
});

test("Windows alpha release CI verifies update metadata and NSIS SHA-512 before publishing", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "nicolive-recorder-build.yml"), "utf8");
  const validator = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-update-manifest.cjs"), "utf8");
  const step = workflow.indexOf("- name: Verify alpha update manifest and installer checksum");
  assert.ok(step >= 0);
  assert.ok(step > workflow.indexOf("- name: Build installer and portable ZIP"));
  assert.ok(step < workflow.indexOf("- name: Upload Windows build"));
  assert.match(validator, /createHash\("sha512"\)/);
  assert.match(validator, /alpha\.yml/);
  assert.match(validator, /blockmap/);
});
