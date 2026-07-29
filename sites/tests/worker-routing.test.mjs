import assert from "node:assert/strict";
import test from "node:test";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);

async function loadWorker() {
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

test("serves the generated Crossfadio SPA at the site root", async () => {
  const worker = await loadWorker();
  const seen = [];
  const response = await worker.fetch(
    new Request("https://crossfadio.example/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          seen.push(new URL(request.url).pathname);
          return new Response("<title>Crossfadio</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["/crossfadio/index.html"]);
  assert.match(await response.text(), /Crossfadio/);
});

test("returns a safe error when the Aliyun upstream is not configured", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://crossfadio.example/api/health"),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "upstream_not_configured",
  });
});
