"use strict";

// Every nonempty line is an independent JavaScript regular expression.
// Raw patterns are case-insensitive. The /pattern/flags syntax is also
// accepted, with only stateless flags allowed.
const MAX_RULES = 40;
const MAX_TEXT_LENGTH = 4000;
const MAX_RULE_LENGTH = 240;

function compileAssNgRegex(value) {
  const input = String(value == null ? "" : value).replace(/\r\n?/g, "\n");
  if (input.length > MAX_TEXT_LENGTH) {
    throw new Error("ASSのNGワード設定は4000文字以内にしてください。");
  }
  const rules = [];
  const lines = input.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (rules.length >= MAX_RULES) throw new Error("ASSのNGワードは最大40行までです。");
    if (line.length > MAX_RULE_LENGTH) {
      throw new Error("ASSのNGワード " + (index + 1) + " 行目は240文字以内にしてください。");
    }
    const match = line.match(/^\/([\s\S]*)\/([a-z]*)$/i);
    const pattern = match ? match[1] : line;
    const flags = match ? match[2] : "i";
    if (match && (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length)) {
      throw new Error("ASSのNGワード " + (index + 1) + " 行目のフラグが正しくありません。利用可能: i, m, s, u");
    }
    // Basic mitigation for potentially catastrophic nested repetition.
    if (/\([^)]{0,120}[+*][^)]{0,120}\)(?:[+*]|\{\d)/.test(pattern) ||
        /\\[1-9]/.test(pattern)) {
      throw new Error("ASSのNGワード " + (index + 1) + " 行目は負荷の高い正規表現です。繰り返しの入れ子・後方参照を避けてください。");
    }
    try {
      rules.push(new RegExp(pattern, flags));
    } catch (error) {
      throw new Error("ASSのNGワード " + (index + 1) + " 行目の正規表現が不正です: " + error.message);
    }
  }
  return rules;
}

function isAssNgComment(content, compiledRules) {
  const text = String(content == null ? "" : content);
  // Match the original comment, not the escaped ASS script.
  // Limit input to avoid processing excessively large non-comment payloads.
  const sample = text.slice(0, 4000);
  return compiledRules.some(rule => rule.test(sample));
}

module.exports = { compileAssNgRegex, isAssNgComment };
