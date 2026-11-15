"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

async function validateUpdateManifest(root = path.resolve(__dirname, "..")) {
  const version = require(path.join(root, "package.json")).version;
  if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(version)) throw new Error("Only an alpha version may enter the alpha release channel.");
  const dist = path.join(root, "dist");
  const manifestPath = path.join(dist, "alpha.yml");
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp("^version:\\s*[\x27\x22]?" + escaped + "[\x27\x22]?\\s*$", "m").test(manifest)) {
    throw new Error("alpha.yml version differs from the package version.");
  }
  const installerNames = fs.readdirSync(dist).filter(name => name.toLowerCase().endsWith(".exe") && name.includes(version) && /setup/i.test(name));
  if (installerNames.length !== 1) throw new Error("Expected exactly one versioned NSIS installer.");
  const installer = installerNames[0];
  // electron-builder URL-encodes spaces in alpha.yml but keeps literal spaces on disk.
  const candidates = [installer, encodeURI(installer), encodeURIComponent(installer)];
  if (!candidates.some(name => manifest.includes(name))) {
    throw new Error("alpha.yml does not reference the Windows installer (including URL-encoded names).");
  }
  if (!fs.existsSync(path.join(dist, installer + ".blockmap"))) throw new Error("NSIS blockmap is missing.");
  const readable = fs.createReadStream(path.join(dist, installer));
  const digest = createHash("sha512");
  for await (const chunk of readable) digest.update(chunk);
  const sha512 = digest.digest("base64");
  if (!manifest.includes(sha512)) throw new Error("alpha.yml sha512 does not match the NSIS installer.");
  console.log("Verified alpha update manifest, installer and SHA-512:", version, installer);
  return { version, installer };
}

if (require.main === module) {
  validateUpdateManifest().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { validateUpdateManifest };
