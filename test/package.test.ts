import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { run } from "./instance";

const root = join(import.meta.dir, "..");
const out = mkdtempSync(join(tmpdir(), "rhodium-test-package-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** Whether a 64-bit ELF file names a dynamic loader (a PT_INTERP program header), as a dynamically linked one does. */
function interpreter(file: string): boolean {
  const elf = new DataView(readFileSync(file).buffer);
  const [phoff, size, count] = [Number(elf.getBigUint64(0x20, true)), elf.getUint16(0x36, true), elf.getUint16(0x38, true)];
  return Array.from({ length: count }, (_, i) => elf.getUint32(phoff + i * size, true)).includes(3);
}
/** The machine an ELF file is built for: its e_machine, 62 for x86_64, 183 for arm64. */
const machine = (file: string) => new DataView(readFileSync(file).buffer).getUint16(0x12, true);
const host = process.arch === "arm64" ? "arm64" : "x86_64";

// One build per architecture, side by side: each takes a minute and a half.
for (const [arch, em] of [["x86_64", 62], ["arm64", 183]] as const)
  test.concurrent(
    `package.sh ${arch} makes one tarball of the programs, the service script and the two docs for a new machine (#385)`,
    async () => {
      const at = join(out, arch);
      const tmp = join(at, "tmp");
      mkdirSync(tmp, { recursive: true });
      // Whatever Rust the caller has picked, rh-hold is built with the one its notices are written for.
      // And with a rustup older than 1.29, which has no `toolchain install --no-update`: bash takes
      // this exported function over the rustup on PATH.
      const oldRustup = `() { case " $* " in *" --no-update "*) echo "error: unexpected argument '--no-update'" >&2; return 1 ;; esac; command rustup "$@"; }`;
      const env = { ...process.env, TMPDIR: tmp, RUSTUP_TOOLCHAIN: "rhodium-test-none", "BASH_FUNC_rustup%%": oldRustup };
      await run([join(root, "scripts/package.sh"), at, arch], { cwd: root, timeoutMs: 300_000, env });
      expect(readdirSync(tmp)).toEqual([]);

      const commit = (await run(["git", "-C", root, "describe", "--always", "--dirty"])).trim();
      const name = `rhodium-${version}-${commit}-linux-${arch}`;
      expect(readdirSync(at).filter((f) => f !== "tmp")).toEqual([`${name}.tar.xz`]);
      await run(["tar", "-xJf", join(at, `${name}.tar.xz`), "-C", at]);
      const dir = join(at, name);
      expect(readdirSync(dir).sort()).toEqual(["INSTALLATION.md", "LICENSE", "README.md", "RUST-STD-COPYRIGHT.html", "THIRD_PARTY_NOTICES.md", "rh", "rh-hold", "rhodium", "rhodium-service.sh"]);
      // No path of the machine it was built on (#524), and the notices of what it bundles.
      for (const bin of ["rhodium", "rh-hold"]) expect([bin, readFileSync(join(dir, bin)).includes(root), machine(join(dir, bin))]).toEqual([bin, false, em]);
      const notices = readFileSync(join(dir, "THIRD_PARTY_NOTICES.md"), "utf8");
      // Every Rust crate rh-hold carries (its panic paths name them) has its notice, Rust's or ours.
      const rust = readFileSync(join(dir, "RUST-STD-COPYRIGHT.html"), "utf8");
      const crates = [...new Set(readFileSync(join(dir, "rh-hold")).toString("latin1").match(/\/rust\/deps\/[a-z0-9_-]+-\d[\d.]*\d/g) ?? [])].map((p) => p.slice("/rust/deps/".length));
      expect(crates.length).toBeGreaterThan(0);
      for (const c of crates) expect([c, rust.includes(`📦 ${c}<`) || notices.includes(c.replace(/-(\d)/, " $1"))]).toEqual([c, true]);
      for (const pkg of ["grammy", "react", "@larksuiteoapi/node-sdk", "simple-icons", "T3 Code", "JavaScriptCore", "musl", "RUST-STD-COPYRIGHT.html"]) expect([pkg, notices.includes(pkg)]).toEqual([pkg, true]);
      expect(readlinkSync(join(dir, "rh"))).toBe("rhodium");
      // Static, so it runs on a machine with an older glibc than this one's.
      expect(interpreter(join(dir, "rh-hold"))).toBe(false);
      // A build for the other architecture can't run here.
      if (arch !== host) return;
      expect((await run([join(dir, "rh"), "--version"], { env: {} })).trim()).toBe(`${version}-${commit}`);
      expect((await run([join(dir, "rh-hold"), "--version"], { env: {} })).trim()).toBe(version);
    },
    300_000,
  );
