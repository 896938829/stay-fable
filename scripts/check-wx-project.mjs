import { lstat, readFile, realpath } from "node:fs/promises";
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

function isWithinProject(projectRoot, candidatePath) {
  const relative = path.relative(projectRoot, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function safeRegularFile(projectRoot, filePath, missingMessage, unsafeMessage) {
  const lexicalPath = path.resolve(filePath);
  if (!isWithinProject(projectRoot, lexicalPath)) {
    throw new Error(unsafeMessage);
  }

  let entryStats;
  let resolvedPath;

  try {
    entryStats = await lstat(lexicalPath);
    resolvedPath = await realpath(lexicalPath);
  } catch {
    // Missing and inaccessible paths have the same project-contract failure.
  }

  if (resolvedPath !== undefined && !isWithinProject(projectRoot, resolvedPath)) {
    throw new Error(unsafeMessage);
  }
  if (!entryStats || resolvedPath === undefined) {
    throw new Error(missingMessage);
  }

  let targetStats;
  try {
    targetStats = await lstat(resolvedPath);
  } catch {
    // A target that disappeared during validation is not a valid project file.
  }
  if (!targetStats?.isFile()) {
    throw new Error(missingMessage);
  }

  return resolvedPath;
}

async function readJson(projectRoot, filePath, fileName) {
  let source;

  try {
    const safePath = await safeRegularFile(
      projectRoot,
      filePath,
      `Unable to read ${fileName}`,
      `Unsafe WeChat file path: ${fileName}`,
    );
    source = await readFile(safePath, "utf8");
  } catch (error) {
    if (
      error.message === `Unable to read ${fileName}` ||
      error.message === `Unsafe WeChat file path: ${fileName}`
    ) {
      throw error;
    }
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

function normalizeLocalReference(reference, kind) {
  if (typeof reference !== "string" || reference.trim() === "") {
    throw new Error(`Unsafe WeChat ${kind} reference: ${String(reference)}`);
  }

  const value = reference.trim();
  if (externalResourcePattern.test(value) || dataResourcePattern.test(value)) {
    return { external: true };
  }
  if (value.includes("\\") || value.includes("\0") || schemePattern.test(value)) {
    throw new Error(`Unsafe WeChat ${kind} reference: ${value}`);
  }
  if (value.includes("{{") || value.includes("}}")) {
    if (value.split(/[?#]/, 1)[0].split("/").includes("..")) {
      throw new Error(`Unsafe WeChat ${kind} reference: ${value}`);
    }
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
  const safePath = await safeRegularFile(
    projectRoot,
    filePath,
    `Missing WeChat JavaScript file: ${projectLabel(projectRoot, filePath)}`,
    `Unsafe WeChat JavaScript file: ${projectLabel(projectRoot, filePath)}`,
  );
  const source = await readFile(safePath, "utf8");

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

  await safeRegularFile(
    projectRoot,
    resourcePath,
    `Missing WeChat ${kind} resource: ${projectLabel(projectRoot, resourcePath)}`,
    `Unsafe WeChat ${kind} reference: ${reference}`,
  );
}

function findTagEnd(source, startIndex) {
  let quote;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== undefined) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }

  return source.length;
}

function findWxsEnd(source, startIndex) {
  let state = "code";
  let quote;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (state === "string") {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        state = "code";
        quote = undefined;
      }
      continue;
    }
    if (state === "line-comment") {
      if (character === "\n" || character === "\r") {
        state = "code";
      }
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && nextCharacter === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      state = "string";
      quote = character;
    } else if (character === "/" && nextCharacter === "/") {
      state = "line-comment";
      index += 1;
    } else if (character === "/" && nextCharacter === "*") {
      state = "block-comment";
      index += 1;
    } else if (character === "<" && /^<\/wxs(?:\s|>)/i.test(source.slice(index, index + 7))) {
      const closingTagEnd = findTagEnd(source, index + 5);
      return closingTagEnd < source.length ? closingTagEnd + 1 : source.length;
    }
  }

  return source.length;
}

function srcAttributes(attributeSource) {
  const references = [];
  let index = 0;

  while (index < attributeSource.length) {
    while (/[\s/]/.test(attributeSource[index] ?? "")) {
      index += 1;
    }
    const nameStart = index;
    while (!/[\s=/>]/.test(attributeSource[index] ?? ">")) {
      index += 1;
    }
    const attributeName = attributeSource.slice(nameStart, index);
    while (/\s/.test(attributeSource[index] ?? "")) {
      index += 1;
    }
    if (attributeSource[index] !== "=") {
      if (index === nameStart) {
        index += 1;
      }
      continue;
    }
    index += 1;
    while (/\s/.test(attributeSource[index] ?? "")) {
      index += 1;
    }

    let attributeValue;
    const quote = attributeSource[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      const valueStart = index;
      while (index < attributeSource.length && attributeSource[index] !== quote) {
        if (attributeSource[index] === "\\") {
          index += 1;
        }
        index += 1;
      }
      attributeValue = attributeSource.slice(valueStart, index);
      index += 1;
    } else {
      const valueStart = index;
      while (!/[\s/>]/.test(attributeSource[index] ?? ">")) {
        index += 1;
      }
      attributeValue = attributeSource.slice(valueStart, index);
    }

    if (attributeName === "src") {
      references.push(attributeValue);
    }
  }

  return references;
}

// This deliberately scans only WXML start tags; it is not a replacement for the official compiler.
function wxmlSrcReferences(source) {
  const references = [];
  let index = 0;

  while (index < source.length) {
    const tagStart = source.indexOf("<", index);
    if (tagStart < 0) {
      break;
    }
    if (source.startsWith("<!--", tagStart)) {
      const commentEnd = source.indexOf("-->", tagStart + 4);
      index = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }

    const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(source.slice(tagStart + 1));
    if (nameMatch === null) {
      const ignoredTagEnd = findTagEnd(source, tagStart + 1);
      index = ignoredTagEnd < source.length ? ignoredTagEnd + 1 : source.length;
      continue;
    }

    const tagName = nameMatch[0];
    const attributesStart = tagStart + 1 + tagName.length;
    const tagEnd = findTagEnd(source, attributesStart);
    if (tagEnd >= source.length) {
      break;
    }
    const attributeSource = source.slice(attributesStart, tagEnd);
    references.push(...srcAttributes(attributeSource));
    index = tagEnd + 1;

    if (tagName.toLowerCase() === "wxs" && !/\/\s*$/.test(attributeSource)) {
      index = findWxsEnd(source, index);
    }
  }

  return references;
}

async function validateWxml(projectRoot, filePath) {
  const safePath = await safeRegularFile(
    projectRoot,
    filePath,
    `Missing WeChat WXML file: ${projectLabel(projectRoot, filePath)}`,
    `Unsafe WeChat WXML file: ${projectLabel(projectRoot, filePath)}`,
  );
  const source = await readFile(safePath, "utf8");

  for (const reference of wxmlSrcReferences(source)) {
    await validateResource(projectRoot, filePath, reference, "WXML");
  }
}

async function validateWxss(projectRoot, filePath) {
  const safePath = await safeRegularFile(
    projectRoot,
    filePath,
    `Missing WeChat WXSS file: ${projectLabel(projectRoot, filePath)}`,
    `Unsafe WeChat WXSS file: ${projectLabel(projectRoot, filePath)}`,
  );
  const source = (await readFile(safePath, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  const urlPattern = /\burl\(\s*(?:(["'])(.*?)\1|([^)"'\s][^)]*))\s*\)/gis;

  for (const match of source.matchAll(urlPattern)) {
    await validateResource(projectRoot, filePath, (match[2] ?? match[3]).trim(), "WXSS");
  }
}

async function validateOptionalWxss(projectRoot, filePath) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw new Error(`Unable to inspect ${projectLabel(projectRoot, filePath)}: ${error.message}`, {
      cause: error,
    });
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
      await safeRegularFile(
        projectRoot,
        componentFile,
        `Missing WeChat component file: ${projectLabel(projectRoot, componentFile)}`,
        `Unsafe WeChat component reference: ${String(reference)}`,
      );
    }

    const componentJsonPath = `${basePath}.json`;
    const componentJson = await readJson(
      projectRoot,
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
  projectRoot = await realpath(path.resolve(projectRoot));
  const projectConfig = await readJson(
    projectRoot,
    path.join(projectRoot, "project.config.json"),
    "project.config.json",
  );
  const appJsonPath = path.join(projectRoot, "app.json");
  const app = await readJson(projectRoot, appJsonPath, "app.json");

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
  await readJson(projectRoot, sitemapPath, projectLabel(projectRoot, sitemapPath));

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
      await safeRegularFile(
        projectRoot,
        pageFile,
        `Missing WeChat page file: ${page}${extension}`,
        `Unsafe WeChat page file: ${page}${extension}`,
      );
    }

    const pageBasePath = path.join(projectRoot, ...page.split("/"));
    const pageJsonPath = `${pageBasePath}.json`;
    const pageConfig = await readJson(projectRoot, pageJsonPath, `${page}.json`);
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
