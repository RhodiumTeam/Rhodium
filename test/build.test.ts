import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { version } from "../package.json";
import { BOARD_LOGIN, newInstance, run } from "./instance";

const root = join(import.meta.dir, "..");
const out = mkdtempSync(join(tmpdir(), "rhodium-test-build-"));
const dist = join(out, "dist");
afterAll(() => rmSync(out, { recursive: true, force: true }));

// Systemd user services have no bun or cargo on PATH, so run the built
// binaries by absolute path with an empty environment.
const versionOf = async (binary: string) => (await run([binary, "--version"], { env: {} })).trim();

test(
  "build.sh produces rhodium, rh and rh-hold that report the same version, rhodium and rh with the commit",
  async () => {
    // The Rust build cache goes in a temp dir; none is left behind.
    const tmp = join(out, "tmp");
    mkdirSync(tmp);
    await run([join(root, "scripts/build.sh"), dist], { cwd: root, timeoutMs: 120_000, env: { ...process.env, TMPDIR: tmp } });
    expect(readdirSync(tmp)).toEqual([]);

    symlinkSync("rhodium", join(dist, "rh"));
    // rhodium has the commit it was built from baked in, whatever the environment says (2026-10-23).
    const commit = (await run(["git", "-C", root, "describe", "--always"])).trim();
    expect((await run([join(dist, "rhodium"), "--version"], { env: { RHODIUM_BUILD_COMMIT: "other" } })).trim()).toBe(`${version}-${commit}`);
    expect(await versionOf(join(dist, "rh"))).toBe(`${version}-${commit}`);
    expect(await versionOf(join(dist, "rh-hold"))).toBe(version);
    // No path of the machine it was built on, which a module's __dirname would bring (#524).
    for (const bin of ["rhodium", "rh-hold"]) expect([bin, readFileSync(join(dist, bin)).includes(root)]).toEqual([bin, false]);
  },
  120_000,
);

test("stories 136, 138, 210, 211: the built rhodium serves the board page at / with its files, and it goes on a phone's home screen; /next/, where it was tried, goes on to /", async () => {
  const rhodium = newInstance();
  try {
    const d = await rhodium.start([join(dist, "rhodium")]);
    const base = `http://${d.logs.find((l) => l.msg === "ready")!.board}`;
    const get = (path: string, init: { headers?: Record<string, string>; decompress?: boolean; redirect?: RequestRedirect; signal?: AbortSignal } = {}) =>
      fetch(base + path, { ...init, headers: { "Tailscale-User-Login": BOARD_LOGIN, ...init.headers } });
    // The page, where the icon on the phone's home screen points: the manifest beside it and its icons.
    const page = await get("/");
    expect(page.headers.get("content-type")).toStartWith("text/html");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    // Never in another page's frame, and no script but its own files (spec web-write), and WebAssembly, the web terminal's (ADR-0012).
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval'");
    const html = await page.text();
    expect(html).toContain('<meta name="viewport"');
    // With the cookie of a login proxy in front, as Cloudflare Access wants (ADR-0013).
    expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials"');
    expect(html).toContain('<div id="root">');
    const manifest = await get("/manifest.webmanifest");
    expect(manifest.headers.get("content-type")).toStartWith("application/manifest+json");
    const m = (await manifest.json()) as { icons: { src: string; sizes: string }[] };
    expect(m).toMatchObject({ name: "Rhodium", display: "standalone", start_url: "./" });
    expect(m.icons.map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
    /** An icon: its size, and its width, height and whether it has see-through parts, by its PNG header. */
    const png = async (path: string) => {
      const r = await get(path);
      expect([path, r.headers.get("content-type")]).toEqual([path, "image/png"]);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const v = new DataView(bytes.buffer);
      const clear = [4, 6].includes(bytes[25]!) || new TextDecoder().decode(bytes).includes("tRNS");
      return { bytes: bytes.byteLength, size: `${v.getUint32(16)}x${v.getUint32(20)}`, clear };
    };
    for (const icon of m.icons) expect((await png(`/${icon.src}`)).size).toBe(icon.sizes);
    // The tab's icon is a small one, not the 192px one for a 16px spot, but 64px, so a 3x phone scales it
    // down, not up; the iPhone's home screen's is 180px with nothing see-through, as iOS fills that with
    // black (#563).
    const linked = (rel: string) => png(html.match(new RegExp(`<link rel="${rel}" href="\\.(/[^"]+)"`))![1]!);
    const tab = await linked("icon");
    expect(tab.size).toBe("64x64");
    expect(await linked("apple-touch-icon")).toMatchObject({ size: "180x180", clear: false });

    // Story 211: a bookmark of /next/, where the page was tried, or a page still open there, goes on
    // to the same path at /. The old page's /api/transcript is gone.
    const moves = [["/next", "/"], ["/next/", "/"], ["/next/api/slot?id=x", "/api/slot?id=x"], ["/next//example.com", "/example.com"]];
    for (const [path, to] of moves) expect([path, (await get(path!, { redirect: "manual" })).headers.get("location")]).toEqual([path, to]);
    const moved = await get("/next/");
    expect(new URL(moved.url).pathname).toBe("/");
    expect(await moved.text()).toBe(html);
    expect((await get("/api/transcript?slot=x")).status).toBe(404);

    // The first screen's script, the scripts it imports and its styles, each there and kept for good:
    // their names change with them.
    const files = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1]!);
    const [entry] = [...html.matchAll(/<script[^>]* src="\.\/(assets\/[^"]+)"/g)].map((m) => m[1]!);
    expect(files.filter((f) => f.endsWith(".css"))).toHaveLength(1);
    /** A file of the page as it comes to a browser that takes gzip: its size, and its text. A script or
     *  style comes to one that takes br as its brotli, smaller (#356); a file of a few hundred bytes, an
     *  icon's, may come a byte or two bigger, as it happens with the names it imports. */
    const gzipped = async (path: string) => {
      const r = await get(path, { headers: { "accept-encoding": "gzip" }, decompress: false });
      expect({ path, status: r.status, encoding: r.headers.get("content-encoding") }).toEqual({ path, status: 200, encoding: "gzip" });
      if (path.includes("/assets/")) expect(r.headers.get("cache-control")).toContain("immutable");
      const bytes = new Uint8Array(await r.arrayBuffer());
      const text = new TextDecoder().decode(Bun.gunzipSync(bytes));
      if (path.includes("/assets/")) {
        const b = await get(path, { headers: { "accept-encoding": "gzip, deflate, br, zstd" }, decompress: false });
        const br = new Uint8Array(await b.arrayBuffer());
        expect({ path, encoding: b.headers.get("content-encoding"), same: brotliDecompressSync(br).toString() === text, bigger: br.byteLength > Math.max(bytes.byteLength, 512) }).toEqual({ path, encoding: "br", same: true, bigger: false });
      }
      return { bytes: bytes.byteLength, text };
    };
    const size = (fs: { bytes: number }[]) => fs.reduce((n, f) => n + f.bytes, 0);
    expect((await get("/assets/none.js")).status).toBe(404);

    // The first screen, as it comes to a browser that takes gzip, is 200KB at most (architecture §2),
    // the tab's icon with it.
    const first = await Promise.all(["/", ...files.map((f) => `/${f}`)].map(gzipped));
    expect(size(first) + tab.bytes).toBeLessThanOrEqual(200 * 1024);
    // It has React's production build, as a user gets, though bun test sets NODE_ENV=test and the build
    // took it (#472): the development one warns of a list's missing keys, and is 65KB bigger.
    expect(first.some((f) => f.text.includes('unique "key" prop'))).toBe(false);
    // Each part loaded later comes only once it is opened, a slot's chat (300KB at most) and the topology
    // view (200KB at most, spec web-topology): its file and the files it imports beyond the first
    // screen's, scripts and styles, as the entry lists them to load with it (Vite's __vite__mapDeps).
    // Not what a part loads later in turn, as the topology's previews do the chat.
    const script = first[1 + files.indexOf(entry!)]!.text;
    /** The files of a part as the script from imports it, but those loaded already. */
    const part = async (name: string, from = script, loaded = files) => {
      const deps = JSON.parse(from.match(/m\.f=(\[[^\]]*\])/)![1]!) as string[];
      const [, , list] = from.match(new RegExp(`import\\(\`\\./(${name}-[\\w-]+\\.js)\`\\)[^]*?__vite__mapDeps\\(\\[([\\d,]*)\\]\\)`))!;
      const own = list!.split(",").map((i) => `assets/${deps[Number(i)]!.slice(2)}`);
      return Promise.all(own.filter((f) => !loaded.includes(f)).map(async (f) => ({ file: f, ...(await gzipped(`/${f}`)) })));
    };
    const [chat, topology, jump] = await Promise.all([part("slot"), part("topology"), part("jump")]);
    // The jump box comes apart too, only once ⌘K first opens it (spec web-maximize).
    expect(jump.map((f) => f.text).join("\n")).toContain("jump-list");
    expect(first.map((f) => f.text).join("\n")).not.toContain("jump-list");
    expect(size(chat)).toBeLessThanOrEqual(300 * 1024);
    expect(size(topology)).toBeLessThanOrEqual(200 * 1024);
    // The topology has React Flow, and not what shows a chat's messages, which the chat's part has.
    const drawn = topology.map((f) => f.text).join("\n");
    expect(drawn).toContain("react-flow");
    expect(drawn).not.toContain("streamdown");
    expect(chat.map((f) => f.text).join("\n")).toContain("streamdown");
    // The web terminal comes only once a slot in the terminal opens, beyond the chat's (250KB at most,
    // spec web-terminal); ghostty-web comes with it, not with the first screen or the chat.
    const slot = chat.find((f) => f.text.includes("import(`./terminal-"))!.text;
    const terminal = await part("terminal", slot, [...files, ...chat.map((f) => f.file)]);
    expect(size(terminal)).toBeLessThanOrEqual(250 * 1024);
    expect(terminal.map((f) => f.text).join("\n")).toContain("ghostty");
    expect([...first, ...chat].map((f) => f.text).join("\n")).not.toContain("ghostty");
    // The picture viewer comes only once a picture opens, beyond the chat's (spec web-images).
    const viewer = await part("viewer", slot, [...files, ...chat.map((f) => f.file)]);
    expect(viewer.map((f) => f.text).join("\n")).toContain("下载原图");
    expect([...first, ...chat].map((f) => f.text).join("\n")).not.toContain("下载原图");

    // What the scripts ask the API for, and the API answering there: the first screen's, whichever of its files the build put it in.
    const code = [...first, ...chat, ...terminal].map((f) => f.text).concat(drawn).join("\n");
    for (const path of ["api/terminal?slot=", "api/media?h=", "api/board", "api/events", "api/slot?id=", "api/messages?slot=", "api/messages?conversation=", "api/topology", "api/rhodium", "api/front"]) expect(code).toContain(path);
    // The event stream opens by naming the page it serves, by the entry script the HTML loads (#356).
    const ac = new AbortController();
    const stream = (await get("/api/events", { signal: ac.signal })).body!.getReader();
    // With the stream's id, which the page says whether it is in front by (#593).
    const [head, data] = new TextDecoder().decode((await stream.read()).value).split("\ndata: ");
    expect([head, JSON.parse(data!)]).toEqual(["event: page", { entry: `./${entry}`, stream: expect.stringMatching(/^[\w-]{36}$/) }]);
    ac.abort();
    expect(await (await get("/api/board")).json()).toEqual({ workspaces: [], bots: [] });
    expect((await get("/api/rhodium")).status).toBe(200);
  } finally {
    await rhodium.cleanup();
  }
}, 60_000);
