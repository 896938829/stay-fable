import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { validateWxProject } from "./check-wx-project.mjs";

const tempRoots = [];

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-wx-"));
  tempRoots.push(root);

  await mkdir(path.join(root, "pages", "index"), { recursive: true });
  await writeFile(
    path.join(root, "project.config.json"),
    JSON.stringify({ compileType: "miniprogram" }),
  );
  await writeFile(
    path.join(root, "app.json"),
    JSON.stringify({ pages: ["pages/index/index"], sitemapLocation: "sitemap.json" }),
  );
  await writeFile(path.join(root, "app.js"), "App({});");
  await writeFile(path.join(root, "sitemap.json"), JSON.stringify({ rules: [] }));

  await writeFile(path.join(root, "pages", "index", "index.js"), "Page({});");
  await writeFile(path.join(root, "pages", "index", "index.json"), "{}");
  await writeFile(path.join(root, "pages", "index", "index.wxml"), "<view />");
  await writeFile(path.join(root, "pages", "index", "index.wxss"), "");

  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("accepts a complete native WeChat mini-program", async () => {
  const root = await createFixture();

  assert.deepEqual(await validateWxProject(root), { pageCount: 1 });
});

test("rejects Skyline pages that use the standard navigation bar", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "app.json"),
    JSON.stringify({
      pages: ["pages/index/index"],
      renderer: "skyline",
      sitemapLocation: "sitemap.json",
    }),
  );

  await assert.rejects(() => validateWxProject(root), /Skyline.*navigationStyle.*custom/i);
});

test("rejects a page missing its WXML file", async () => {
  const root = await createFixture();
  await unlink(path.join(root, "pages", "index", "index.wxml"));

  await assert.rejects(() => validateWxProject(root), /index\.wxml/);
});

test("rejects a directory in place of a required page file", async () => {
  const root = await createFixture();
  const wxmlPath = path.join(root, "pages", "index", "index.wxml");
  await unlink(wxmlPath);
  await mkdir(wxmlPath);

  await assert.rejects(() => validateWxProject(root), /Missing WeChat page file:.*index\.wxml/);
});

test("rejects a directory in place of the optional app stylesheet", async () => {
  const root = await createFixture();
  await mkdir(path.join(root, "app.wxss"));

  await assert.rejects(() => validateWxProject(root), /Missing WeChat WXSS file: app\.wxss/);
});

test("rejects a traversal page path", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "app.json"),
    JSON.stringify({ pages: ["../outside"], sitemapLocation: "sitemap.json" }),
  );

  await assert.rejects(() => validateWxProject(root), /Invalid WeChat page path/);
});

test("identifies malformed JSON by file", async () => {
  const root = await createFixture();
  await writeFile(path.join(root, "app.json"), "{");

  await assert.rejects(() => validateWxProject(root), /app\.json.*valid JSON/i);
});

test("requires project configuration JSON to have an object root", async () => {
  const root = await createFixture();
  await writeFile(path.join(root, "project.config.json"), "null");

  await assert.rejects(() => validateWxProject(root), /project\.config\.json.*JSON object/i);
});

test("requires app JSON to have an object root", async () => {
  const root = await createFixture();
  await writeFile(path.join(root, "app.json"), "null");

  await assert.rejects(() => validateWxProject(root), /app\.json.*JSON object/i);
});

test("requires every page JSON to contain an object", async () => {
  const root = await createFixture();
  await writeFile(path.join(root, "pages", "index", "index.json"), "[]");

  await assert.rejects(() => validateWxProject(root), /pages\/index\/index\.json.*JSON object/i);
});

test("identifies malformed page JSON by file", async () => {
  const root = await createFixture();
  await writeFile(path.join(root, "pages", "index", "index.json"), "{");

  await assert.rejects(() => validateWxProject(root), /pages\/index\/index\.json.*valid JSON/i);
});

test("requires a declared component four-file bundle", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "pages", "index", "index.json"),
    JSON.stringify({ usingComponents: { card: "/components/card/card" } }),
  );

  await assert.rejects(() => validateWxProject(root), /Missing WeChat component file:.*card\.js/i);
});

test("requires component JSON to declare component true", async () => {
  const root = await createFixture();
  const componentDir = path.join(root, "components", "card");
  await mkdir(componentDir, { recursive: true });
  await writeFile(
    path.join(root, "pages", "index", "index.json"),
    JSON.stringify({ usingComponents: { card: "/components/card/card" } }),
  );
  await writeFile(path.join(componentDir, "card.js"), "Component({});");
  await writeFile(path.join(componentDir, "card.json"), JSON.stringify({ component: false }));
  await writeFile(path.join(componentDir, "card.wxml"), "<view />");
  await writeFile(path.join(componentDir, "card.wxss"), "");

  await assert.rejects(() => validateWxProject(root), /card\.json.*component.*true/i);
});

test("rejects traversal in a component reference", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "pages", "index", "index.json"),
    JSON.stringify({ usingComponents: { card: "../../../outside/card" } }),
  );

  await assert.rejects(() => validateWxProject(root), /Unsafe WeChat component reference.*\.\./i);
});

test("allows plugin components without checking local files", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "pages", "index", "index.json"),
    JSON.stringify({ usingComponents: { map: "plugin://provider/map" } }),
  );

  assert.deepEqual(await validateWxProject(root), { pageCount: 1 });
});

test("requires sitemapLocation to resolve to a valid object JSON file", async () => {
  const root = await createFixture();
  await unlink(path.join(root, "sitemap.json"));

  await assert.rejects(() => validateWxProject(root), /sitemap\.json/i);

  await writeFile(path.join(root, "sitemap.json"), "[]");
  await assert.rejects(() => validateWxProject(root), /sitemap\.json.*JSON object/i);
});

test("rejects unsafe sitemap traversal", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "app.json"),
    JSON.stringify({ pages: ["pages/index/index"], sitemapLocation: "../sitemap.json" }),
  );

  await assert.rejects(() => validateWxProject(root), /Unsafe WeChat sitemap reference/i);
});

test("checks local WXML src, import, and include resources", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "pages", "index", "index.wxml"),
    '<image src="/assets/missing.png" /><import src="/templates/card.wxml"/><include src="./row.wxml"/>',
  );

  await assert.rejects(
    () => validateWxProject(root),
    /Missing WeChat WXML resource:.*missing\.png/i,
  );
});

test("ignores WXML comments and data-src attributes", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "pages", "index", "index.wxml"),
    '<!-- <image src="/assets/commented-out.png" /> --><view data-src="/assets/metadata.png" />',
  );

  assert.deepEqual(await validateWxProject(root), { pageCount: 1 });
});

test("ignores src-like text nodes", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "pages", "index", "index.wxml"),
    '<view>Example text: src="/assets/not-an-attribute.png"</view>',
  );

  assert.deepEqual(await validateWxProject(root), { pageCount: 1 });
});

test("ignores tags and src-like strings inside a wxs script", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "pages", "index", "index.wxml"),
    `<wxs module="tools">
      var text = 'src="/assets/wxs-text.png"';
      var markup = '<image src="/assets/wxs-markup.png" />';
      var fakeClose = '</wxs><image src="/assets/after-fake-close.png" />';
      module.exports = { text: text, markup: markup, fakeClose: fakeClose };
    </wxs>
    <view>{{tools.text}}</view>`,
  );

  assert.deepEqual(await validateWxProject(root), { pageCount: 1 });
});

test("checks src only on real image, import, and include start tags", async () => {
  const root = await createFixture();
  const wxmlPath = path.join(root, "pages", "index", "index.wxml");

  for (const markup of [
    '<image src="/assets/missing-image.png" />',
    '<import src="/templates/missing-import.wxml" />',
    '<include src="/templates/missing-include.wxml" />',
  ]) {
    await writeFile(wxmlPath, markup);
    await assert.rejects(() => validateWxProject(root), /Missing WeChat WXML resource/);
  }
});

test("checks local icon configuration and WXSS url resources", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "app.json"),
    JSON.stringify({
      pages: ["pages/index/index"],
      sitemapLocation: "sitemap.json",
      tabBar: { list: [{ iconPath: "assets/missing.png" }] },
    }),
  );

  await assert.rejects(
    () => validateWxProject(root),
    /Missing WeChat config resource:.*missing\.png/i,
  );

  await writeFile(
    path.join(root, "app.json"),
    JSON.stringify({ pages: ["pages/index/index"], sitemapLocation: "sitemap.json" }),
  );
  await writeFile(
    path.join(root, "pages", "index", "index.wxss"),
    'view { background-image: url("/assets/missing.png"); }',
  );
  await assert.rejects(
    () => validateWxProject(root),
    /Missing WeChat WXSS resource:.*missing\.png/i,
  );
});

test("ignores url references inside WXSS comments", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "pages", "index", "index.wxss"),
    '/* view { background: url("/assets/commented-out.png"); } */',
  );

  assert.deepEqual(await validateWxProject(root), { pageCount: 1 });
});

test("rejects dangerous local resource references", async () => {
  const root = await createFixture();
  await writeFile(
    path.join(root, "pages", "index", "index.wxml"),
    '<image src="javascript:alert(1)" />',
  );

  await assert.rejects(() => validateWxProject(root), /Unsafe WeChat WXML reference.*javascript/i);

  await writeFile(
    path.join(root, "pages", "index", "index.wxml"),
    '<include src="../../../outside.wxml" />',
  );
  await assert.rejects(() => validateWxProject(root), /Unsafe WeChat WXML reference.*\.\./i);

  await writeFile(
    path.join(root, "pages", "index", "index.wxml"),
    '<image src="javascript:{{payload}}" />',
  );
  await assert.rejects(() => validateWxProject(root), /Unsafe WeChat WXML reference.*javascript/i);
});

test("reports JavaScript syntax errors in app, page, and component scripts", async () => {
  const root = await createFixture();
  await writeFile(path.join(root, "app.js"), "App({");

  await assert.rejects(() => validateWxProject(root), /app\.js.*JavaScript syntax/i);

  await writeFile(path.join(root, "app.js"), "App({});");
  await writeFile(path.join(root, "pages", "index", "index.js"), "Page({");
  await assert.rejects(
    () => validateWxProject(root),
    /pages\/index\/index\.js.*JavaScript syntax/i,
  );

  const componentDir = path.join(root, "components", "card");
  await mkdir(componentDir, { recursive: true });
  await writeFile(path.join(root, "pages", "index", "index.js"), "Page({});");
  await writeFile(
    path.join(root, "pages", "index", "index.json"),
    JSON.stringify({ usingComponents: { card: "/components/card/card" } }),
  );
  await writeFile(path.join(componentDir, "card.js"), "Component({");
  await writeFile(path.join(componentDir, "card.json"), JSON.stringify({ component: true }));
  await writeFile(path.join(componentDir, "card.wxml"), "<view />");
  await writeFile(path.join(componentDir, "card.wxss"), "");
  await assert.rejects(
    () => validateWxProject(root),
    /components\/card\/card\.js.*JavaScript syntax/i,
  );
});

test("accepts safe component and local resource references", async () => {
  const root = await createFixture();
  const componentDir = path.join(root, "components", "card");
  await mkdir(componentDir, { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "templates"), { recursive: true });
  await writeFile(path.join(root, "assets", "icon.png"), "image");
  await writeFile(path.join(root, "templates", "card.wxml"), '<template name="card" />');
  await writeFile(path.join(root, "pages", "index", "row.wxml"), "<view />");
  await writeFile(path.join(componentDir, "card.js"), "Component({});");
  await writeFile(
    path.join(componentDir, "card.json"),
    JSON.stringify({ component: true, usingComponents: {} }),
  );
  await writeFile(
    path.join(componentDir, "card.wxml"),
    '<image src="/assets/icon.png" /><include src="/templates/card.wxml" />',
  );
  await writeFile(
    path.join(componentDir, "card.wxss"),
    'view { background: url("/assets/icon.png"); }',
  );
  await writeFile(
    path.join(root, "app.json"),
    JSON.stringify({
      pages: ["pages/index/index"],
      sitemapLocation: "sitemap.json",
      usingComponents: { card: "/components/card/card" },
      tabBar: { list: [{ iconPath: "assets/icon.png", selectedIconPath: "/assets/icon.png" }] },
    }),
  );
  await writeFile(
    path.join(root, "pages", "index", "index.wxml"),
    '<image src="https://example.com/a.png"/><image src="{{avatar}}"/><import src="/templates/card.wxml"/><include src="./row.wxml"/>',
  );
  await writeFile(
    path.join(root, "pages", "index", "index.wxss"),
    'view { background: url("data:image/svg+xml;base64,AA=="); }',
  );

  assert.deepEqual(await validateWxProject(root), { pageCount: 1 });
});

test("accepts relative local components and import/include references", async () => {
  const root = await createFixture();
  const componentDir = path.join(root, "components", "card");
  await mkdir(componentDir, { recursive: true });
  await mkdir(path.join(root, "templates"), { recursive: true });
  await writeFile(path.join(componentDir, "card.js"), "Component({});");
  await writeFile(path.join(componentDir, "card.json"), JSON.stringify({ component: true }));
  await writeFile(path.join(componentDir, "card.wxml"), "<view />");
  await writeFile(path.join(componentDir, "card.wxss"), "");
  await writeFile(path.join(root, "templates", "card.wxml"), '<template name="card" />');
  await writeFile(path.join(root, "pages", "index", "row.wxml"), "<view />");
  await writeFile(
    path.join(root, "pages", "index", "index.json"),
    JSON.stringify({ usingComponents: { card: "../../components/card/card" } }),
  );
  await writeFile(
    path.join(root, "pages", "index", "index.wxml"),
    '<import src="/templates/card.wxml" /><include src="./row.wxml" />',
  );

  assert.deepEqual(await validateWxProject(root), { pageCount: 1 });
});

test("rejects a project-local symlink whose target escapes the project root", async (t) => {
  const root = await createFixture();
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "stay-fable-wx-outside-"));
  tempRoots.push(outsideRoot);
  const outsideFile = path.join(outsideRoot, "outside.png");
  const linkPath = path.join(root, "assets", "escape.png");
  await mkdir(path.dirname(linkPath), { recursive: true });
  await writeFile(outsideFile, "outside");

  try {
    await symlink(outsideFile, linkPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await writeFile(
    path.join(root, "pages", "index", "index.wxml"),
    '<image src="/assets/escape.png" />',
  );
  await assert.rejects(() => validateWxProject(root), /Unsafe WeChat WXML reference.*escape\.png/i);
});
