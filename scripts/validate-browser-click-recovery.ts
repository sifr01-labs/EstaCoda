/** Opt-in native Chrome regression. Uses only a temporary loopback fixture, never a real account. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createSupervisedLocalCdpBrowserBackend } from "../src/browser/supervised-local-cdp-backend.js";
import type { BrowserSnapshot } from "../src/contracts/browser.js";

const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><title>Browser recovery fixture</title>
    <header><a id="login" href="#login" onclick="event.preventDefault(); window.clicks++">Login</a></header>
    <section><button id="banner">Register</button></section>
    <script>window.clicks = 0;</script>`);
});
const backend = createSupervisedLocalCdpBrowserBackend({
  autoLaunch: true, headless: true, securityConfig: { allowPrivateUrls: true },
  settling: { minimumObservationMs: 0, stableWindowMs: 0 }
});
const sessionId = "click-recovery-fixture";
async function evaluate(expression: string): Promise<unknown> {
  const result = await backend.cdp!({ sessionId, method: "Runtime.evaluate", params: { expression, returnByValue: true } }) as
    { result?: { value?: unknown }; exceptionDetails?: unknown };
  assert.equal(result.exceptionDetails, undefined);
  return result.result?.value;
}
function loginInput(snapshot: BrowserSnapshot) {
  const login = snapshot.elements?.find((element) => element.name === "Login");
  assert.ok(login);
  return { sessionId, ref: login.ref, identity: snapshot.identity, tabRef: snapshot.tab!.ref };
}
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await backend.navigate({ sessionId, url: `http://127.0.0.1:${address.port}/` });
  for (let i = 0; i < 3; i++) {
    const before = await backend.snapshot!({ sessionId });
    // Change the global action map and renumber refs without replacing Login.
    await evaluate(`document.body.insertAdjacentHTML('afterbegin', '<button>Banner ${i}</button>')`);
    const reviewed = await backend.preflightAction!("click", loginInput(before));
    assert.ok(reviewed.identity.actionRevision > before.identity.actionRevision);
    await evaluate(`document.getElementById('banner').textContent = 'Slide ${i}'`);
    await backend.click!({ sessionId, ref: reviewed.target!.ref, identity: reviewed.identity, tabRef: reviewed.tabRef });
    assert.equal(await evaluate("window.clicks"), i + 1);
  }
  const beforeChange = await backend.snapshot!({ sessionId });
  const reviewed = await backend.preflightAction!("click", loginInput(beforeChange));
  await evaluate("document.getElementById('login').href = '#delete'; document.getElementById('banner').textContent = 'Changed'");
  await assert.rejects(backend.click!({ sessionId, ref: reviewed.target!.ref, identity: reviewed.identity, tabRef: reviewed.tabRef }),
    { reason: "stale-browser-ref" });
  assert.equal(await evaluate("window.clicks"), 3);
  const beforeReplacement = await backend.snapshot!({ sessionId });
  await evaluate("const login = document.getElementById('login'); login.replaceWith(login.cloneNode(true)); document.getElementById('banner').textContent = 'Replaced'");
  await assert.rejects(backend.preflightAction!("click", loginInput(beforeReplacement)), { reason: "stale-browser-ref" });
  assert.equal(await evaluate("window.clicks"), 3);
  console.log("PASS: three recovered native clicks; changed destination and replacement node rejected without dispatch.");
} finally {
  try { await backend.close?.(); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
