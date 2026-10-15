// D-R83: a URL handed to `path` must be refused by name, not resolved as a relative
// filesystem path (which used to leak the server's own cwd in the error text).
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client } from "./_client.mjs";

test("image_resize refuses a URL instead of resolving it against cwd", async () => {
  const dataHome = join(mkdtempSync(join(tmpdir(), "mcp-image-")), "data");
  const c = client({ dataHome });
  try {
    await c.init();
    const r = await c.call("image_resize", { path: "http://127.0.0.1:8794/logo.png", width: 64, out_path: join(tmpdir(), "out.png") });
    assert.equal(r.result.isError, true);
    const text = r.result.content.map((x) => x.text).join("\n");
    assert.match(text, /is a URL, not a file path/);
    assert.match(text, /image_upload/);
    assert.doesNotMatch(text, /does not exist/);
    assert.equal(text.includes(process.cwd()), false);
  } finally { c.close(); }
});
