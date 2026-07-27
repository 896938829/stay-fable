import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import vm from "node:vm";

const rootUrl = new URL("../", import.meta.url);
const managementIndexUrl = new URL("apps/management-web/dist/index.html", rootUrl);
const miniappOutputUrl = new URL("apps/consumer-miniapp/dist/", rootUrl);

const managementHtml = await readFile(managementIndexUrl, "utf8");
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

for (const path of ["alipay/app.js", "tt/app.js"]) {
  assert.ok((await readFile(new URL(path, miniappOutputUrl), "utf8")).length > 0);
}

const registrations = [];
const wxBase = {
  webpackJsonp: [],
  canIUse: () => false,
  getAccountInfoSync: () => ({ miniProgram: { appId: "phase0-probe", envVersion: "develop" } }),
  getApp: () => ({}),
  getCurrentPages: () => [],
  getSystemInfoSync: () => ({
    SDKVersion: "3.0.0",
    language: "zh_CN",
    pixelRatio: 2,
    platform: "devtools",
    screenWidth: 375,
    version: "8.0.0",
    windowHeight: 667,
    windowWidth: 375,
  }),
  nextTick: (callback) => globalThis.queueMicrotask(callback),
  onAppHide: () => {},
  onAppShow: () => {},
  onError: () => {},
  onThemeChange: () => {},
  onUnhandledRejection: () => {},
};
const wx = new Proxy(wxBase, {
  get: (target, key) => (key in target ? target[key] : () => {}),
  set: (target, key, value) => Reflect.set(target, key, value),
});
const context = vm.createContext({
  App: (application) => registrations.push(application),
  Behavior: (value) => value,
  Component: () => {},
  Page: () => {},
  clearInterval: globalThis.clearInterval,
  clearTimeout: globalThis.clearTimeout,
  console,
  getApp: () => ({}),
  getCurrentPages: () => [],
  queueMicrotask: globalThis.queueMicrotask,
  require: () => ({}),
  setInterval: globalThis.setInterval,
  setTimeout: globalThis.setTimeout,
  wx,
});

for (const file of ["vendors.js", "taro.js", "runtime.js", "app.js"]) {
  const source = await readFile(new URL(`weapp/${file}`, miniappOutputUrl), "utf8");
  vm.runInContext(source, context, { filename: file });
}

assert.equal(registrations.length, 1);
console.log(
  "Built frontend smoke verified: management HTTP/title/root, three targets, WeChat App registration=1.",
);
