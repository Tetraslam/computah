import { execFileSync } from "node:child_process";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatGPT, planAgent } from "../src/server/chatgpt.js";
import { createFrontServer } from "../src/server/front.js";
import { header } from "../src/server/identity.js";
import { Site } from "../src/server/site.js";
import type { Job } from "../src/server/types.js";

/**
 * A stand-in for OpenAI's sign-in: discovery, signing keys, the token endpoint and revocation.
 * It issues real signed ID tokens, checks PKCE, and replaces the refresh token on every renewal,
 * so the code under test is held to the same rules the real one enforces.
 */
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

let server: Server;
let issuer: string;
let dir: string;
let fake: {
  codes: Map<string, { challenge: string; nonce: string; client: string; sub: string; redirect: string; scope: string }>;
  refresh: Map<string, { client: string; sub: string }>;
  revoked: string[];
  refreshes: number;
  /** Change how the next ID token is made, to forge one. */
  tamper: { key?: typeof keys.privateKey; iss?: string; aud?: string; nonce?: string };
  expiresIn: number;
  refreshError?: { status: number; error: string };
};

const sign = (claims: Record<string, unknown>, key = keys.privateKey) => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "RS256", kid: "k1", typ: "JWT" })}.${part(claims)}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key).toString("base64url")}`;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "computah-chatgpt-"));
  fake = { codes: new Map(), refresh: new Map(), revoked: [], refreshes: 0, tamper: {}, expiresIn: 3600 };
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    if (url.pathname === "/.well-known/openid-configuration")
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
      });
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/revoke") {
      fake.revoked.push(form.get("token") ?? "");
      return json(200, {});
    }
    if (url.pathname === "/token") {
      const tokens = (client: string, sub: string, nonce?: string) => {
        const refresh = `r-${Math.random().toString(36).slice(2)}`;
        fake.refresh.set(refresh, { client, sub });
        const now = Math.floor(Date.now() / 1000);
        return {
          access_token: `a-${sub}-${fake.refreshes}`,
          refresh_token: refresh,
          token_type: "Bearer",
          expires_in: fake.expiresIn,
          scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
          id_token: sign(
            {
              iss: fake.tamper.iss ?? issuer,
              aud: fake.tamper.aud ?? client,
              sub,
              email: `${sub}@example.com`,
              exp: now + 600,
              iat: now,
              nonce: fake.tamper.nonce ?? nonce,
            },
            fake.tamper.key,
          ),
        };
      };
      if (form.get("grant_type") === "authorization_code") {
        const code = fake.codes.get(form.get("code") ?? "");
        fake.codes.delete(form.get("code") ?? "");
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (!code || code.challenge !== challenge || code.client !== form.get("client_id") || code.redirect !== form.get("redirect_uri"))
          return json(400, { error: "invalid_grant" });
        const answer = tokens(code.client, code.sub, code.nonce);
        return json(200, { ...answer, scope: code.scope });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (fake.refreshError) return json(fake.refreshError.status, { error: fake.refreshError.error });
        const held = fake.refresh.get(form.get("refresh_token") ?? "");
        // Each refresh token works once.
        fake.refresh.delete(form.get("refresh_token") ?? "");
        if (!held || held.client !== form.get("client_id")) return json(400, { error: "refresh_token_reused" });
        fake.refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return json(200, tokens(held.client, held.sub));
      }
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const ann = { id: "guest:ann", name: "guest" };
const bob = { id: "guest:bob", name: "guest" };

/** Play the part of the browser and OpenAI: approve the sign-in at `url` and return what comes back to the callback. */
function approve(started: string | { url: string }, as = "ann-sub", options: { issued?: string; scope?: string } = {}) {
  const asked = new URL(typeof started === "string" ? started : started.url).searchParams;
  const first = asked.get("client_id") === "dynamic_agent_client";
  const client = first ? (options.issued ?? "oaiapp_ann") : (asked.get("client_id") ?? "");
  const code = `c-${Math.random().toString(36).slice(2)}`;
  fake.codes.set(code, {
    challenge: asked.get("code_challenge") ?? "",
    nonce: asked.get("nonce") ?? "",
    client,
    sub: as,
    redirect: asked.get("redirect_uri") ?? "",
    scope: options.scope ?? "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
  });
  const back = new URLSearchParams({ code, state: asked.get("state") ?? "" });
  if (first) back.set("client_id", client);
  return { asked, back };
}

describe("connecting a ChatGPT account, the open-source way", () => {
  it("registers a client for the person, keeps their tokens to themselves, and brings them back where they were", async () => {
    const chatgpt = new ChatGPT(dir, { issuer });
    expect(await chatgpt.status(ann)).toEqual({ connected: false, email: undefined });
    const started = await chatgpt.start(ann, "http://localhost:8000", "/docs?x=1");
    expect(started.paste).toBe(false);
    const { asked, back } = approve(started);
    // What OpenAI's guide asks for: the registration entrypoint, a loopback callback on 127.0.0.1, PKCE, and the plan scope.
    expect(asked.get("client_id")).toBe("dynamic_agent_client");
    expect(asked.get("redirect_uri")).toBe("http://127.0.0.1:8000/auth/callback");
    expect(asked.get("agent_name_hint")).toBe("computah");
    expect(asked.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(asked.get("code_challenge_method")).toBe("S256");
    expect(asked.get("resource")).toBe("https://api.openai.com/v1");
    expect(asked.get("scope")).toContain("chatgpt.tokens.use.direct");

    expect(chatgpt.expects(back.get("state"))).toBe(true);
    expect(await chatgpt.finish(back)).toEqual({ back: "http://localhost:8000/docs?x=1", connected: true });
    // The attempt is used up: the same callback can't be replayed.
    await expect(chatgpt.finish(back)).rejects.toThrow(/expired/);

    expect(await chatgpt.status(ann)).toEqual({ connected: true, email: "ann-sub@example.com" });
    expect(await chatgpt.status(bob)).toEqual({ connected: false, email: undefined });
    expect(await chatgpt.access(ann)).toBe("a-ann-sub-0");
    await expect(chatgpt.access(bob)).rejects.toThrow(/Connect it again/);

    // The file is the issued client and tokens, readable by this user only.
    const file = readFileSync(join(dir, readdirOne(dir)), "utf8");
    expect(JSON.parse(file).client_id).toBe("oaiapp_ann");
    expect(statSync(join(dir, readdirOne(dir))).mode & 0o777).toBe(0o600);
  });

  it("is finished by pasting the address when the runner isn't on the person's machine, and only by whoever started it", async () => {
    const chatgpt = new ChatGPT(dir, { issuer });
    const started = await chatgpt.start(ann, "https://example.com", "/page");
    // It comes back to the person's own machine, where nothing of ours is listening.
    expect(started.paste).toBe(true);
    const { asked, back } = approve(started);
    expect(asked.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    // Someone else who got hold of the address can't finish it, and trying doesn't spoil it for its owner.
    await expect(chatgpt.finish(back, bob)).rejects.toThrow(/someone else/);
    expect((await chatgpt.status(bob)).connected).toBe(false);
    expect(await chatgpt.finish(back, ann)).toEqual({ back: "https://example.com/page", connected: true });
    expect(await chatgpt.access(ann)).toBe("a-ann-sub-0");
    // The address works once.
    await expect(chatgpt.finish(back, ann)).rejects.toThrow(/expired/);
  });

  it("uses the owner's client and the app's own callback when OpenAI issued one", async () => {
    const chatgpt = new ChatGPT(dir, { issuer, clientId: "oaiapp_site", clientSecret: "s3cret" });
    const { asked, back } = approve(await chatgpt.start(ann, "https://example.com", "/"));
    expect(asked.get("client_id")).toBe("oaiapp_site");
    expect(asked.get("redirect_uri")).toBe("https://example.com/__computah/chatgpt/callback");
    expect(asked.has("agent_name_hint")).toBe(false);
    expect((await chatgpt.finish(back)).connected).toBe(true);
  });

  it("refuses an answer that isn't really from this sign-in", async () => {
    const chatgpt = new ChatGPT(dir, { issuer });
    const attempt = async (tamper: typeof fake.tamper) => {
      fake.tamper = tamper;
      const { back } = approve(await chatgpt.start(ann, "http://localhost:8000"));
      return chatgpt.finish(back).finally(() => {
        fake.tamper = {};
      });
    };
    await expect(attempt({ key: other.privateKey })).rejects.toThrow(/bad signature/);
    await expect(attempt({ iss: "https://evil.example" })).rejects.toThrow(/wrong issuer/);
    await expect(attempt({ aud: "oaiapp_someone_else" })).rejects.toThrow(/another app/);
    await expect(attempt({ nonce: "not-ours" })).rejects.toThrow(/another sign-in attempt/);
    expect((await chatgpt.status(ann)).connected).toBe(false);

    // A callback with a state nobody started, or a code swapped in from elsewhere, gets nowhere.
    await expect(chatgpt.finish(new URLSearchParams({ code: "x", state: "made-up" }))).rejects.toThrow(/expired/);
    const { back } = approve(await chatgpt.start(ann, "http://localhost:8000"));
    back.set("code", "stolen");
    expect((await chatgpt.finish(back)).connected).toBe(false);

    // Saying no at ChatGPT, or signing in without allowing plan use, connects nothing.
    const declined = approve(await chatgpt.start(ann, "http://localhost:8000")).back;
    declined.delete("code");
    declined.set("error", "access_denied");
    expect(await chatgpt.finish(declined)).toMatchObject({ connected: false, problem: expect.stringMatching(/didn't allow/) });
    const identityOnly = approve(await chatgpt.start(ann, "http://localhost:8000"), "ann-sub", { scope: "openid profile email" }).back;
    expect(await chatgpt.finish(identityOnly)).toMatchObject({ connected: false, problem: expect.stringMatching(/ChatGPT plan/) });
    expect((await chatgpt.status(ann)).connected).toBe(false);
  });

  it("renews a token once however many requests want it, and keeps the replacement", async () => {
    fake.expiresIn = 60; // Already inside the renewal window.
    const chatgpt = new ChatGPT(dir, { issuer });
    await chatgpt.finish(approve(await chatgpt.start(ann, "http://localhost:8000")).back);
    const got = await Promise.all([chatgpt.access(ann), chatgpt.access(ann), chatgpt.access(ann)]);
    expect(new Set(got).size).toBe(1);
    expect(fake.refreshes).toBe(1);
    // The next renewal works, which it only can if the replaced refresh token was the one saved.
    await chatgpt.access(ann);
    expect(fake.refreshes).toBe(2);
    // A second runner reading the same files picks up where this one left off.
    await new ChatGPT(dir, { issuer }).access(ann);
    expect(fake.refreshes).toBe(3);
  });

  it("asks them to sign in again when the session is over, and erases nothing over a bad moment", async () => {
    fake.expiresIn = 60;
    const chatgpt = new ChatGPT(dir, { issuer });
    await chatgpt.finish(approve(await chatgpt.start(ann, "http://localhost:8000")).back);
    // OpenAI is having a moment: the token still has a minute, so it's used, and the sign-in is kept.
    fake.refreshError = { status: 503, error: "temporarily_unavailable" };
    expect(await chatgpt.access(ann)).toBe("a-ann-sub-0");
    expect((await chatgpt.status(ann)).connected).toBe(true);
    // They disconnected the app in ChatGPT's settings: the session is gone.
    fake.refreshError = { status: 400, error: "invalid_grant" };
    await expect(chatgpt.access(ann)).rejects.toThrow(/Connect it again/);
    expect((await chatgpt.status(ann)).connected).toBe(false);
    // Signing in again reuses the client they registered, and has to be the same account.
    fake.refreshError = undefined;
    const again = approve(await chatgpt.start(ann, "http://localhost:8000"), "someone-else");
    expect(again.asked.get("client_id")).toBe("oaiapp_ann");
    expect(again.asked.has("agent_name_hint")).toBe(false);
    expect(again.asked.get("login_hint")).toBe("ann-sub@example.com");
    expect(await chatgpt.finish(again.back)).toMatchObject({
      connected: false,
      problem: expect.stringMatching(/different ChatGPT account/),
    });
    expect((await chatgpt.finish(approve(await chatgpt.start(ann, "http://localhost:8000")).back)).connected).toBe(true);
  });

  it("ends the session at OpenAI when they disconnect", async () => {
    const chatgpt = new ChatGPT(dir, { issuer });
    await chatgpt.finish(approve(await chatgpt.start(ann, "http://localhost:8000")).back);
    expect(await chatgpt.disconnect(ann)).toEqual({ revoked: true });
    expect(fake.revoked).toHaveLength(1);
    expect((await chatgpt.status(ann)).connected).toBe(false);
    await expect(chatgpt.access(ann)).rejects.toThrow(/Connect it again/);
    expect(readFileSync(join(dir, readdirOne(dir)), "utf8")).not.toMatch(/"(access|refresh|id)_token"/);
  });

  it("runs Codex on their plan the way OpenAI documents it, with the token in the environment and nowhere else", async () => {
    const chatgpt = new ChatGPT(dir, { issuer, model: "gpt-x" });
    await chatgpt.finish(approve(await chatgpt.start(ann, "http://localhost:8000")).back);
    const { agent, env } = await chatgpt.agentFor(ann);
    expect(env).toEqual({ COMPUTAH_CHATGPT_TOKEN: "a-ann-sub-0" });
    const { command, args, stdin } = agent.command("do it", "/repo");
    expect(command).toBe("codex");
    expect(stdin).toBe("do it");
    const line = args.join(" ");
    expect(line).toContain('model_providers.computah_chatgpt_plan.env_key="COMPUTAH_CHATGPT_TOKEN"');
    expect(line).toContain('model_providers.computah_chatgpt_plan.base_url="https://api.openai.com/v1"');
    expect(line).toContain("model_providers.computah_chatgpt_plan.requires_openai_auth=false");
    expect(line).toContain("--model gpt-x");
    expect(line).not.toContain("a-ann-sub-0");
    // Errors a person can act on are said in words.
    const said = planAgent().parse(
      JSON.stringify({ type: "turn.failed", error: { message: "429 subscription_sharing_usage_limit_exceeded" } }),
    );
    expect(said).toEqual([{ type: "error", message: expect.stringMatching(/usage limit/) }]);
    // A dropped connection that Codex is retrying isn't a failure.
    expect(planAgent().parse(JSON.stringify({ type: "error", message: "Reconnecting... 2/5 (timeout)" }))).toEqual([]);
  });
});

describe("an app where people bring their own ChatGPT plan", () => {
  it("makes members connect first, runs their requests on their own sign-in, and leaves the owner's alone", async () => {
    const repo = mkdtempSync(join(tmpdir(), "computah-plan-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    run("init", "-q", "-b", "trunk");
    run("config", "user.email", "test@example.invalid");
    run("config", "user.name", "Test");
    run("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "page.txt"), "hello\n");
    writeFileSync(
      join(repo, "server.js"),
      `require("node:http").createServer((q, r) => r.end("app:" + q.url)).listen(process.env.PORT, "127.0.0.1");\n`,
    );
    writeFileSync(join(repo, ".gitignore"), "seen.txt\n");
    run("add", "-A");
    run("commit", "-qm", "start");
    // Stands in for Codex: notes the token it was handed and the arguments it got, makes a change, and speaks Codex's JSON.
    const seen = join(dir, "seen.txt");
    const pretend = join(dir, "codex");
    writeFileSync(
      pretend,
      `#!/bin/sh\nprintf '%s\\n' "$COMPUTAH_CHATGPT_TOKEN" > "${seen}"\nprintf '%s ' "$@" >> "${seen}"\ncat > /dev/null\necho "by codex" >> page.txt\necho '{"type":"item.completed","item":{"type":"agent_message","text":"Done on your plan."}}'\n`,
    );
    chmodSync(pretend, 0o755);
    const site = new Site({
      cwd: repo,
      agent: {
        name: "owners",
        command: () => ({ command: "sh", args: ["-c", `echo "by the owner's agent" >> page.txt; echo "RESULT ok"`] }),
        parse: (line) => (line.startsWith("RESULT ") ? [{ type: "result", text: line.slice(7) }] : []),
      },
      app: { start: "node server.js" },
      identity: header("x-user"),
      trust: { owners: ["olive"], members: ["mel"] },
      chatgpt: { issuer, require: "members", command: pretend },
    });
    await site.init();
    const front = createFrontServer(site);
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    const port = (front.address() as AddressInfo).port;
    // They use the app at localhost, as people do. The sign-in comes back to 127.0.0.1, as OpenAI requires.
    const base = `http://localhost:${port}`;
    const call = async (id: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}/__computah${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-user": id, ...(body === undefined ? {} : { "content-type": "application/json", "x-computah": "1" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: (await response.json()) as Record<string, unknown> & { job?: unknown; url?: unknown } };
    };
    const settle = async (id: string, job: Job) => {
      for (let i = 0; i < 400; i++) {
        const { data } = await call(id, `/jobs/${job.id}`);
        if (!["queued", "working"].includes((data.job as unknown as Job).state)) return data.job as unknown as Job;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("never settled");
    };
    try {
      // A member hasn't connected: they're told so, and can't ask for anything yet.
      expect((await call("mel", "/me")).data.chatgpt).toEqual({ connected: false, required: true });
      expect(await call("mel", "/jobs", { text: "more" })).toMatchObject({
        status: 402,
        data: { error: "Connect your ChatGPT account first." },
      });
      // A visitor isn't offered it at all.
      expect((await call("nobody", "/me")).data.chatgpt).toBeUndefined();
      expect((await call("nobody", "/chatgpt/start", {})).status).toBe(403);

      // They connect. The browser goes to ChatGPT and comes back to the page it left.
      const { data } = await call("mel", "/chatgpt/start", { path: "/somewhere?a=1" });
      expect(data.paste).toBe(false);
      const { asked, back } = approve(data.url as unknown as string, "mel-sub", { issued: "oaiapp_mel" });
      expect(asked.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/auth/callback`);
      const returned = await fetch(`http://127.0.0.1:${port}/auth/callback?${back}`, { redirect: "manual" });
      expect(returned.status).toBe(302);
      expect(returned.headers.get("location")).toBe(`${base}/somewhere?a=1&computah-chatgpt=connected`);
      expect((await call("mel", "/me")).data.chatgpt).toEqual({ connected: true, email: "mel-sub@example.com", required: true });
      // The same path with nothing of ours in it is the app's own page.
      expect(await (await fetch(`${base}/auth/callback?state=not-ours`, { headers: { "x-user": "mel" } })).text()).toBe(
        "app:/auth/callback?state=not-ours",
      );

      // Their request is made by Codex with their token, handed over in the environment and never as an argument.
      const made = await settle("mel", (await call("mel", "/jobs", { text: "more" })).data.job as unknown as Job);
      expect(made).toMatchObject({ state: "done", agent: "codex (chatgpt plan)", summary: "Done on your plan." });
      const [token, args] = readFileSync(seen, "utf8").split("\n");
      expect(token).toBe("a-mel-sub-0");
      expect(args).toContain("computah_chatgpt_plan");
      expect(args).not.toContain("a-mel-sub-0");

      // The owner doesn't have to connect, and their requests still go to the app's own agent.
      const owners = await settle("olive", (await call("olive", "/jobs", { text: "mine" })).data.job as unknown as Job);
      expect(owners).toMatchObject({ state: "done", agent: "owners" });

      // Reached at an address that isn't this machine, the same sign-in is finished by pasting where it ended up.
      const away = await fetch(`http://127.0.0.1:${port}/__computah/chatgpt/start`, {
        method: "POST",
        // As a proxy in front of a hosted app would send it on.
        headers: {
          "x-user": "olive",
          origin: "https://app.example.com",
          "x-forwarded-host": "app.example.com",
          "content-type": "application/json",
          "x-computah": "1",
        },
        body: JSON.stringify({ path: "/" }),
      });
      const begun = (await away.json()) as { url: string; paste: boolean };
      expect(begun.paste).toBe(true);
      const landed = `http://127.0.0.1:1455/auth/callback?${approve(begun, "olive-sub", { issued: "oaiapp_olive" }).back}`;
      expect((await call("mel", "/chatgpt/finish", { address: landed })).status).toBe(403);
      expect((await call("olive", "/chatgpt/finish", { address: "not an address" })).status).toBe(400);
      expect((await call("olive", "/chatgpt/finish", { address: landed })).data).toEqual({ connected: true });
      expect((await call("olive", "/me")).data.chatgpt).toMatchObject({ connected: true, email: "olive-sub@example.com" });

      // Disconnecting ends it: OpenAI is told, and they're back to having to connect.
      expect((await call("mel", "/chatgpt/disconnect", {})).data).toEqual({ revoked: true });
      expect(fake.revoked).toHaveLength(1);
      expect((await call("mel", "/jobs", { text: "again" })).status).toBe(402);
    } finally {
      front.close();
      await site.stop();
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30_000);
});

function readdirOne(folder: string): string {
  const found = readdirSync(folder).filter((name) => name.endsWith(".json") && name !== "host.json");
  expect(found).toHaveLength(1);
  return found[0] as string;
}
