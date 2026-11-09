// The board's page (product §7): four views by the address's hash, "#/" the board, "#/slot/<id>" a
// slot's chat, "#/topology" the topology view (spec web-topology), "#/rhodium" Rhodium itself, each
// kept live by the event stream. With no hash, the home's view this device last used. On a wide
// screen a slot's chat is to the right of the board or the topology, the line between them dragged
// to move it; in maximize mode (?full, spec web-maximize) a sidebar of the slots takes their place.
// A medium screen's chat is always in maximize mode.
// On every page ⌘K opens the jump box, and with a chat open Alt+↑↓ goes to the slot above or below.
import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense, useEffect, useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { Route, Router, Switch, useLocation, useRoute } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { BoardPage, nextSlot } from "./board";
import { BoardHeader, boardKey, chatAt, goHash, HOME, recent, ROOM, slotHash, TopBar, useMedia, WIDE } from "./common";
import { builds, follow, json, lastReload, posting, prefetch, queryClient, refresh, reload, reloadAgain, reloadNow, unsent, type BoardData } from "./data";
import "./index.css";
import { RhodiumPage } from "./rhodium";
import { watch } from "./unread";

// A slot's chat, with what renders Markdown, comes only once you open one, or the page is idle (below):
// the board stays light. Once it came, drawn straight, not through lazy, whose first draw shows the
// fallback, which React keeps 300 ms, the code there or not (#386). Which of the two, picked as it
// mounts, for good: one switching would draw itself anew.
type ChatCode = typeof import("./slot");
let chatCode: ChatCode | undefined;
const chatCame = (m: ChatCode) => ((chatCode = m), m);
const LazySlotPage = lazy(() => import("./slot").then((m) => ({ default: chatCame(m).SlotPage })));
const LazySplit = lazy(() => import("./slot").then((m) => ({ default: chatCame(m).Split })));
function SlotPage(p: ComponentProps<ChatCode["SlotPage"]>) {
  const [Page] = useState(() => chatCode?.SlotPage ?? LazySlotPage);
  return <Page {...p} />;
}
function Split(p: ComponentProps<ChatCode["Split"]>) {
  const [Part] = useState(() => chatCode?.Split ?? LazySplit);
  return <Part {...p} />;
}
// The jump box only once ⌘K first opens it: the first screen stays light.
const Jump = lazy(() => import("./jump").then((m) => ({ default: m.Jump })));
// And the topology view, with what draws graphs, only once you open it.
const TopologyPage = lazy(() => import("./topology/topology").then((m) => ({ default: m.TopologyPage })));
// A page left open over an upgrade asks for a part by its old file name, which is gone: load the page
// again for the new one. So too one a login proxy in front would not give, its session run out
// (ADR-0013). Not again within 10 s, as reloadNow has it: the event also fires for a chat the browser
// cannot run (Safari before 16.4 cannot parse its regex lookbehinds), which would load the page over and over.
addEventListener("vite:preloadError", reloadAgain);

// A page whose rhodium now serves another build loads itself again for it, as reloadNow says: as it
// comes back in front (#356), not under you as you read. This page's build: the script its HTML loaded first.
const MINE = document.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null;
let served: string | null = null;
// Back: in front since it came there, or loaded, with nothing done since.
let back = !document.hidden;
for (const t of ["pointerdown", "keydown", "wheel", "input"]) addEventListener(t, () => (back = false), { capture: true, passive: true });
/** What loading again would lose: a send still going, or failed, files attached, words in a field but
 *  the message's, whose draft is kept, or in it as you type, a sheet or menu open. */
function busy() {
  const e = document.activeElement;
  const typed = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].some((f) => f.value !== "" && (f === e || f.getAttribute("aria-label") !== "消息"));
  return posting.count > 0 || unsent.any() || typed || !!document.querySelector('ul[aria-label="附件"], [role="dialog"], [role="alertdialog"], [role="menu"]');
}
function mayReload() {
  const last = lastReload();
  if (last && reloadNow(MINE, served, { back, busy: busy() }, last, Date.now())) reload(served);
}
builds.add((entry) => ((served = entry), mayReload()));
document.addEventListener("visibilitychange", () => ((back = !document.hidden), mayReload()));
// And once what held it goes, a send coming back.
setInterval(mayReload, 1_000);

// Once idle, what the page fetches ahead; then, all of it come, the chat's code runs from the cache, and
// brings the chats of slots whose turns end, on the list too (#386). Not with one that failed, as the
// link dropped: the browser keeps a module that failed to load as failed, and the chat would not open
// without loading the page again; it comes as a chat opens.
// ponytail: after the topology's files too, some 3 s later on a 400 kbps link; run it once the chat's
// files came, should a chat opened meanwhile matter.
void prefetch().then((all) => void (all && import("./slot").then(chatCame, () => {})));
watch();

// A file dropped anywhere off the chat, which attaches it, is not opened by the browser in place of the board.
const keepFile = (e: DragEvent) => e.dataTransfer?.types.includes("Files") && e.preventDefault();
addEventListener("dragover", keepFile);
addEventListener("drop", keepFile);

// / opens the home's view this device last used (story 244), in place of the step.
if (location.hash === "" && HOME.get() === "topology") history.replaceState(null, "", "#/topology");

// A slot's chat, with or without a query, as ?full.
const SLOT = /^\/slot\/(?<id>[^/?]+)/;

/** Alt+↑↓ (story 442): the open chat gives way to the slot by from it as the list shows them, the page
 *  staying as it is, in place of the step; and is no longer right after 放大, which 缩小 goes back from,
 *  nor opened from the topology, which back goes to: back closes it in place, as the topology's own step does.
 *  The list as last brought, brought afresh for the next. */
async function step(by: 1 | -1) {
  const at = location.hash.slice(1);
  const room = matchMedia(ROOM).matches;
  const current = chatAt(at, room);
  const data = await queryClient.ensureQueryData({ queryKey: ["board"], queryFn: () => json<BoardData>("api/board"), revalidateIfStale: true });
  const next = nextSlot(data, current, by);
  if (!next || next === current) return;
  const { full, up, ...state } = history.state ?? {};
  goHash(slotHash(next, at, room), true, state);
}

function App() {
  const [live, setLive] = useState<boolean | null>(null); // null: the stream has not opened yet
  // On a slot's page, the stream follows its transcript too; on the topology view, that of the slot
  // whose current conversation a preview shows.
  const [previewed, setPreviewed] = useState<string | null>(null);
  const room = useMedia(ROOM);
  const wide = useMedia(WIDE);
  const [location] = useLocation();
  const chatSlot = chatAt(location, room);
  // A wide or medium screen's topology with a slot's chat beside it (?chat).
  const chatOf = location.startsWith("/topology") && chatSlot ? chatSlot : undefined;
  // Maximize mode: a wide screen's as asked, a medium screen's always, with no split. A phone has none:
  // its chat fills the screen already.
  const full = room && (!wide || /[?&]full(?:&|$)/.test(location));
  const slot = useRoute(SLOT)[1]?.id ?? chatOf ?? previewed ?? undefined;
  useEffect(() => follow(() => void refresh(), setLive, slot), [slot]);
  // Braces: Chrome's scrollTo returns a promise, which React would take for the effect's cleanup.
  useEffect(() => {
    scrollTo(0, 0);
  }, [location]);
  useEffect(() => void (chatSlot && recent.add(chatSlot)), [chatSlot]);
  return (
    <Switch>
      {/* On a phone the chat fills the screen, its top bar in place of the board's; on a wide or medium
          screen the board stays while the chat's code comes. Keyed, so another slot's starts afresh. */}
      <Route path={SLOT}>
        {(p) => {
          const chat = <SlotPage key={p.id} id={p.id!} live={live} />;
          return <Suspense fallback={room && !full ? <Home live={live} /> : <TopBar live={live} />}>{room ? <Split from="list" full={full} board={<Home live={live} />} chat={chat} /> : chat}</Suspense>;
        }}
      </Route>
      <Route path={/^\/topology(?:[/?]|$)/}>
        <Suspense fallback={<Home live={live} />}>
          {/* The topology stays while the chat's code comes. */}
          {chatOf ? (
            <Suspense fallback={full ? <TopBar live={live} /> : <TopologyPage live={live} onPreview={setPreviewed} />}>
              <Split from="topology" full={full} board={<TopologyPage live={live} onPreview={setPreviewed} />} chat={<SlotPage key={chatOf} id={chatOf} live={live} graph={false} />} />
            </Suspense>
          ) : (
            <TopologyPage live={live} onPreview={setPreviewed} />
          )}
        </Suspense>
      </Route>
      <Route>
        <Home live={live} />
      </Route>
    </Switch>
  );
}

/** The board's keys on every page: ⌘K opens the jump box, its code fetched only then, and closes it;
 *  so does the sidebar's 跳转. Alt+↑↓ with a chat open. What had the keyboard as the box opened has it
 *  back as it closes with no slot picked; picked, the slot's chat takes it. */
function Keys() {
  const [jumping, setJumping] = useState(false);
  const before = useRef<HTMLElement | null>(null);
  const shut = (picked?: boolean) => (setJumping(false), picked || before.current?.focus());
  useEffect(() => {
    const show = () => jumping || ((before.current = document.activeElement as HTMLElement | null), setJumping(true));
    // The keys taken keep the browser's own from them, as Ctrl+K's search; the rest go on. Alt+↑↓ with a
    // chat open and no jump box, unless what has the keyboard took it first, as the command palette does.
    const key = (e: KeyboardEvent) => {
      const k = boardKey(e);
      if (k === "jump") (e.preventDefault(), jumping ? shut() : show());
      else if ((k === "up" || k === "down") && !jumping && !e.defaultPrevented && chatAt(location.hash.slice(1), matchMedia(ROOM).matches)) (e.preventDefault(), void step(k === "down" ? 1 : -1));
    };
    addEventListener("keydown", key);
    addEventListener("rh-jump", show);
    return () => (removeEventListener("keydown", key), removeEventListener("rh-jump", show));
  }, [jumping]);
  return (
    jumping && (
      <Suspense>
        <Jump close={shut} />
      </Suspense>
    )
  );
}

/** The board, or Rhodium's page, under the header with the event stream's state. On a wide screen a
 *  line under the header across the page, or the split's side, as under a chat's top bar (#617); the
 *  header stays there, and what is under it scrolls under the line (#635), back to its top as another
 *  page opens, as the window does (App); beside a chat the list stays where it is. Both keep room for
 *  the bar, so they stay level as it comes. */
function Home({ live }: { live: boolean | null }) {
  const [at] = useLocation();
  const head = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const split = at.startsWith("/slot/");
  useEffect(() => void (split || page.current?.scrollTo(0, 0)), [at]);
  // With no chat, the keys that scrolled the window, pressed with nothing focused or in the header (a
  // button there takes Space, a link does not), scroll what is under a wide screen's header, as the
  // window no longer scrolls there.
  useEffect(() => {
    if (split) return;
    const key = (e: KeyboardEvent, f = document.activeElement) =>
      /^(Page(Up|Down)|Arrow(Up|Down)|Home|End| )$/.test(e.key) &&
      !(e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) &&
      (f === document.body || ((e.key !== " " || f instanceof HTMLAnchorElement) && head.current?.contains(f))) &&
      matchMedia(WIDE).matches &&
      page.current?.focus({ preventScroll: true });
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [split]);
  return (
    <main className="pt-[env(safe-area-inset-top)] lg:flex lg:h-dvh lg:flex-col">
      <div ref={head} className="lg:shrink-0 lg:overflow-hidden lg:border-b lg:[scrollbar-gutter:stable]">
        <div className="mx-auto max-w-[55rem] px-4">
          <BoardHeader live={live} />
        </div>
      </div>
      <div ref={page} tabIndex={-1} className="pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:[scrollbar-gutter:stable]">
        <div className="mx-auto max-w-[55rem] px-4">
          <Switch>
            <Route path="/rhodium" component={RhodiumPage} />
            <Route component={BoardPage} />
          </Switch>
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <App />
        <Keys />
      </Router>
    </QueryClientProvider>
  </StrictMode>,
);
