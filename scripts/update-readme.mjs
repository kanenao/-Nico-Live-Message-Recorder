import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = path.join(root, "README.md");
const changelogPath = path.join(root, "CHANGELOG.md");
const packagePath = path.join(root, "package.json");
const version = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
const changelog = fs.readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n");
let readme = fs.readFileSync(readmePath, "utf8").replace(/\r\n/g, "\n");

const entries = [];
let current = null;
for (const line of changelog.split("\n")) {
  const heading = line.match(/^## (0\.1\.0-beta\.\d+)\s*$/);
  if (heading) {
    if (current) entries.push(current);
    current = { version: heading[1], bullets: [] };
    continue;
  }
  if (current && /^## /.test(line)) {
    entries.push(current);
    current = null;
    continue;
  }
  if (current && /^- /.test(line)) current.bullets.push(line.slice(2).trim());
}
if (current) entries.push(current);
if (!entries.some((entry) => entry.version === version)) {
  throw new Error("CHANGELOG.md does not contain package version " + version);
}

const recent = entries.slice(0, 8);
const generated = [
  "<!-- AUTO-GENERATED: RELEASE-INFO:START -->",
  "## 現在のβ版と最近の更新",
  "",
  "**現在のβ版：" + version + "**",
  "",
  "最新の更新内容を" + recent.length + "バージョン分掲載しています。過去の全履歴は [CHANGELOG.md](CHANGELOG.md) をご覧ください。",
  "",
  ...recent.flatMap((entry) => [
    "### " + entry.version,
    ...(entry.bullets.length ? entry.bullets.map((bullet) => "- " + bullet) : ["- 詳細はCHANGELOG.mdを参照してください。"]),
    ""
  ]),
  "[すべてのバージョン更新履歴を見る](CHANGELOG.md)",
  "<!-- AUTO-GENERATED: RELEASE-INFO:END -->"
].join("\n");

const tick = String.fromCharCode(96);
const versionLinePattern = new RegExp("\\*\\*β版開発ブランチ：" + tick + "beta" + tick + "（現在 [^）]+）\\*\\*");
const currentVersionLine = "**β版開発ブランチ：" + tick + "beta" + tick + "（現在 " + version + "）**";
readme = readme.replace(versionLinePattern, currentVersionLine);
const marker = /<!-- AUTO-GENERATED: RELEASE-INFO:START -->[\s\S]*?<!-- AUTO-GENERATED: RELEASE-INFO:END -->/;
if (marker.test(readme)) {
  readme = readme.replace(marker, generated);
} else {
  if (!readme.includes(currentVersionLine)) throw new Error("Could not locate README beta version line.");
  readme = readme.replace(currentVersionLine, currentVersionLine + "\n\n" + generated);
}
readme = readme.replace(/^## 更新履歴\s*$/m, "## 初期β版の更新履歴（β41以前）");

if (process.argv.includes("--check")) {
  const existing = fs.readFileSync(readmePath, "utf8").replace(/\r\n/g, "\n");
  if (readme !== existing) {
    console.error("README.md is out of date. Run npm run docs:update.");
    process.exitCode = 1;
  } else {
    console.log("README.md is synchronized with " + version + " and CHANGELOG.md.");
  }
} else {
  fs.writeFileSync(readmePath, readme);
  console.log("README.md updated for " + version + ".");
}
