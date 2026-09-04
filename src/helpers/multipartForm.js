const crypto = require("crypto");

// Multipart headers use quoted strings. File names originate outside the app,
// so escape header metacharacters instead of letting a crafted name create a
// second part or alter its content type. Values remain bytes in the body.
function escapeQuotedHeaderValue(value) {
  return String(value ?? "")
    .replace(/[\r\n]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function sanitizeContentType(value) {
  const mediaType = String(value ?? "").trim();
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(mediaType)
    ? mediaType
    : "application/octet-stream";
}

function buildMultipartBody(fileBuffer, fileName, contentType, fields = {}) {
  const boundary = `----OpenWhisprBoundary${crypto.randomBytes(16).toString("hex")}`;
  const parts = [
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${escapeQuotedHeaderValue(fileName)}"\r\n` +
      `Content-Type: ${sanitizeContentType(contentType)}\r\n\r\n`,
    fileBuffer,
    "\r\n",
  ];

  for (const [name, value] of Object.entries(fields)) {
    if (value != null) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${escapeQuotedHeaderValue(name)}"\r\n\r\n` +
          `${value}\r\n`
      );
    }
  }

  parts.push(`--${boundary}--\r\n`);
  return {
    body: Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part))),
    boundary,
  };
}

module.exports = { buildMultipartBody, escapeQuotedHeaderValue, sanitizeContentType };
