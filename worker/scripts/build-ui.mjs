import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = resolve(__dirname, "../src/ui");
const outPath = resolve(__dirname, "../src/ui.html");

export async function compileUiHtml() {
  const template = readFileSync(resolve(uiDir, "template.html"), "utf-8");
  const cssParts = [
    readFileSync(resolve(uiDir, "styles/tokens.css"), "utf-8"),
    readFileSync(resolve(uiDir, "styles/primitives.css"), "utf-8"),
    readFileSync(resolve(uiDir, "styles/layout.css"), "utf-8"),
  ];
  const combinedCss = cssParts.join("\n").trim();

  const bundleRes = await build({
    absWorkingDir: resolve(__dirname, ".."),
    entryPoints: [resolve(uiDir, "app.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    target: "es2022",
    format: "iife",
    legalComments: "none",
    minify: false,
  });

  const jsCode = bundleRes.outputFiles[0].text.trim();
  const banner =
    "<!-- AUTO-GENERATED FROM worker/src/ui/* BY worker/scripts/build-ui.mjs — DO NOT EDIT DIRECTLY -->\n";

  // Use function replacer so any `$` sequences inside JS/CSS are inserted literally!
  return (
    banner +
    template
      .replace("/*__CFM_INLINE_STYLES__*/", () => combinedCss)
      .replace("/*__CFM_INLINE_SCRIPT__*/", () => jsCode)
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const html = await compileUiHtml();
  writeFileSync(outPath, html, "utf-8");
  console.log(`built worker/src/ui.html (${Buffer.byteLength(html)} bytes)`);
}
