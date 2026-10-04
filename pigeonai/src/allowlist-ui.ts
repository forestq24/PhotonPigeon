/**
 * The allowlist page: add and remove the people StockPigeon may play and talk with.
 *
 *   npm run allowlist        then open the link it prints
 *
 * It edits the allowlist file only; it never reads messages and never talks to the bridge.
 * It listens on this machine alone (127.0.0.1) and every request must carry the one-time token
 * from the printed link, so another program or a web page in your browser cannot change the list.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { defaultAllowlistFile, parseContact, readEntries, writeEntries, type Entry } from "./allowlist.ts";

export function startAllowlistUi(options: { file: string; port: number; token?: string }) {
  const token = options.token ?? randomBytes(16).toString("hex");
  const authorised = (given: string | undefined): boolean => {
    const a = Buffer.from(given ?? ""); const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const send = (res: ServerResponse, status: number, body: unknown, type = "application/json"): void => {
    res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const readJson = (req: IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 4096) reject(new Error("too large")); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("not JSON")); } });
  });
  const list = (): { entries: Entry[]; problem?: string } => {
    try { return { entries: readEntries(options.file) }; } catch (err) { return { entries: [], problem: err instanceof Error ? err.message : "unreadable" }; }
  };

  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    // Only this machine's own address is accepted, which also defeats DNS-rebinding tricks.
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? "")) return send(res, 403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/") {
      if (!authorised(url.searchParams.get("t") ?? undefined)) return send(res, 403, "Open the link printed in the terminal by `npm run allowlist`.", "text/plain");
      return send(res, 200, PAGE, "text/html");
    }
    if (!authorised(req.headers["x-allowlist-token"] as string | undefined)) return send(res, 403, { error: "forbidden" });
    try {
      if (req.method === "GET" && url.pathname === "/api/list") return send(res, 200, { ...list(), file: options.file });
      if (req.method === "POST" && url.pathname === "/api/add") {
        const body = await readJson(req);
        const parsed = parseContact(String(body.contact ?? ""));
        if ("error" in parsed) return send(res, 400, parsed);
        const { entries, problem } = list();
        if (problem) return send(res, 409, { error: `The allowlist file is damaged (${problem}). Fix or delete it first.` });
        if (entries.some((entry) => entry.handle === parsed.handle)) return send(res, 409, { error: "That person is already on the list." });
        const name = String(body.name ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60);
        writeEntries(options.file, [...entries, { handle: parsed.handle, name, addedAt: new Date().toISOString() }]);
        return send(res, 200, { ...list(), file: options.file });
      }
      if (req.method === "POST" && url.pathname === "/api/remove") {
        const body = await readJson(req);
        const { entries, problem } = list();
        if (problem) return send(res, 409, { error: `The allowlist file is damaged (${problem}). Fix or delete it first.` });
        writeEntries(options.file, entries.filter((entry) => entry.handle !== body.handle));
        return send(res, 200, { ...list(), file: options.file });
      }
      return send(res, 404, { error: "not found" });
    } catch { return send(res, 400, { error: "bad request" }); }
  });
  return new Promise<{ url: string; token: string; close: () => Promise<void> }>((resolve) => {
    server.listen(options.port, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/?t=${token}`, token, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) });
    });
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>StockPigeon allowlist</title>
<style>
  :root { --bg:#f6f5f2; --card:#fff; --ink:#1c1b19; --muted:#6b6862; --line:#e4e1da; --accent:#2f6f4f; --danger:#a33a2c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161614; --card:#201f1c; --ink:#eceae4; --muted:#9d9a92; --line:#33312c; --accent:#6fbf94; --danger:#e08572; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width:640px; margin:0 auto; padding:32px 16px 64px; }
  h1 { font-size:24px; margin:0 0 4px; } p.lead { color:var(--muted); margin:0 0 24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
  form { display:grid; grid-template-columns:1fr 1fr auto; gap:8px; } @media (max-width:520px) { form { grid-template-columns:1fr; } }
  label { font-size:13px; color:var(--muted); display:block; margin-bottom:4px; }
  input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); font:inherit; }
  button { padding:10px 16px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; align-self:end; }
  button.remove { background:none; color:var(--danger); padding:6px 8px; font-weight:500; }
  ul { list-style:none; margin:0; padding:0; } li { display:flex; align-items:center; gap:12px; padding:10px 0; border-top:1px solid var(--line); } li:first-child { border-top:0; }
  .who { flex:1; min-width:0; } .name { font-weight:600; } .handle { color:var(--muted); font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
  .msg { min-height:24px; margin:8px 0 0; font-size:14px; } .msg.error { color:var(--danger); } .msg.ok { color:var(--accent); }
  .empty, .note { color:var(--muted); font-size:14px; } .note { margin-top:24px; }
</style></head><body><main>
  <h1>Allowlist</h1>
  <p class="lead">The only people StockPigeon will play and talk with. Everyone else's messages are never read.</p>
  <div class="card">
    <form id="add">
      <div><label for="contact">Phone number or email</label><input id="contact" autocomplete="off" placeholder="+1 555 123 4567" required></div>
      <div><label for="name">Name (optional)</label><input id="name" autocomplete="off" maxlength="60" placeholder="Alex"></div>
      <button type="submit">Add</button>
    </form>
    <p id="msg" class="msg" role="status"></p>
  </div>
  <div class="card"><ul id="list"></ul><p id="empty" class="empty" hidden>Nobody is on the list yet.</p></div>
  <p class="note">Changes take effect within a couple of seconds; nothing needs restarting. Ten-digit numbers are treated as US numbers. People listed in a process's ALLOWED_SENDERS setting are allowed as well and are not shown here.<br>Saved in <span id="file"></span></p>
</main>
<script>
  const token = new URLSearchParams(location.search).get("t");
  const $ = (id) => document.getElementById(id);
  const say = (text, kind) => { $("msg").textContent = text; $("msg").className = "msg " + (kind || ""); };
  async function call(path, body) {
    const res = await fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-allowlist-token": token }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  function show(data) {
    $("file").textContent = data.file;
    if (data.problem) say("The allowlist file is damaged: " + data.problem, "error");
    const list = $("list"); list.replaceChildren();
    $("empty").hidden = data.entries.length > 0;
    for (const entry of data.entries) {
      const li = document.createElement("li"), who = document.createElement("div"), name = document.createElement("div"), handle = document.createElement("div"), remove = document.createElement("button");
      who.className = "who"; name.className = "name"; handle.className = "handle"; remove.className = "remove"; remove.type = "button";
      name.textContent = entry.name || "(no name)"; handle.textContent = entry.handle.replace(/^(tel|mailto):/, ""); remove.textContent = "Remove";
      remove.setAttribute("aria-label", "Remove " + (entry.name || handle.textContent));
      remove.onclick = async () => { try { show(await call("/api/remove", { handle: entry.handle })); say("Removed " + handle.textContent + ".", "ok"); } catch (err) { say(err.message, "error"); } };
      who.append(name, handle); li.append(who, remove); list.append(li);
    }
  }
  $("add").onsubmit = async (event) => {
    event.preventDefault();
    try { show(await call("/api/add", { contact: $("contact").value, name: $("name").value })); say("Added.", "ok"); $("contact").value = ""; $("name").value = ""; $("contact").focus(); }
    catch (err) { say(err.message, "error"); }
  };
  call("/api/list").then(show).catch((err) => say(err.message, "error"));
</script></body></html>`;

if (import.meta.main) {
  const file = defaultAllowlistFile();
  if (!file) { console.error("ALLOWLIST_FILE=none turns the allowlist file off, so there is nothing to edit."); process.exit(1); }
  const ui = await startAllowlistUi({ file, port: Number(process.env.ALLOWLIST_PORT ?? 4747) });
  console.log(`Allowlist page: ${ui.url}\nEditing ${file}\nPress Ctrl-C to close the page. The list keeps working without it.`);
}
