function normalizeUserSessionInput(input) {
  let value = String(input === undefined || input === null ? "" : input).trim();
  if (/^user_session=/i.test(value)) value = value.slice(value.indexOf("=") + 1).trim();
  if (!value) return "";
  if (value.length > 4096) throw new Error("user_sessionは4096文字以内で入力してください。");
  if (/[\s;,\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("user_sessionには空白・改行・セミコロン・カンマを含められません。CookieのValueだけを入力してください。");
  }
  return value;
}

module.exports = { normalizeUserSessionInput };
