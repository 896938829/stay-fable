import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pageExtensions = [".js", ".json", ".wxml", ".wxss"];
const pagePathPattern = /^[A-Za-z0-9_/-]+$/;

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function validateWxProject(projectRoot) {
  const projectConfig = await readJson(path.join(projectRoot, "project.config.json"));
  const app = await readJson(path.join(projectRoot, "app.json"));

  if (projectConfig.compileType !== "miniprogram") {
    throw new Error('project.config.json must set compileType to "miniprogram"');
  }

  if (!Array.isArray(app.pages) || app.pages.length === 0) {
    throw new Error("app.json must contain a nonempty pages array");
  }

  for (const page of app.pages) {
    if (
      typeof page !== "string" ||
      !pagePathPattern.test(page) ||
      page.startsWith("/") ||
      page.includes("..")
    ) {
      throw new Error(`Invalid WeChat page path: ${String(page)}`);
    }

    for (const extension of pageExtensions) {
      const pageFile = path.join(projectRoot, `${page}${extension}`);

      try {
        await access(pageFile);
      } catch {
        throw new Error(`Missing WeChat page file: ${page}${extension}`);
      }
    }
  }

  return { pageCount: app.pages.length };
}

const isCli =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isCli) {
  const projectRoot = fileURLToPath(new URL("../wx", import.meta.url));
  const result = await validateWxProject(projectRoot);
  console.log(`WeChat project verified: ${result.pageCount} pages`);
}
