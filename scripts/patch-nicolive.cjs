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

// Opt-in only. The upstream plugin supports normal live and archive
// playback but does not expose its chasePlay request as a CLI option.
function patchNicoLiveChaseSource(source) {
  if (typeof source !== "string") throw new TypeError("nicolive.py の形式が不正です。");
  const marker = 'argument_name="niconico-chase-play"';
  const flag = '"chasePlay": getattr(self, "nlmr_chase_play", False),';
  const assignment = '        self.wsclient.nlmr_chase_play = bool(self.get_option("chase-play"))';
  if (source.includes(marker)) {
    if (source.split(marker).length !== 2 ||
        source.split(flag).length !== 3 ||
        source.split(assignment).length !== 2) {
      throw new Error("追っかけ録画パッチの適用状態が不完全です。");
    }
    return source;
  }
  const decorator = '@pluginargument(\n    "timeshift-offset",';
  const client = '        self.wsclient = NicoLiveWsClient(self.session, wss_api_url)\n';
  const flags = '"chasePlay": False,';
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.split(decorator).length !== 2 ||
      normalized.split(client).length !== 2 ||
      normalized.split(flags).length !== 3) {
    throw new Error("nicolive.py の追っかけ再生定義を安全に確認できません。");
  }
  return normalized.replace(decorator,
    '@pluginargument(\n    "chase-play",\n    argument_name="niconico-chase-play",\n' +
    '    action="store_true",\n    help="Request authorized Nico Live chase playback.",\n)\n' + decorator)
    .replace(client, client + assignment + "\n")
    .replaceAll(flags, flag).replace(/\n/g, nl);
}

function patchNicoLivePluginFile(filePath) {
  if (!filePath) throw new Error("nicolive.py のパスを指定してください。");
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patchNicoLiveChaseSource(patchNicoLivePluginSource(original));
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

module.exports = { patchNicoLivePluginSource, patchNicoLiveChaseSource, patchNicoLivePluginFile };
