#!/usr/bin/env node

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssetIndex } from "./scripts/assetIndex.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const paperclipSdkRoot = [
  process.env.PAPERCLIP_SDK_DIST,
  path.resolve(root, "../../packages/plugins/sdk/dist"),
  // SDK bundled with an npm-installed Paperclip (`npx paperclipai run`)
  path.join(os.homedir(), ".paperclip/cli/current/node_modules/@paperclipai/plugin-sdk/dist"),
].find((candidate) => candidate && existsSync(path.join(candidate, "index.js")));

if (!paperclipSdkRoot) {
  throw new Error(
    "Could not find @paperclipai/plugin-sdk dist. Set PAPERCLIP_SDK_DIST=/path/to/paperclip/packages/plugins/sdk/dist",
  );
}

const paperclipSdkAlias = {
  name: "paperclip-sdk-alias",
  setup(build) {
    build.onResolve({ filter: /^@paperclipai\/plugin-sdk$/ }, () => ({
      path: path.join(paperclipSdkRoot, "index.js"),
    }));
  },
};

await mkdir(path.join(root, "dist/ui"), { recursive: true });
await mkdir(path.join(root, "dist/migrations"), { recursive: true });

/** The schema Paperclip gives this plugin; mirrors derivePluginDatabaseNamespace in the host. */
function pluginDatabaseNamespace(pluginKey, namespaceSlug) {
  const hash = createHash("sha256").update(pluginKey).digest("hex").slice(0, 10);
  const slug = (namespaceSlug ?? pluginKey)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 36) || "plugin";
  return `plugin_${slug}_${hash}`.slice(0, 63);
}

/** Migrations must name the plugin's schema outright, so fill it in from the built manifest. */
async function writeMigrations() {
  const { default: manifest } = await import(`${path.join(root, "dist/manifest.js")}?t=${Date.now()}`);
  const namespace = pluginDatabaseNamespace(manifest.id, manifest.database?.namespaceSlug);
  const sourceDir = path.join(root, "src/migrations");
  for (const name of (await readdir(sourceDir)).filter((file) => file.endsWith(".sql")).sort()) {
    const sql = await readFile(path.join(sourceDir, name), "utf8");
    await writeFile(path.join(root, "dist/migrations", name), sql.replaceAll("__NAMESPACE__", namespace));
  }
}

async function writeAssetIndex() {
  const assetsDir = path.join(root, "public/assets");
  await cp(assetsDir, path.join(root, "dist/ui/assets"), { recursive: true });
  await writeFile(
    path.join(root, "dist/ui/assets/officesim-assets.json"),
    JSON.stringify(await buildAssetIndex(assetsDir)),
  );
}

await build({
  entryPoints: [path.join(root, "src/worker.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(root, "dist/worker.js"),
  external: ["node:*"],
  plugins: [paperclipSdkAlias],
  sourcemap: true,
});

await build({
  entryPoints: [path.join(root, "src/ui/index.tsx")],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  outfile: path.join(root, "dist/ui/index.js"),
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@paperclipai/plugin-sdk/ui", "@paperclipai/plugin-sdk"],
  sourcemap: true,
});

await build({
  entryPoints: [path.join(root, "src/manifest.ts")],
  bundle: false,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(root, "dist/manifest.js"),
});

await writeMigrations();
await writeAssetIndex();

console.log("OfficeSim plugin built");
