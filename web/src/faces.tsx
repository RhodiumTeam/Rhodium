// Who and where, as pictures (spec web-topology): a Bot's or chat window's avatar, with a small mark on
// its corner, the Bot's platform or the window's kind; with no avatar, the mark itself, full size. The
// topology view draws them, the chat page its sources, and the board a slot's Bots after its name.
import { cn } from "cn";
import { MessageCircle, User, Users } from "lucide-react";
import { useState, type CSSProperties } from "react";
import type { TopologyData } from "./data";

type Platform = TopologyData["bots"][number]["platform"];
type ChatKind = TopologyData["chats"][number]["kind"];

// The platforms' own marks, each round: Telegram's (simple-icons 16.35.0, CC0), its plane white; QQ's
// penguin in its own colours (Tencent's logo, as Wikipedia has it; not under Rhodium's MIT licence, see
// NOTICE.md), on white; Feishu's below.
const TELEGRAM = "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z";
const QQ: [fill: string, d: string][] = [
  ["#faab07", "m296.23047 496.73437c-35.52735 0-68.14063-11.89062-89.13672-29.65234-10.66406 3.1875-24.30469 8.3125-32.91016 14.67188-7.36718 5.4375-6.44922 10.98046-5.12109 13.21875 5.82812 9.83593 99.98437 6.28125 127.16797 3.21875z"],
  ["#faab07", "m296.23047 496.73437c35.53125 0 68.14062-11.89062 89.14062-29.65234 10.66016 3.1875 24.30078 8.3125 32.91016 14.67188 7.36328 5.4375 6.44531 10.98046 5.11719 13.21875-5.82813 9.83593-99.98438 6.28125-127.16797 3.21875z"],
  ["#000", "m296.4375 283.80078c58.67187-.39844 105.69141-11.75391 121.625-16.10937 3.79687-1.03907 5.82812-2.90235 5.82812-2.90235.0156-.53515.24219-9.55078.24219-14.20312 0-78.32813-36.97656-157.039065-127.91406-157.042971-90.93359.0039-127.91016 78.714841-127.91016 157.042971 0 4.65234.22657 13.66797.24219 14.20312 0 0 1.65234 1.74219 4.67969 2.58594 14.71094 4.09375 62.61719 16.01562 122.77344 16.42578z"],
  ["#000", "m455.87109 349.05469c-3.63672-11.70313-8.60156-25.35157-13.6289-38.46094 0 0-2.89063-.35547-4.35547.0664-45.10938 13.10546-99.78516 21.45703-141.44922 20.95312h-.43359c-41.4336.49609-95.73829-7.75781-140.69532-20.73437-1.71875-.4961-5.10937-.28516-5.10937-.28516-5.02735 13.10937-9.99219 26.75781-13.62891 38.46094-17.34375 55.8125-11.72265 78.91015-7.44531 79.42968 9.17969 1.10938 35.73437-42.01562 35.73437-42.01562 0 43.82031 39.5625 111.10547 130.16016 111.72266.40234-.004 2-.004 2.40234 0 90.59766-.61719 130.16016-67.90235 130.16016-111.72266 0 0 26.55469 43.125 35.73438 42.01562 4.27734-.51953 9.89843-23.61718-7.44532-79.42968"],
  ["#fff", "m263.86328 209.26562c-12.33594.5586-22.875-13.49609-23.53906-31.35937-.66797-17.875 8.78125-32.81641 21.11719-33.375 12.32421-.55078 22.85937 13.49609 23.52734 31.36719.67578 17.875-8.77734 32.8164-21.10547 33.36718"],
  ["#fff", "m352.11328 177.90625c-.66016 17.86328-11.19922 31.91797-23.53516 31.35937-12.32812-.55468-21.78125-15.49218-21.10546-33.36718.66796-17.8711 11.20312-31.91797 23.52734-31.36719 12.33594.55859 21.78516 15.5 21.11328 33.375"],
  ["#faab07", "m374.03906 234.49609c-3.29687-7.30078-36.49609-15.4375-77.59765-15.4375h-.44141c-41.10156 0-74.30078 8.13672-77.59766 15.4375-.14843.31641-.24218.66797-.24218 1.03907 0 .52734.17968 1 .45312 1.40625 2.78125 4.04687 39.64453 24.05859 77.38672 24.05859h.44141c37.74218 0 74.60546-20.00781 77.38281-24.05859.27734-.40235.45312-.88282.45312-1.41016 0-.37109-.0898-.71875-.23828-1.03516"],
  ["#000", "m279.02734 178.16797c.5625 7.05859-3.30859 13.32812-8.63672 14.01172-5.33593.6875-10.11328-4.47657-10.67968-11.53907-.5586-7.0625 3.30859-13.33203 8.625-14.01171 5.34765-.69141 10.13281 4.48046 10.6914 11.53906"],
  ["#000", "m312.91797 180.52734c1.08984-1.95312 8.51562-12.22265 23.88672-8.48437 4.03906.98437 5.90625 2.42969 6.30078 2.99609.58203.83985.74219 2.03516.15234 3.64453-1.16797 3.19141-3.58203 3.10547-4.91797 2.48047-.86328-.40234-11.57031-7.53906-21.43359 3.10938-.67969.73047-1.89453.98047-3.04297.11328-1.15234-.8711-1.625-2.63281-.94531-3.85938"],
  ["#fff", "m296.4375 329.04297h-.43359c-28.33594.34375-62.69141-3.41016-95.96485-9.96875-2.84765 16.49219-4.5664 37.22265-3.08984 61.94531 3.73047 62.48438 40.83984 101.76172 98.11719 102.33203h2.32812c57.28125-.57031 94.38672-39.84765 98.12109-102.33203 1.47657-24.72656-.24609-45.45312-3.09375-61.94922-33.27734 6.5625-67.64062 10.31641-95.98437 9.97266"],
  ["#eb1923", "m215.72266 323.81641v61.49218s28.16796 5.67969 56.39062 1.7461v-56.71875c-17.87891-1.01172-37.16016-3.26563-56.39062-6.51953"],
  ["#eb1923", "m423.89062 264.78906s-54.79296 17.29688-127.45312 17.78906h-.43359c-72.54297-.48828-127.26563-17.73046-127.45313-17.78906l-18.35156 45.80469c45.90234 13.83984 102.78906 22.75781 145.80469 22.23828h.43359c43.01562.51953 99.89844-8.39844 145.80469-22.23828z"],
];
// Feishu's bird, as ByteDance's own IconPark draws it (new-lark, Apache-2.0), in Feishu's blue: two
// strokes and a filled curve.
const FEISHU_STROKES = [
  "M17 29C21 29 25 26.9339 28 23.4065C36 14 41.4242 16.8166 44 17.9998C38.5 20.9998 40.5 29.6233 33 35.9998C28.382 39.9259 23.4945 41.014 19 41C12.5231 40.9799 6.86226 37.7637 4 35.4063V16.9998",
  "M33.5947 17C32.84 14.7027 30.8551 9.94054 27.5947 7H11.5947C15.2174 10.6757 23.0002 16 27.0002 24",
];
const FEISHU_FILL =
  "M5.64808 15.8669C5.02231 14.9567 3.77715 14.7261 2.86694 15.3519C1.95673 15.9777 1.72615 17.2228 2.35192 18.1331L5.64808 15.8669ZM36.0021 35.7309C36.958 35.1774 37.2843 33.9539 36.7309 32.9979C36.1774 32.042 34.9539 31.7157 33.9979 32.2691L36.0021 35.7309ZM2.35192 18.1331C5.2435 22.339 10.7992 28.144 16.8865 32.2239C19.9345 34.2667 23.217 35.946 26.449 36.7324C29.6946 37.522 33.0451 37.4428 36.0021 35.7309L33.9979 32.2691C32.2049 33.3072 29.9929 33.478 27.3947 32.8458C24.783 32.2103 21.9405 30.7958 19.1135 28.9011C13.4508 25.106 8.2565 19.661 5.64808 15.8669L2.35192 18.1331Z";
/** A platform's mark in a disc; one with none of its own (the fake platform the tests run), a speech bubble. */
export function Mark({ p, size, className, style }: { p: Platform; size: number; className?: string; style?: CSSProperties }) {
  if (p === "feishu")
    return (
      <svg role="img" aria-label="飞书" viewBox="-3 -3 54 54" width={size} height={size} className={cn("shrink-0 rounded-full ring-1 ring-border", className)} style={style}>
        <circle cx={24} cy={24} r={27} fill="#fff" />
        <g fill="none" stroke="#3370ff" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round">
          {FEISHU_STROKES.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        <path fill="#3370ff" d={FEISHU_FILL} />
      </svg>
    );
  if (p !== "qq" && p !== "telegram")
    return (
      <span role="img" aria-label={p} className={cn("grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground", className)} style={{ width: size, height: size, ...style }}>
        <MessageCircle style={{ width: Math.round(size * 0.6), height: Math.round(size * 0.6) }} />
      </span>
    );
  const qq = p === "qq";
  return (
    <svg role="img" aria-label={qq ? "QQ" : "Telegram"} viewBox={qq ? "56.2 57.5 480 480" : "0 0 24 24"} width={size} height={size} className={cn("shrink-0 rounded-full", qq && "ring-1 ring-border", className)} style={style}>
      <circle cx={qq ? 296.2 : 12} cy={qq ? 297.5 : 12} r={qq ? 240 : 11.5} fill="#fff" />
      {qq ? QQ.map(([fill, d], i) => <path key={i} fill={fill} d={d} />) : <path fill="#26A5E4" d={TELEGRAM} />}
    </svg>
  );
}

/** A chat window's kind: one person (私聊) or several (群聊), in a neutral disc. */
export function KindMark({ kind, size, className, style }: { kind: ChatKind; size: number; className?: string; style?: CSSProperties }) {
  const Icon = kind === "group" ? Users : User;
  return (
    <span role="img" aria-label={kind === "group" ? "群聊" : "私聊"} className={cn("grid shrink-0 place-items-center rounded-full bg-muted", size < 20 ? "text-foreground" : "text-foreground/75", className)} style={{ width: size, height: size, ...style }}>
      <Icon strokeWidth={size < 20 ? 2.75 : 2.25} style={{ width: Math.round(size * 0.72), height: Math.round(size * 0.72) }} />
    </span>
  );
}

const CONN = { reconnecting: ["bg-needs", "重连中"], faulted: ["bg-destructive", "故障"] } as const;
/** A Bot's connection when it is not online, in words: 重连中 or 故障; null when online. */
export const connText = (conn: TopologyData["bots"][number]["conn"]) => (conn === "reconnecting" || conn === "faulted" ? CONN[conn][1] : null);

/** The avatar at url, with the mark (a Bot's platform p, or a chat window's kind) on its corner; with no
 *  avatar, or one that does not load, the mark in its place. conn: a Bot's connection, a dot on the
 *  other corner unless it is online, smaller on a small face, as the mark is. The mark and the dot are
 *  ringed in the ground, ring its colour (the card's unless said), the mark in place of its own thin
 *  edge; row: on a slot's row (spec web-maximize), the avatar has a thin edge, a dark one showing on a
 *  dark row, and the mark is ringed in the row's ground, --row, with the classes row has. */
export function Face({ url, p, kind, size, conn, row, ring = "ring-card" }: { url: string | null; p?: Platform; kind?: ChatKind; size: number; conn?: TopologyData["bots"][number]["conn"]; row?: string; ring?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const shown = url !== null && broken !== url ? url : null;
  const off = (conn === "reconnecting" || conn === "faulted") && CONN[conn];
  const mark = (s: number, className?: string, style?: CSSProperties) => (kind ? <KindMark kind={kind} size={s} className={className} style={style} /> : <Mark p={p!} size={s} className={className} style={style} />);
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      {shown ? <img src={shown} alt="" onError={() => setBroken(shown)} className={cn("size-full rounded-full object-cover", row !== undefined && "ring-1 ring-foreground/15")} /> : mark(size)}
      {shown && mark(size < 24 ? 10 : size < 32 ? 14 : 16, cn("absolute ring-2", ring, row !== undefined && cn("ring-(--row)", row)), { right: -3, bottom: -3 })}
      {off && <span role="img" aria-label={off[1]} className={cn("absolute -top-0.5 -right-0.5 rounded-full ring-2", size < 24 ? "size-2" : "size-2.5", ring, off[0])} />}
    </span>
  );
}
