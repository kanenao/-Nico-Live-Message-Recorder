"use strict";

function writeCommentLine(writer, line) {
  if (!writer || writer.destroyed || writer.writableEnded) {
    return Promise.reject(new Error("コメントログの書き込み先が閉じています。"));
  }
  return new Promise((resolve, reject) => {
    try {
      // Each JSONL event must end on its own line. An empty write is used
      // by callers as a flush barrier before a live article refresh.
      const value = String(line);
      writer.write(value && /\r?\n$/.test(value) ? value : value + "\n",
        (error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

function finishCommentWriter(writer) {
  if (!writer) return Promise.resolve();
  if (writer.errored) return Promise.reject(writer.errored);
  if (writer.writableFinished) return Promise.resolve();
  if (writer.destroyed || writer.closed) {
    return Promise.reject(new Error("コメントログの書き込み先が終了前に閉じられました。"));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      writer.removeListener("finish", onFinish);
      writer.removeListener("error", onError);
      writer.removeListener("close", onClose);
    };
    const onFinish = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => {
      cleanup();
      reject(new Error("コメントログの書き込み先が終了前に閉じられました。"));
    };
    writer.once("finish", onFinish);
    writer.once("error", onError);
    writer.once("close", onClose);
    try { writer.end(); } catch (error) { cleanup(); reject(error); }
  });
}

module.exports = { writeCommentLine, finishCommentWriter };
