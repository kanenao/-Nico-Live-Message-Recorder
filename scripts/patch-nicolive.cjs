"use strict";

const fs = require("node:fs");

const TIMEOUT_NAMES = ["STREAM_OPENED_TIMEOUT", "STREAM_READY_TIMEOUT"];

function patchNicoLivePluginSource(source) {
  if (typeof source !== "string") {
    throw new TypeError("nicolive.py の内容が文字列ではありません。");
  }

  let patched = source;
  for (const name of TIMEOUT_NAMES) {
    const pattern = new RegExp(
      "^([\\t ]*" + name + "[\\t ]*=[\\t ]*)(\\d+)([\\t ]*(?:#.*)?$)",
      "gm"
    );
    const matches = [...patched.matchAll(pattern)];
    if (matches.length !== 1) {
      throw new Error(
        name + " の定義が1件ではありません（検出数: " + matches.length + "）。" +
        "Streamlink のプラグイン構造が変更された可能性があります。"
      );
    }

    const current = Number(matches[0][2]);
    if (current === 30) continue;
    if (!Number.isInteger(current) || current < 1 || current > 300) {
      throw new Error(
        name + " の既定値が安全な範囲外です（" + current + "）。変更を中止しました。"
      );
    }
    patched = patched.replace(pattern, (_match, prefix, _value, suffix) => prefix + "30" + suffix);
  }

  return patched;
}

function patchNicoLivePluginFile(filePath) {
  if (!filePath) throw new Error("nicolive.py のパスを指定してください。");
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patchNicoLivePluginSource(original);
  if (patched !== original) fs.writeFileSync(filePath, patched, "utf8");
  return { filePath, changed: patched !== original };
}

if (require.main === module) {
  try {
    const result = patchNicoLivePluginFile(process.argv[2]);
    console.log(
      "nicolive.py: STREAM_READY_TIMEOUT=30 / STREAM_OPENED_TIMEOUT=30" +
      (result.changed ? " に変更しました。" : "（変更済み）。")
    );
  } catch (error) {
    console.error("nicolive.py の変更に失敗しました: " + error.message);
    process.exitCode = 1;
  }
}

module.exports = { patchNicoLivePluginSource, patchNicoLivePluginFile };
