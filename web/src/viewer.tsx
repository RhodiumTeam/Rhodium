// The picture viewer (spec web-images "页面", stories 565, 566): over the whole screen, dark, the picture
// fit in it. The preview, loaded already, is laid first and the viewing copy over it, which the
// browser draws top down as it comes: the picture itself where it is small enough. Pinching zooms as
// the browser does anywhere. A tap while not zoomed, back or Esc closes it: open, it is a step in
// history, so back closes it and stays in the chat. Its code comes only once one opens. Given
// several, as the pictures attached and not sent (#691), the arrow keys, a swipe or the keys at its
// sides step through them.
import { Dialog } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** A picture to view: its address, the preview laid under it, and where to download it, if anywhere. */
export type Pic = { src: string; alt: string; preview?: string; download?: { href: string; name: string } };

// A light ring, so a key over the black beside a picture shows whole.
const KEY = "grid size-11 place-items-center rounded-full bg-black/40 text-white/85 ring-1 ring-white/25 transition-colors hover:bg-black/60 hover:text-white";

export default function Viewer({ pics, at = 0, close }: { pics: Pic[]; at?: number; close: () => void }) {
  const [i, setI] = useState(at);
  const swipe = useRef<{ x: number; y: number }>(undefined);
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Once, though React may run this twice.
    if (!history.state?.viewer) history.pushState({ ...history.state, viewer: true }, "");
    addEventListener("popstate", close);
    return () => removeEventListener("popstate", close);
  }, []);
  const shut = () => history.back();
  const many = pics.length > 1;
  const step = (d: number) => setI((i) => (i + d + pics.length) % pics.length);
  const zoomed = () => (visualViewport?.scale ?? 1) > 1.01;
  const p = pics[Math.min(i, pics.length - 1)]!;
  return (
    <Dialog.Root open onOpenChange={(open) => open || shut()}>
      <Dialog.Portal>
        <Dialog.Popup
          aria-label="图片"
          ref={popup}
          // Not the first key, 上一张, where a held Enter would step back, nor any key, ringed.
          initialFocus={popup}
          className="fixed inset-0 z-50 bg-black outline-none"
          onKeyDown={(e) => many && (e.key === "ArrowLeft" || e.key === "ArrowRight") && step(e.key === "ArrowLeft" ? -1 : 1)}
        >
          <div
            className="absolute inset-0"
            onClick={() => zoomed() || shut()}
            onTouchStart={(e) => {
              const t = e.touches[0]!;
              swipe.current = e.touches.length === 1 && !zoomed() ? { x: t.clientX, y: t.clientY } : undefined;
            }}
            onTouchEnd={(e) => {
              if (!swipe.current) return;
              const t = e.changedTouches[0]!;
              const [dx, dy] = [t.clientX - swipe.current.x, t.clientY - swipe.current.y];
              if (many && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
            }}
          >
            {p.preview && <img key={p.preview} src={p.preview} alt="" className="absolute inset-0 size-full object-contain" />}
            <img key={p.src} src={p.src} alt={p.alt} className="absolute inset-0 size-full object-contain" />
          </div>
          {many && (
            <>
              <button aria-label="上一张" onClick={() => step(-1)} className={`${KEY} absolute top-1/2 left-[max(0.5rem,env(safe-area-inset-left))] -translate-y-1/2`}>
                <ChevronLeft className="size-5" />
              </button>
              <button aria-label="下一张" onClick={() => step(1)} className={`${KEY} absolute top-1/2 right-[max(0.5rem,env(safe-area-inset-right))] -translate-y-1/2`}>
                <ChevronRight className="size-5" />
              </button>
            </>
          )}
          <div className="absolute top-0 right-0 flex gap-1 pt-[max(0.5rem,env(safe-area-inset-top))] pr-[max(0.5rem,env(safe-area-inset-right))]">
            {p.download && (
              <a href={p.download.href} download={p.download.name} aria-label="下载原图" className={KEY}>
                <Download className="size-5" />
              </a>
            )}
            <Dialog.Close aria-label="关闭" className={KEY}>
              <X className="size-5" />
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
