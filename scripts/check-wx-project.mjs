import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const pageExtensions = [".js", ".json", ".wxml", ".wxss"];
const pagePathPattern = /^[A-Za-z0-9_/-]+$/;
const localComponentExtensions = [".js", ".json", ".wxml", ".wxss"];
const externalResourcePattern = /^(?:https?:)?\/\//i;
const dataResourcePattern = /^data:/i;
const schemePattern = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function projectLabel(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

async function readJson(filePath, fileName) {
  let source;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${fileName}: ${error.message}`, { cause: error });
  }

  let value;

  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${fileName} must contain valid JSON: ${error.message}`, { cause: error });
  }

  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${fileName} must contain a JSON object`);
  }

  return value;
}

async function requireRegularFile(filePath, message) {
  let fileStats;

  try {
    fileStats = await stat(filePath);
  } catch {
    // Missing and inaccessible paths have the same project-contract failure.
  }

  if (!fileStats?.isFile()) {
    throw new Error(message);
  }
}

function normalizeLocalReference(reference, kind) {
  if (typeof reference !== "string" || reference.trim() === "") {
    throw new Error(`Unsafe WeChat ${kind} reference: ${String(reference)}`);
  }

  const value = reference.trim();
  if (externalResourcePattern.test(value) || dataResourcePattern.test(value)) {
    return { external: true };
  }
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.split(/[?#]/, 1)[0].split("/").includes("..") ||
    schemePattern.test(value)
  ) {
    throw new Error(`Unsafe WeChat ${kind} reference: ${value}`);
  }
  if (value.includes("{{") || value.includes("}}")) {
    return { dynamic: true };
  }

  const withoutQuery = value.split(/[?#]/, 1)[0];
  if (withoutQuery === "") {
    throw new Error(`Unsafe WeChat ${kind} reference: ${value}`);
  }

  return { value: withoutQuery };
}

function resolveLocalReference(projectRoot, sourceFile, reference, kind) {
  const normalized = normalizeLocalReference(reference, kind);
  if (normalized.dynamic || normalized.external) {
    return undefined;
  }

  const baseDirectory = normalized.value.startsWith("/") ? projectRoot : path.dirname(sourceFile);
  const relativeReference = normalized.value.replace(/^\/+/, "");
  const resolved = path.resolve(baseDirectory, ...relativeReference.split("/"));
  const relativeToRoot = path.relative(projectRoot, resolved);

  if (
    relativeToRoot === "" ||
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(`Unsafe WeChat ${kind} reference: ${reference}`);
  }

  return resolved;
}

async function validateJavaScript(projectRoot, filePath) {
  await requireRegularFile(
    filePath,
    `Missing WeChat JavaScript file: ${projectLabel(projectRoot, filePath)}`,
  );
  const source = await readFile(filePath, "utf8");

  try {
    new vm.Script(source, { filename: projectLabel(projectRoot, filePath) });
  } catch (error) {
    throw new Error(
      `${projectLabel(projectRoot, filePath)} has invalid JavaScript syntax: ${error.message}`,
      { cause: error },
    );
  }
}

async function validateResource(projectRoot, sourceFile, reference, kind) {
  const resourcePath = resolveLocalReference(projectRoot, sourceFile, reference, kind);
  if (resourcePath === undefined) {
    return;
  }

  await requireRegularFile(
    resourcePath,
    `Missing WeChat ${kind} resource: ${projectLabel(projectRoot, resourcePath)}`,
  );
}

async function validateWxml(projectRoot, filePath) {
  const source = await readFile(filePath, "utf8");
  const sourceAttributePattern = /\bsrc\s*=\s*(["'])(.*?)\1/gis;

  for (const match of source.matchAll(sourceAttributePattern)) {
    await validateResource(projectRoot, filePath, match[2], "WXML");
  }
}

async function validateWxss(projectRoot, filePath) {
  const source = await readFile(filePath, "utf8");
  const urlPattern = /\burl\(\s*(?:(["'])(.*?)\1|([^)"'\s][^)]*))\s*\)/gis;

  for (const match of source.matchAll(urlPattern)) {
    await validateResource(projectRoot, filePath, (match[2] ?? match[3]).trim(), "WXSS");
  }
}

async function validateOptionalWxss(projectRoot, filePath) {
  let fileStats;

  try {
    fileStats = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw new Error(`Unable to inspect ${projectLabel(projectRoot, filePath)}: ${error.message}`, {
      cause: error,
    });
  }
  if (!fileStats.isFile()) {
    throw new Error(`Missing WeChat WXSS file: ${projectLabel(projectRoot, filePath)}`);
  }
  await validateWxss(projectRoot, filePath);
}

async function validateConfigResources(projectRoot, configFile, value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      await validateConfigResources(projectRoot, configFile, item);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (key === "iconPath" || key === "selectedIconPath") {
      await validateResource(projectRoot, configFile, item, "config");
    } else {
      await validateConfigResources(projectRoot, configFile, item);
    }
  }
}

function componentBasePath(projectRoot, configFile, reference) {
  if (typeof reference === "string" && reference.startsWith("plugin://")) {
    return undefined;
  }
  const resolved = resolveLocalReference(projectRoot, configFile, reference, "component");
  if (resolved === undefined) {
    throw new Error(`Unsafe WeChat component reference: ${String(reference)}`);
  }
  return resolved;
}

async function validateUsingComponents(projectRoot, configFile, config, validatedComponents) {
  if (config.usingComponents === undefined) {
    return;
  }
  if (
    config.usingComponents === null ||
    Array.isArray(config.usingComponents) ||
    typeof config.usingComponents !== "object"
  ) {
    throw new Error(
      `${projectLabel(projectRoot, configFile)} usingComponents must contain a JSON object`,
    );
  }

  for (const reference of Object.values(config.usingComponents)) {
    const basePath = componentBasePath(projectRoot, configFile, reference);
    if (basePath === undefined) {
      continue;
    }
    const componentKey = path.normalize(basePath);
    if (validatedComponents.has(componentKey)) {
      continue;
    }
    validatedComponents.add(componentKey);

    for (const extension of localComponentExtensions) {
      const componentFile = `${basePath}${extension}`;
      await requireRegularFile(
        componentFile,
        `Missing WeChat component file: ${projectLabel(projectRoot, componentFile)}`,
      );
    }

    const componentJsonPath = `${basePath}.json`;
    const componentJson = await readJson(
      componentJsonPath,
      projectLabel(projectRoot, componentJsonPath),
    );
    if (componentJson.component !== true) {
      throw new Error(`${projectLabel(projectRoot, componentJsonPath)} must set component to true`);
    }

    await validateConfigResources(projectRoot, componentJsonPath, componentJson);
    await validateJavaScript(projectRoot, `${basePath}.js`);
    await validateWxml(projectRoot, `${basePath}.wxml`);
    await validateWxss(projectRoot, `${basePath}.wxss`);
    await validateUsingComponents(
      projectRoot,
      componentJsonPath,
      componentJson,
      validatedComponents,
    );
  }
}

export async function validateWxProject(projectRoot) {
  projectRoot = path.resolve(projectRoot);
  const projectConfig = await readJson(
    path.join(projectRoot, "project.config.json"),
    "project.config.json",
  );
  const appJsonPath = path.join(projectRoot, "app.json");
  const app = await readJson(appJsonPath, "app.json");

  if (projectConfig.compileType !== "miniprogram") {
    throw new Error('project.config.json must set compileType to "miniprogram"');
  }

  if (!Array.isArray(app.pages) || app.pages.length === 0) {
    throw new Error("app.json must contain a nonempty pages array");
  }

  if (typeof app.sitemapLocation !== "string") {
    throw new Error("app.json must contain a sitemapLocation string");
  }
  const sitemapPath = resolveLocalReference(
    projectRoot,
    appJsonPath,
    app.sitemapLocation,
    "sitemap",
  );
  if (sitemapPath === undefined) {
    throw new Error(`Unsafe WeChat sitemap reference: ${app.sitemapLocation}`);
  }
  await readJson(sitemapPath, projectLabel(projectRoot, sitemapPath));

  await validateJavaScript(projectRoot, path.join(projectRoot, "app.js"));
  await validateOptionalWxss(projectRoot, path.join(projectRoot, "app.wxss"));
  await validateConfigResources(projectRoot, appJsonPath, app);

  const pageConfigs = [];
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
      await requireRegularFile(pageFile, `Missing WeChat page file: ${page}${extension}`);
    }

    const pageBasePath = path.join(projectRoot, ...page.split("/"));
    const pageJsonPath = `${pageBasePath}.json`;
    const pageConfig = await readJson(pageJsonPath, `${page}.json`);
    pageConfigs.push({ config: pageConfig, file: pageJsonPath });
    await validateConfigResources(projectRoot, pageJsonPath, pageConfig);
    await validateJavaScript(projectRoot, `${pageBasePath}.js`);
    await validateWxml(projectRoot, `${pageBasePath}.wxml`);
    await validateWxss(projectRoot, `${pageBasePath}.wxss`);
  }

  const validatedComponents = new Set();
  await validateUsingComponents(projectRoot, appJsonPath, app, validatedComponents);
  for (const pageConfig of pageConfigs) {
    await validateUsingComponents(
      projectRoot,
      pageConfig.file,
      pageConfig.config,
      validatedComponents,
    );
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
