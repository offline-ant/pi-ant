import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globalRoot, isPiPeer, piResolutionFile, piRoot } from "./pi-test-imports.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let compiler;
try {
  // The workspace reference checkout supplies development tooling, not Pi APIs.
  compiler = require.resolve("typescript", { paths: [root, resolve(root, "../pi-mono"), dirname(globalRoot)] });
} catch {
  throw new Error("TypeScript is required for checks. Hydrate the pi-mono reference checkout's development dependencies, or install TypeScript globally. Do not npm install in pi-ant.");
}
const ts = require(compiler);
const config = ts.parseJsonConfigFileContent({
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    allowImportingTsExtensions: true,
    erasableSyntaxOnly: true,
    // Installed dependency declarations are upstream-owned; check our source,
    // including its use of those declarations, without checking library internals.
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [join(piRoot, "node_modules/@types"), join(globalRoot, "@types")],
  },
  include: ["extensions/**/*.ts", "orchestration/**/*.ts"],
}, ts.sys, root);
const host = ts.createCompilerHost(config.options);
host.resolveModuleNameLiterals = (modules, containingFile) => modules.map(({ text }) =>
  ts.resolveModuleName(text, isPiPeer(text) ? piResolutionFile : containingFile, config.options, host));
const program = ts.createProgram(config.fileNames, config.options, host);
const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else {
  console.log(`Checked ${config.fileNames.length} active TypeScript files with TypeScript ${ts.version} and installed Pi declarations.`);
}
