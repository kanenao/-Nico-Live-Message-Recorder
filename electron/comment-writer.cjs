"use strict";

function writeCommentLine(writer, line) {
  if (!writer || writer.destroyed || writer.writableEnded) {
    return Promise.reject(new Error("コメントログの書き込み先が閉じています。"));
  }
  return new Promise((resolve, reject) => {
    try {
      writer.write(String(line), (error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

function finishCommentWriter(writer) {
  if (!writer) return Promise.resolve();
  if (writer.errored) return Promise.reject(writer.errored);
  if (writer.writableFinished) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      writer.removeListener("finish", onFinish);
      writer.removeListener("error", onError);
    };
    const onFinish = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    writer.once("finish", onFinish);
    writer.once("error", onError);
    try { writer.end(); } catch (error) { cleanup(); reject(error); }
  });
}

module.exports = { writeCommentLine, finishCommentWriter };
