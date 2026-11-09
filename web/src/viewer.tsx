// The picture viewer (spec web-images "页面", stories 565, 566): over the whole screen, dark, the picture
// fit in it. The preview, loaded already, is laid first and the viewing copy over it, which the
// browser draws top down as it comes: the picture itself where it is small enough. Pinching zooms as
// the browser does anywhere. A tap while not zoomed, back or Esc closes it: open, it is a step in
// history, so back closes it and stays in the chat. Its code comes only once one opens.
import { Dialog } from "@base-ui/react/dialog";
import { Download, X } from "lucide-react";
import { useEffect } from "react";
import type { Media } from "../../src/media";
import { mediaUrl, saveAs } from "./media";

// A light ring, so a key over the black beside a picture shows whole.
const KEY = "grid size-11 place-items-center rounded-full bg-black/40 text-white/85 ring-1 ring-white/25 transition-colors hover:bg-black/60 hover:text-white";

export default function Viewer({ m, close }: { m: Media; close: () => void }) {
  useEffect(() => {
    // Once, though React may run this twice.
    if (!history.state?.viewer) history.pushState({ ...history.state, viewer: true }, "");
    addEventListener("popstate", close);
    return () => removeEventListener("popstate", close);
  }, []);
  const shut = () => history.back();
  return (
    <Dialog.Root open onOpenChange={(open) => open || shut()}>
      <Dialog.Portal>
        <Dialog.Popup aria-label="图片" className="fixed inset-0 z-50 bg-black outline-none">
          <div className="absolute inset-0" onClick={() => (visualViewport?.scale ?? 1) <= 1.01 && shut()}>
            <img src={mediaUrl(m.hash, "preview")} alt="" className="absolute inset-0 size-full object-contain" />
            <img src={mediaUrl(m.hash, "view")} alt="图片" className="absolute inset-0 size-full object-contain" />
          </div>
          <div className="absolute top-0 right-0 flex gap-1 pt-[max(0.5rem,env(safe-area-inset-top))] pr-[max(0.5rem,env(safe-area-inset-right))]">
            <a href={mediaUrl(m.hash)} download={saveAs(m)} aria-label="下载原图" className={KEY}>
              <Download className="size-5" />
            </a>
            <Dialog.Close aria-label="关闭" className={KEY}>
              <X className="size-5" />
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
