import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error: plain ESM build script shared with the plugin build, no types
import { buildAssetIndex } from "../scripts/assetIndex.mjs";

/*
 * The Mac app's frontend is the plugin's own office UI (../src/ui), built with the Paperclip SDK
 * hooks swapped for a shim that talks to the Tauri backend. Nothing under ../src is forked.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const assetsDir = path.join(repoRoot, "public/assets");
const ASSET_INDEX = "officesim-assets.json";

/** Serves the asset index in dev and writes it into the build, next to the copied public assets. */
function assetIndex(): Plugin {
  return {
    name: "officesim-asset-index",
    configureServer(server) {
      server.middlewares.use(`/assets/${ASSET_INDEX}`, async (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(await buildAssetIndex(assetsDir)));
      });
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: `assets/${ASSET_INDEX}`, source: JSON.stringify(await buildAssetIndex(assetsDir)) });
    },
  };
}

/**
 * The plugin finds its assets next to its own script (import.meta.url). Here every module is served
 * from its source path, so point it at the app's root, where the public assets are served.
 */
function assetBaseUrl(): Plugin {
  return {
    name: "officesim-asset-base-url",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/src/ui/pixelAssets.ts")) return null;
      const patched = code.replace("const metaUrl = import.meta.url;", "const metaUrl = new URL(\"/index.js\", window.location.href).href;");
      if (patched === code) this.error("pixelAssets.ts no longer reads import.meta.url as expected; update the Mac asset base URL patch");
      return patched;
    },
  };
}

/** The office UI's host-specific pieces (src/ui/hostExtensions.ts) are the Mac app's own here. */
function hostExtensions(): Plugin {
  const mine = path.join(here, "src/host/hostExtensions.tsx");
  return {
    name: "officesim-host-extensions",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer?.startsWith(path.join(repoRoot, "src/ui/")) && /^\.\/hostExtensions(\.js|\.ts)?$/.test(source)) return mine;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [react(), assetIndex(), assetBaseUrl(), hostExtensions()],
  // ../public holds assets/ (characters, furniture, layouts...), served at /assets/
  publicDir: path.join(repoRoot, "public"),
  resolve: {
    alias: [
      { find: /^@paperclipai\/plugin-sdk\/ui$/, replacement: path.join(here, "src/host/sdkShim.ts") },
    ],
    // ../src imports react from the repo root; keep one copy, the app's
    dedupe: ["react", "react-dom"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari16",
    outDir: "dist",
    emptyOutDir: true,
  },
});
