import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
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
  await writeFile(path.join(root, "app.json"), JSON.stringify({ pages: ["pages/index/index"] }));

  for (const extension of [".js", ".json", ".wxml", ".wxss"]) {
    await writeFile(path.join(root, "pages", "index", `index${extension}`), "");
  }

  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("accepts a complete native WeChat mini-program", async () => {
  const root = await createFixture();

  assert.deepEqual(await validateWxProject(root), { pageCount: 1 });
});

test("rejects a page missing its WXML file", async () => {
  const root = await createFixture();
  await unlink(path.join(root, "pages", "index", "index.wxml"));

  await assert.rejects(() => validateWxProject(root), /index\.wxml/);
});

test("rejects a traversal page path", async () => {
  const root = await createFixture();
  await writeFile(path.join(root, "app.json"), JSON.stringify({ pages: ["../outside"] }));

  await assert.rejects(() => validateWxProject(root), /\.\.\/outside/);
});
