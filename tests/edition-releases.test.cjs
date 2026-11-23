const test = require("node:test");
const assert = require("node:assert/strict");
const { parseEditionReleases, extractChangelogNotes, fetchEditionReleases, API_URL } = require("../electron/edition-releases.cjs");

function release(version, edition = "beta", opts = {}) {
  const tag = "v" + version;
  const installer = "Nico.Live.Message.Recorder.Setup." + version + ".exe";
  return {
    tag_name: tag,
    draft: false,
    prerelease: edition === "beta",
    name: "Nico Live Message Recorder " + tag,
    body: "修正と機能追加",
    published_at: opts.date || "2026-11-23T06:00:00Z",
    assets: [
      { name: installer, size: 160000000,
        browser_download_url: "https://github.com/kanenao/-Nico-Live-Message-Recorder/releases/download/" + tag + "/" + installer },
      { name: edition === "beta" ? "beta.yml" : "latest.yml", size: 400 }
    ],
    ...opts
  };
}

test("public beta and stable releases are shown in separate lists", () => {
  const result = parseEditionReleases([
    release("1.0.1-beta.139"),
    release("1.0.0", "stable"),
    release("0.8.4-alpha.137"),
    release("1.1.0-beta.140", "beta", { draft: true })
  ]);
  assert.deepEqual(result.beta.map(item => item.version), ["1.0.1-beta.139"]);
  assert.deepEqual(result.stable.map(item => item.version), ["1.0.0"]);
  assert.match(result.beta[0].installerUrl, /^https:\/\/github\.com\/kanenao\/-Nico-Live-Message-Recorder\/releases\/download\//);
});

test("missing installers, wrong URLs and missing channel metadata cannot be advertised", () => {
  const wrongUrl = release("1.0.1-beta.139");
  wrongUrl.assets[0].browser_download_url = "https://other.example/download.exe";
  const noManifest = release("1.0.0", "stable");
  noManifest.assets.pop();
  const noInstaller = release("1.0.2-beta.140");
  noInstaller.assets.shift();
  assert.deepEqual(parseEditionReleases([wrongUrl, noManifest, noInstaller]), { beta: [], stable: [] });
});

test("entries are sorted by publication date and bad responses throw", () => {
  const result = parseEditionReleases([
    release("1.0.1-beta.139", "beta", { date: "2026-11-21T06:00:00Z" }),
    release("1.0.2-beta.140", "beta", { date: "2026-11-23T06:00:00Z" })
  ]);
  assert.equal(result.beta[0].version, "1.0.2-beta.140");
  assert.throws(() => parseEditionReleases({}), /応答が不正/);
});

test("fetch uses one fixed official API and reports network errors", async () => {
  const sample = release("1.0.0", "stable");
  const value = await fetchEditionReleases(async (url, init) => {
    assert.equal(url, API_URL);
    assert.equal(init.headers["User-Agent"], "Nico-Live-Message-Recorder");
    return { ok: true, json: async () => [sample] };
  });
  assert.equal(value.stable.length, 1);
  await assert.rejects(
    fetchEditionReleases(async () => ({ ok: false, status: 403 })),
    /HTTP 403/
  );
});

test("tagged CHANGELOG notes are used when a published beta or stable release has generic notes", async () => {
  const beta = release("1.0.1-beta.139", "beta", { body: "詳細はCHANGELOG.mdを参照してください。" });
  const stable = release("1.0.0", "stable", { body: "" });
  let rawDownloads = 0;
  const result = await fetchEditionReleases(async (url) => {
    if (url === API_URL) return { ok: true, json: async () => [beta, stable] };
    rawDownloads++;
    if (url.endsWith("/v1.0.1-beta.139/CHANGELOG.md")) {
      return { ok: true, text: async () => "## 1.0.1-beta.139\n\n- **β版**：画面改善\n\n## 1.0.1-beta.138\n\n- previous" };
    }
    if (url.endsWith("/v1.0.0/CHANGELOG.md")) {
      return { ok: true, text: async () => "## 1.0.0\n\n- **製品版**：安定化\n" };
    }
    throw new Error("Unexpected external source: " + url);
  });
  assert.equal(rawDownloads, 2);
  assert.equal(result.beta[0].notes, "- **β版**：画面改善");
  assert.equal(result.stable[0].notes, "- **製品版**：安定化");
  assert.equal(extractChangelogNotes("## 1.0.0\n\n- foo\n\n## 1.0.1\n- bar", "1.0.0"), "- foo");
});
