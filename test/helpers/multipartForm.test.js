const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMultipartBody,
  escapeQuotedHeaderValue,
  sanitizeContentType,
} = require("../../src/helpers/multipartForm");

test("multipart encoder prevents filenames from creating injected headers", () => {
  const { body, boundary } = buildMultipartBody(
    Buffer.from("audio"),
    'recording"\r\nX-Injected: yes.webm',
    "audio/webm"
  );
  const encoded = body.toString();

  assert.match(encoded, /filename="recording\\"X-Injected: yes\.webm"/);
  assert.doesNotMatch(encoded, /\r\nX-Injected:/);
  assert.match(encoded, new RegExp(`--${boundary}--\\r\\n$`));
});

test("multipart encoder escapes quoted header values and rejects malformed media types", () => {
  assert.equal(escapeQuotedHeaderValue('a\\b"c\r\nd'), 'a\\\\b\\"cd');
  assert.equal(sanitizeContentType("audio/mpeg"), "audio/mpeg");
  assert.equal(sanitizeContentType("audio/mpeg\r\nX-Injected: yes"), "application/octet-stream");
});
