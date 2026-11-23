"use strict";

/**
 * Public GitHub Releases are the source of truth for editions and history.
 * Never infer that a stable release is published from a branch or local package.json.
 * URLs are constructed and validated here, never supplied by the renderer.
 */
const REPOSITORY = "kanenao/-Nico-Live-Message-Recorder";
const API_URL = "https://api.github.com/repos/" + REPOSITORY + "/releases?per_page=100";
const RELEASE_ROOT = "https://github.com/" + REPOSITORY + "/releases";
const BETA_VERSION = /^\d+\.\d+\.\d+-beta\.\d+$/;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

function parseEditionReleases(input) {
  if (!Array.isArray(input)) throw new Error("GitHub Releasesの応答が不正です。");
  const result = { beta: [], stable: [] };

  for (const raw of input.slice(0, 100)) {
    if (!raw || typeof raw !== "object" || raw.draft === true) continue;
    const tag = raw.tag_name;
    if (typeof tag !== "string" || !tag.startsWith("v")) continue;
    const version = tag.slice(1);
    const edition = BETA_VERSION.test(version) && raw.prerelease === true
      ? "beta"
      : STABLE_VERSION.test(version) && raw.prerelease === false ? "stable" : null;
    if (!edition) continue;

    const assets = Array.isArray(raw.assets) ? raw.assets : [];
    const installerName = "Nico.Live.Message.Recorder.Setup." + version + ".exe";
    const manifestName = edition === "beta" ? "beta.yml" : "latest.yml";
    const installerUrl = RELEASE_ROOT + "/download/" + tag + "/" + installerName;
    const installer = assets.find(asset =>
      asset && asset.name === installerName &&
      typeof asset.size === "number" && asset.size > 100000 &&
      asset.browser_download_url === installerUrl);
    if (!installer || !assets.some(asset => asset && asset.name === manifestName)) continue;

    result[edition].push({
      edition,
      version,
      title: typeof raw.name === "string" ? raw.name.slice(0, 200) : version,
      publishedAt: typeof raw.published_at === "string" ? raw.published_at : "",
      notes: typeof raw.body === "string" ? raw.body.slice(0, 5000) : "",
      url: RELEASE_ROOT + "/tag/" + tag,
      installerUrl
    });
  }

  for (const edition of ["beta", "stable"]) {
    result[edition].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    result[edition] = result[edition].slice(0, 20);
  }
  return result;
}

function extractChangelogNotes(markdown, version) {
  const allowed = BETA_VERSION.test(version) || STABLE_VERSION.test(version);
  if (!allowed || typeof markdown !== "string") return "";
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const heading = "## " + version;
  let collecting = false;
  const notes = [];
  for (const line of lines) {
    if (line.trim() === heading) {
      collecting = true;
      continue;
    }
    if (collecting && /^##\s+/.test(line)) break;
    if (collecting) notes.push(line);
  }
  const text = notes.join("\n").trim();
  return text.startsWith("- ") || text.includes("\n- ") ? text.slice(0, 5000) : "";
}

async function fetchEditionReleases(fetcher = fetch) {
  const response = await fetcher(API_URL, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Nico-Live-Message-Recorder",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) {
    throw new Error("GitHub Releasesを取得できません（HTTP " + response.status + "）。");
  }
  const result = parseEditionReleases(await response.json());
  // Some published Releases only say "see CHANGELOG.md". Read notes from each
  // release's immutable Git tag so β and stable users can actually see what changed.
  // Failures only affect supplemental notes, not confirmed publication metadata.
  const candidates = [...result.beta.slice(0, 5), ...result.stable.slice(0, 5)]
    .filter(release => !release.notes.trim() || /CHANGELOG\.md|更新内容は/i.test(release.notes));
  await Promise.all(candidates.map(async release => {
    try {
      const url = "https://raw.githubusercontent.com/" + REPOSITORY +
        "/v" + release.version + "/CHANGELOG.md";
      const detail = await fetcher(url, {
        method: "GET",
        headers: { "User-Agent": "Nico-Live-Message-Recorder" },
        signal: AbortSignal.timeout(6000)
      });
      if (!detail.ok) return;
      const notes = extractChangelogNotes(await detail.text(), release.version);
      if (notes) release.notes = notes;
    } catch (_) {
      // Leave the verified release visible with its original release description.
    }
  }));
  return result;
}

module.exports = { REPOSITORY, API_URL, parseEditionReleases, extractChangelogNotes, fetchEditionReleases };
