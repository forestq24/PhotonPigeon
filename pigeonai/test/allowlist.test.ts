import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LiveAllowlist, parseContact, readEntries, writeEntries } from "../src/allowlist.ts";
import { startAllowlistUi } from "../src/allowlist-ui.ts";

const withDir = async (run: (dir: string) => Promise<void> | void) => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-allow-"));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("contacts typed by a person become handles, or a plain reason why not", () => {
  assert.deepEqual(parseContact(" +1 (555) 010-0001 "), { handle: "tel:+15550100001" });
  assert.deepEqual(parseContact("555-010-0001"), { handle: "tel:+15550100001" }, "ten digits are a US number");
  assert.deepEqual(parseContact("1 555 010 0001"), { handle: "tel:+15550100001" });
  assert.deepEqual(parseContact("+44 20 7946 0958"), { handle: "tel:+442079460958" });
  assert.deepEqual(parseContact("Someone@Example.COM"), { handle: "mailto:someone@example.com" });
  assert.deepEqual(parseContact("tel:+15550100001"), { handle: "tel:+15550100001" });
  for (const bad of ["", "12345", "442079460958", "not a number", "a@b", "+1 555 010 0001 ext 5", "<script>@x.y z"]) assert.ok("error" in parseContact(bad), bad);
});

test("the file is private, replaced whole, and a live list follows it without a restart", () => withDir((dir) => {
  const file = join(dir, "nested", "allowlist.json");
  const changes: string[][] = [];
  const live = new LiveAllowlist({ file, fixed: ["+15550100009"], checkEveryMs: 0, onChange: (handles) => changes.push(handles) });
  assert.deepEqual(live.handles(), ["tel:+15550100009"], "no file yet: only the fixed senders");
  assert.equal(live.has("TEL:+15550100009"), true);

  writeEntries(file, [{ handle: "tel:+15550100001", name: "Alex", addedAt: "2026-10-04T00:00:00Z" }]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
  assert.equal(live.has("tel:+15550100001"), true, "an added person is allowed on the next message");
  assert.equal(changes.length, 1);

  writeEntries(file, []);
  assert.equal(live.has("tel:+15550100001"), false, "a removed person is refused on the next message");
  assert.equal(live.has("tel:+15550100009"), true, "fixed senders are not affected by the file");

  // A damaged file allows nobody extra and never keeps someone who may have been removed.
  writeEntries(file, [{ handle: "tel:+15550100002", name: "", addedAt: "" }]);
  assert.equal(live.has("tel:+15550100002"), true);
  writeFileSync(file, "{ not json");
  assert.equal(live.has("tel:+15550100002"), false);
  writeFileSync(file, JSON.stringify({ entries: [{ handle: "anything-at-all" }] }));
  assert.throws(() => readEntries(file));
  assert.deepEqual(new LiveAllowlist({ file: undefined, fixed: [] }).handles(), [], "with the file turned off only the fixed senders count");
}));

test("the page changes the list only for a caller holding the token, on this machine's own address", () => withDir(async (dir) => {
  const file = join(dir, "allowlist.json");
  const ui = await startAllowlistUi({ file, port: 0 });
  const base = ui.url.split("/?")[0]!;
  const call = (path: string, body?: unknown, headers: Record<string, string> = { "x-allowlist-token": ui.token }) =>
    fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await fetch(ui.url)).status, 200);
    assert.match(await (await fetch(ui.url)).text(), /<title>StockPigeon allowlist<\/title>/);
    assert.equal((await fetch(base + "/")).status, 403, "the page itself needs the link from the terminal");
    assert.equal((await call("/api/list", undefined, {})).status, 403);
    assert.equal((await call("/api/add", { contact: "+15550100001" }, { "x-allowlist-token": "wrong" })).status, 403);
    // fetch will not send a false Host header, so this request is made by hand.
    const rebound = await new Promise<number>((resolve) => {
      const req = request(base + "/api/add", { method: "POST", headers: { "content-type": "application/json", "x-allowlist-token": ui.token, host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.end(JSON.stringify({ contact: "+15550100001" }));
    });
    assert.equal(rebound, 403, "another site's name for this address is refused, even with the token");
    assert.deepEqual(readEntries(file), [], "nothing was written by the refused calls");

    const added = await call("/api/add", { contact: "(555) 010-0001", name: "  Alex\n" });
    assert.equal(added.status, 200);
    const entries = readEntries(file);
    assert.deepEqual(entries.map((e) => [e.handle, e.name]), [["tel:+15550100001", "Alex"]]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal((await call("/api/add", { contact: "555 010 0001" })).status, 409, "already listed");
    const invalid = await call("/api/add", { contact: "12345" });
    assert.equal(invalid.status, 400);
    assert.match(((await invalid.json()) as { error: string }).error, /country code/);
    await call("/api/add", { contact: "friend@example.com" });
    assert.equal(readEntries(file).length, 2);
    assert.equal((await call("/api/remove", { handle: "tel:+15550100001" })).status, 200);
    assert.deepEqual(readEntries(file).map((e) => e.handle), ["mailto:friend@example.com"]);
    assert.deepEqual(((await (await call("/api/list")).json()) as { entries: unknown[] }).entries.length, 1);
  } finally { await ui.close(); }
}));
