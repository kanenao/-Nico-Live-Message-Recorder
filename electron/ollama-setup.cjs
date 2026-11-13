"use strict";

const fs = require("node:fs");
const path = require("node:path");

const OLLAMA_INSTALLER_URL = "https://ollama.com/download/OllamaSetup.exe";

async function downloadOllamaInstaller(options = {}) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Ollamaの自動インストーラー取得はWindows x64版に対応しています。");
  }
  const directory = path.resolve(options.directory || path.join(process.cwd(), "ollama"));
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, "OllamaSetup.exe");
  const partial = destination + ".download";
  fs.rmSync(partial, { force: true });
  const response = await fetch(OLLAMA_INSTALLER_URL, {
    redirect: "follow",
    headers: { "User-Agent": "Nico-Live-Message-Recorder" }
  });
  if (!response.ok || !response.body) {
    throw new Error("Ollamaインストーラーの取得に失敗しました（HTTP " + response.status + "）。");
  }
  const total = Number(response.headers.get("content-length")) || 0;
  const file = fs.createWriteStream(partial, { flags: "wx" });
  let received = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((resolve, reject) => file.write(Buffer.from(value), error => error ? reject(error) : resolve()));
      received += value.byteLength;
      if (typeof options.onProgress === "function") {
        options.onProgress({ stage: "installer", received, total, percent: total ? Math.min(99, Math.floor(received / total * 100)) : 0 });
      }
    }
    await new Promise((resolve, reject) => file.end(error => error ? reject(error) : resolve()));
  } catch (error) {
    file.destroy();
    fs.rmSync(partial, { force: true });
    throw error;
  }
  const stat = fs.statSync(partial);
  if (stat.size < 5 * 1024 * 1024) {
    fs.rmSync(partial, { force: true });
    throw new Error("Ollamaインストーラーのサイズが不正です。ダウンロードを中止しました。");
  }
  fs.renameSync(partial, destination);
  if (typeof options.onProgress === "function") {
    options.onProgress({ stage: "installer", received, total: total || received, percent: 100 });
  }
  return destination;
}

function normalizeModelName(value) {
  const model = String(value || "").trim();
  if (!model || model.length > 120 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) {
    throw new Error("AIモデル名が正しくありません。例：qwen2.5:3b");
  }
  return model;
}

async function pullOllamaModel(options = {}) {
  const baseUrl = String(options.baseUrl || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
  const model = normalizeModelName(options.model || "qwen2.5:3b");
  let url;
  try {
    url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
  } catch (_) {
    throw new Error("Ollama接続先URLが正しくありません。");
  }
  let response;
  try {
    response = await fetch(url.toString().replace(/\/+$/, "") + "/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: true })
    });
  } catch (_) {
    throw new Error("Ollamaに接続できません。先に公式インストーラーでOllamaをインストールして起動してください。");
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error("モデルのダウンロードを開始できません（HTTP " + response.status + "）。" + detail.slice(0, 300));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let latest = { model, status: "ダウンロード開始" };
  const consume = line => {
    if (!line.trim()) return;
    let item;
    try { item = JSON.parse(line); } catch (_) { return; }
    if (item.error) throw new Error(String(item.error));
    latest = {
      model,
      status: String(item.status || "取得中"),
      completed: Number(item.completed) || 0,
      total: Number(item.total) || 0
    };
    if (typeof options.onProgress === "function") options.onProgress({ stage: "model", ...latest });
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) consume(line);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
  } catch (error) {
    throw new Error("Ollamaモデルの取得に失敗しました: " + (error.message || String(error)));
  }
  if (latest.status !== "success") {
    throw new Error("モデルの取得が完了しませんでした。Ollamaの状態を確認してください。");
  }
  return { model, installed: true };
}

module.exports = { OLLAMA_INSTALLER_URL, normalizeModelName, downloadOllamaInstaller, pullOllamaModel };
