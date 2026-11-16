// The local pictures and file links in what an agent said (architecture §8.3 "回复里的本机图片和文件链接"):
// which targets are local paths, and how a path is written, the same for rhodium and the board's page,
// which share this file. Reading the disk is src/reply-images.ts's.
import { normalizeUri } from "micromark-util-sanitize-uri";

/** A link's or picture's target as it is reckoned, kept and compared: turned as the page's Markdown
 *  library turns it, then its %XX decoded once, so what the page gets (/tmp/%E6%88%AA.png) and what
 *  the agent wrote (/tmp/截.png, or with %20 for a space) come to the same. One that cannot be decoded
 *  stays as the library turned it, on both sides. */
export function decoded(target: string): string {
  const turned = normalizeUri(target);
  try {
    return decodeURIComponent(turned);
  } catch {
    return turned;
  }
}

// scheme:// but file://, and the schemes that take no //. A path may have a colon (a.ts:12), so not any letters and a colon.
const ELSEWHERE = /^(?:(?!file:)[a-z][a-z0-9+.-]*:\/\/|(?:https?|mailto|tel|sms|javascript|data|blob|about):)/i;

/** Whether a target, as Markdown gives it and before it is decoded, is an address elsewhere, http or
 *  mailto say, and no local path: never checked, kept or rewritten. */
export const elsewhere = (target: string): boolean => ELSEWHERE.test(target);

/** Whether a link's target is a place in the page, #安装 or a footnote's the Markdown library makes: no
 *  local path, its words alone as ever. A picture's is not: #a.png is a file of that name. */
export const inPage = (target: string): boolean => target.startsWith("#");

/** Whether a link's path ends in a line: a.ts:12, a.ts:12:3 or a.ts#L12. A code reference, never a download. */
export const codeRef = (path: string): boolean => /(?::\d+(?::\d+)?|#L\d+)$/.test(path);

/** A local link that cannot be followed, in words, on the page as in IM: 名字（路径）, or the path alone
 *  where the name is the path or its last part, written as code or not. */
export function linkWords(name: string, path: string): string {
  const bare = name.replace(/^`+|`+$/g, "");
  return !bare || bare === path || bare === path.slice(path.lastIndexOf("/") + 1) ? path : `${name}（${path}）`;
}
