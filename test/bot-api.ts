// A local stand-in for Telegram's Bot API, as far as Rhodium uses it: grammY's apiRoot points here.

/** Your Telegram user id, which is also your private chat's id. */
export const ME = 4242;
const YOU = { id: ME, is_bot: false, first_name: "you" };

/** How a call can go wrong: Markdown Telegram can't take, over the flood limit (to try again a
 *  second later, or at once), an edit to what the message shows already, or a photo too tall or long. */
const FAILURES = {
  refuse: { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" },
  flood: { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } },
  flood0: { ok: false, error_code: 429, description: "Too Many Requests: retry after 0", parameters: { retry_after: 0 } },
  same: { ok: false, error_code: 400, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message" },
  dimensions: { ok: false, error_code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" },
};

/** getMe knows only token; the other methods take any bot's. getUpdates forgets the updates
 *  below its offset, as Telegram does. refuseFirstPoll: turn down the first getUpdates, as with a
 *  token Telegram does not know yet. */
export function botApi(opts: { token?: string; refuseFirstPoll?: boolean } = {}) {
  let updateId = 1000;
  let updates: object[] = [];
  let arrived = Promise.withResolvers<void>();
  const polls: (number | undefined)[] = []; // the offset each getUpdates asked from
  // Each message sent, sent[i] with message_id i + 1: rich, a rich message's Markdown; else plain text.
  const sent: { chat_id: unknown; text: string; rich?: true }[] = [];
  // How the next calls of a method go, first first; then they go through. rich: only calls with
  // (true) or without (false) a rich message.
  const next: { method: string; how: keyof typeof FAILURES; rich?: boolean }[] = [];
  // Each call but getUpdates and the row's messages, as it came: edits, buttons, presses answered.
  const calls: { method: string; body: Record<string, any> }[] = [];
  // Each message with a reply keyboard, the row (architecture §8.4), as it came: apart, as no reply.
  const rows: Record<string, any>[] = [];
  const files = new Map<string, Uint8Array<ArrayBuffer>>(); // by file_id: what your messages carry
  const asked: string[] = []; // the file_id of each getFile
  const uploads: { method: string; chat_id: unknown; caption?: string; name: string; data: Uint8Array }[] = [];
  const update = (fields: object) => {
    updates.push({ update_id: updateId++, ...fields });
    arrived.resolve();
    arrived = Promise.withResolvers();
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const file = /^\/file\/bot[^/]+\/(.+)$/.exec(path)?.[1];
      if (file) return files.has(file) ? new Response(files.get(file)) : new Response("Not Found", { status: 404 });
      const [, token, method] = /^\/bot([^/]+)\/(.*)$/.exec(path) ?? [];
      const upload = ({ sendPhoto: "photo", sendAnimation: "animation", sendDocument: "document" } as Record<string, string>)[method!];
      if (upload) {
        const form = await req.formData();
        const failing = next.findIndex((n) => n.method === method);
        if (failing >= 0) return Response.json(FAILURES[next.splice(failing, 1)[0]!.how]);
        // The field names the form part that holds the file: attach://<name>.
        const field = String(form.get(upload));
        const blob = form.get(field.replace(/^attach:\/\//, "")) as File;
        const caption = form.get("caption");
        uploads.push({ method: method!, chat_id: form.get("chat_id"), ...(caption && { caption: String(caption) }), name: blob.name, data: new Uint8Array(await blob.arrayBuffer()) });
        return Response.json({ ok: true, result: { message_id: 100 + uploads.length, date: 0, chat: { id: ME, type: "private" } } });
      }
      const body = (await req.json().catch(() => ({}))) as Record<string, any>;
      if (method === "sendMessage" && body.reply_markup?.keyboard) {
        rows.push(body);
        return Response.json({ ok: true, result: { message_id: 10_000 + rows.length, date: 0, chat: { id: ME, type: "private" }, text: body.text } });
      }
      if (method !== "getUpdates") calls.push({ method: method!, body });
      const i = next.findIndex((n) => n.method === method && (n.rich === undefined || n.rich === "rich_message" in body));
      if (i >= 0) return Response.json(FAILURES[next.splice(i, 1)[0]!.how]);
      if (method === "getFile") {
        asked.push(body.file_id);
        return files.has(body.file_id)
          ? Response.json({ ok: true, result: { file_id: body.file_id, file_unique_id: body.file_id, file_path: body.file_id } })
          : Response.json({ ok: false, error_code: 400, description: "Bad Request: file is too big" });
      }
      if (method === "getMe") {
        if (token !== opts.token) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" });
        return Response.json({ ok: true, result: { id: 777, is_bot: true, first_name: "Rhodium test", username: "rhodium_test_bot" } });
      }
      if (method === "getUpdates") {
        polls.push(body.offset);
        if (opts.refuseFirstPoll && polls.length === 1) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" });
        updates = updates.filter((u: any) => body.offset === undefined || u.update_id >= body.offset);
        // Long polls end early, well within Bun.serve's idle timeout.
        if (!updates.length) await Promise.race([arrived.promise, Bun.sleep(1000)]);
        return Response.json({ ok: true, result: updates });
      }
      if (method === "sendMessage") {
        sent.push({ chat_id: body.chat_id, text: body.text });
        return Response.json({ ok: true, result: { message_id: sent.length, date: 0, chat: { id: ME, type: "private" }, text: body.text } });
      }
      if (method === "sendRichMessage") {
        sent.push({ chat_id: body.chat_id, text: body.rich_message.markdown, rich: true });
        return Response.json({ ok: true, result: { message_id: sent.length, date: 0, chat: { id: ME, type: "private" }, rich_message: { blocks: [] } } });
      }
      if (method === "setMyCommands") {
        // Telegram turns the whole menu down for one description over 256 characters (seen on the dev bot, #52).
        if (body.commands.some((c: { description: string }) => c.description.length > 256))
          return Response.json({ ok: false, error_code: 400, description: "Bad Request: command description length must not exceed 256" });
        return Response.json({ ok: true, result: true });
      }
      if (method === "getChat" && String(body.chat_id) === String(ME)) return Response.json({ ok: true, result: { ...YOU, type: "private" } });
      if (["editMessageText", "editMessageReplyMarkup", "answerCallbackQuery"].includes(method!)) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, error_code: 400, description: `Bad Request: no ${method} here` });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    polls,
    sent,
    next,
    calls,
    rows,
    files,
    asked,
    uploads,
    /** A private message from you: its text, or the fields of a message with a picture, a file or a
     *  reply. Gives the message as Telegram has it, for a later reply to it. */
    say(text: string | object) {
      const fields = typeof text === "string" ? { text } : text;
      const message = { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: ME, type: "private" }, from: YOU, ...fields };
      update({ message });
      return message;
    },
    /** You press the button with this data on the bot's message message_id. */
    press(message_id: number, data: string) {
      update({ callback_query: { id: `press-${updateId}`, from: YOU, chat_instance: "1", data, message: { message_id, date: 0, chat: { id: ME, type: "private" }, text: "" } } });
    },
    stop: () => server.stop(true),
  };
}
