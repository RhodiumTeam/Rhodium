// The board's page (architecture §2): `vite build web` writes it to web/dist, which rhodium serves
// from source; scripts/build.sh builds it into the rhodium binary.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { defineConfig, type Plugin } from "vite";

/** A package's module, or a bundler's helper: what goes in the libraries' files, apart from ours. Not
 *  the icons: which of them a part uses changes with our code, and would rename the libraries' files. */
const LIB = /node_modules(?!\/lucide-react\/)|^\0/;

/** Each script and style gets a brotli beside it, x.js.br, which src/board.ts sends a browser that
 *  takes br; at the highest quality, as it is built once. */
function brotli(): Plugin {
  return {
    name: "rhodium-brotli",
    apply: "build",
    // Once written: Vite still rewrites some files after generateBundle.
    writeBundle({ dir }, bundle) {
      for (const name of Object.keys(bundle).filter((f) => /\.(js|css)$/.test(f))) {
        const file = join(dir!, name);
        writeFileSync(`${file}.br`, brotliCompressSync(readFileSync(file), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
      }
    },
  };
}

/** The files of the chat and of the topology view that neither the first screen nor the + loads (the
 *  + loads its own once the page is idle), in that order, in a <meta name="later"> the page fetches ahead
 *  once idle (web/src/data.ts prefetch). */
function later(): Plugin {
  return {
    name: "rhodium-later",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_, { bundle }) {
        const files = (from: string[], into = new Set<string>()): Set<string> => {
          for (const name of from) {
            const c = bundle![name];
            if (c?.type !== "chunk" || into.has(name)) continue;
            into.add(name);
            c.viteMetadata?.importedCss.forEach((css) => into.add(css));
            files(c.imports, into);
          }
          return into;
        };
        const chunks = Object.values(bundle!).flatMap((c) => (c.type === "chunk" ? [c] : []));
        const part = (...ends: string[]) => ends.map((p) => chunks.find((c) => c.facadeModuleId?.endsWith(p))!.fileName);
        const loaded = files([...chunks.filter((c) => c.isEntry).map((c) => c.fileName), ...part("/src/create.tsx")]);
        const content = [...files(part("/src/slot.tsx", "/src/topology/topology.tsx"))].filter((f) => !loaded.has(f)).join(" ");
        return [{ tag: "meta", attrs: { name: "later", content }, injectTo: "head" }];
      },
    },
  };
}

export default defineConfig({
  base: "./", // the page asks for its files and the API by relative paths
  build: {
    chunkSizeWarningLimit: 1024, // the chat's libraries are over 500KB; test/build.test.ts guards what is sent
    rolldownOptions: {
      output: {
        // The libraries apart from our code, so an update that changes only ours keeps their files'
        // names, and the browser keeps them (#356): those of the first screen in one file, those two or
        // more of the parts loaded later share in another, and each part's own in its own.
        codeSplitting: {
          groups: [
            { name: "lib", test: LIB, tags: ["$initial"], priority: 2 },
            { name: "lib-shared", test: LIB, minShareCount: 2, priority: 1 },
            { name: "lib", test: LIB, entriesAware: true },
          ],
        },
      },
    },
  },
  plugins: [react(), tailwindcss(), brotli(), later()],
  resolve: {
    alias: {
      "@": `${import.meta.dirname}/src`,
      // Streamdown imports rehype-raw for its default plugins, which MARKDOWN (src/tools.tsx) turns off:
      // a third of the chat's libraries, never run (#356).
      "rehype-raw": `${import.meta.dirname}/src/no-raw.ts`,
    },
  },
});
