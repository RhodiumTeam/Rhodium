// What a message carried, as the chat shows it (spec web-images "页面"): a picture's preview, which
// opens the viewer, and a file's row, which downloads it; by address alone (GET /api/media), never
// the bytes in the page's data. The viewer's code comes only once one opens.
import { cn } from "cn";
import { lazy, Suspense, useState, type CSSProperties } from "react";
import { FileRow } from "./common";
import type { Media } from "../../src/media";

const Viewer = lazy(() => import("./viewer"));

/** A kept file's address: the file itself, or a picture's preview or viewing copy. */
export const mediaUrl = (hash: string, v?: "preview" | "view") => `api/media?h=${hash}${v ? `&v=${v}` : ""}`;

/** The name a download saves as: the one it came with, which the board gives, or its hash. */
export const saveAs = (m: Media) => m.name ?? m.hash;

/** What a message carried, in order: each picture as its preview, each file as its row. */
export function Carried({ media, className }: { media: Media[]; className?: string }) {
  if (!media.length) return null;
  return <div className={cn("grid grid-cols-[minmax(0,auto)] gap-1.5", className)}>{media.map((m, i) => (m.kind === "image" ? <Picture key={i} m={m} /> : <FileRow key={i} name={saveAs(m)} href={mediaUrl(m.hash)} />))}</div>;
}

// A picture's box, shown or not: nothing moves. A span, as it may stand in a paragraph of what the agent said.
const BOX = "block max-w-full overflow-hidden rounded-xl border bg-muted";
/** The box of a picture not shown, its sides not known: one pruned says so. */
export const NoPicture = ({ gone, style }: { gone: boolean; style?: CSSProperties }) => <span style={style} className={cn(BOX, !style && "size-40", "grid place-items-center text-xs text-muted-foreground")}>{gone && "图片已清理"}</span>;

/** A picture's preview, lazy, in a box sized ahead to its shape: as big as the preview, its long side
 *  800 CSS px, but no wider than the column, nor taller than 3/5 of the screen, so a phone's screenshot
 *  leaves room around it; a fixed grey box where its sides are not known. One the board says is gone
 *  (404) is that box saying so. Tapped, the viewer. */
export function Picture({ m }: { m: Media }) {
  const [shown, setShown] = useState<"yes" | "gone" | "broken">("yes");
  const [open, setOpen] = useState(false);
  const fit = m.w && m.h ? Math.min(1, 800 / Math.max(m.w, m.h)) : 0;
  const size: CSSProperties | undefined = fit ? { width: `min(${m.w! * fit}px, ${m.w! / m.h!} * 60dvh)`, aspectRatio: `${m.w} / ${m.h}` } : undefined;
  // Not loaded: gone if the board says so, else just not now.
  const failed = () => void fetch(mediaUrl(m.hash), { method: "HEAD" }).then((r) => setShown(r.status === 404 ? "gone" : "broken"), () => setShown("broken"));
  if (shown !== "yes") return <NoPicture gone={shown === "gone"} style={size} />;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} style={size} className={cn(BOX, !size && "size-40")}>
        <img src={mediaUrl(m.hash, "preview")} alt="图片" loading="lazy" onError={failed} className="size-full object-cover" />
      </button>
      {open && (
        <Suspense>
          <Viewer pics={[{ src: mediaUrl(m.hash, "view"), alt: "图片", preview: mediaUrl(m.hash, "preview"), download: { href: mediaUrl(m.hash), name: saveAs(m) } }]} close={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
