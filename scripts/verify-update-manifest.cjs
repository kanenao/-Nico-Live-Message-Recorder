"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

async function validateUpdateManifest(root = path.resolve(__dirname, "..")) {
  const packageJson = require(path.join(root, "package.json"));
  const version = packageJson.version;
  const edition = packageJson.nicoEdition || (String(version).includes("-beta.") ? "beta" : "product");
  const channel = edition === "product" ? "latest" : "beta";
  const versionPattern = edition === "product" ? /^\d+\.\d+\.\d+$/ : /^\d+\.\d+\.\d+-beta\.\d+$/;
  if (!versionPattern.test(version)) {
    throw new Error("Invalid " + channel + " channel package version: " + version);
  }
  const dist = path.join(root, "dist");
  const manifestName = channel + ".yml";
  const manifestPath = path.join(dist, manifestName);
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const versionLine = manifest.split(/\r?\n/).find(line => /^version:\s*/.test(line));
  if (!versionLine || versionLine.replace(/^version:\s*/, "").replace(/['"]/g, "") !== version) {
    throw new Error(manifestName + " version differs from the package version.");
  }
  const installerNames = fs.readdirSync(dist).filter(name => name.toLowerCase().endsWith(".exe") && name.includes(version) && /setup/i.test(name));
  if (installerNames.length !== 1) throw new Error("Expected exactly one versioned NSIS installer.");
  const installer = installerNames[0];
  const candidates = [installer, encodeURI(installer), encodeURIComponent(installer)];
  if (!candidates.some(name => manifest.includes(name))) {
    throw new Error(manifestName + " does not reference the Windows installer (including URL-encoded names).");
  }
  if (!fs.existsSync(path.join(dist, installer + ".blockmap"))) throw new Error("NSIS blockmap is missing.");
  const readable = fs.createReadStream(path.join(dist, installer));
  const digest = createHash("sha512");
  for await (const chunk of readable) digest.update(chunk);
  const sha512 = digest.digest("base64");
  if (!manifest.includes(sha512)) throw new Error(manifestName + " sha512 does not match the NSIS installer.");
  console.log("Verified " + channel + " update manifest, installer and SHA-512:", version, installer);
  return { version, channel, installer };
}

if (require.main === module) {
  validateUpdateManifest().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { validateUpdateManifest };
