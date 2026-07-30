import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const rootUrl = new URL("../", import.meta.url);
const managementIndexUrl = new URL("apps/management-web/dist/index.html", rootUrl);
const frozenMiniappPackageUrl = new URL("apps/consumer-miniapp/package.json", rootUrl);
const frozenMiniappSourceUrl = new URL("apps/consumer-miniapp/src/app.ts", rootUrl);

const [managementHtml, frozenMiniappPackageText, frozenMiniappSource] = await Promise.all([
  readFile(managementIndexUrl, "utf8"),
  readFile(frozenMiniappPackageUrl, "utf8"),
  readFile(frozenMiniappSourceUrl, "utf8"),
]);
const frozenMiniappPackage = JSON.parse(frozenMiniappPackageText);
assert.equal(frozenMiniappPackage.name, "@stay-fable/consumer-miniapp");
assert.equal(frozenMiniappPackage.private, true);
assert.ok(frozenMiniappSource.length > 0);

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(managementHtml);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await globalThis.fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Stay Fable 管理平台<\/title>/);
  assert.match(html, /<div id="root"><\/div>/);
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
console.log(
  "Built frontend smoke verified: management HTTP/title/root and frozen Taro source retained.",
);
