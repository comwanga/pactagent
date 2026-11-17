import { build } from "esbuild";

/*
 * Issue #69: ahead-of-time compile the standalone provider service.
 *
 * The provider entry (scripts/provider-start.mjs) and every local TypeScript
 * module it imports are bundled into a single self-contained ESM file
 * (dist/provider-start.mjs) by esbuild (already a transitive dependency of
 * the devDependency tsx). All node_modules imports are kept external so the
 * runtime resolves them from the production node_modules with the same
 * conditions the previous `tsx` runtime used (`--conditions=react-server`).
 *
 * This removes tsx from the production runtime: the compiled bundle runs under
 * plain `node`. The PDF-extraction worker (src/domain/pdf-text-extract.worker.mjs)
 * is plain JavaScript loaded by path at runtime and is therefore not bundled
 * here; it is copied into the image separately.
 */

await build({
  entryPoints: ["scripts/provider-start.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: "dist/provider-start.mjs",
  target: "node26",
  logLevel: "info",
});
