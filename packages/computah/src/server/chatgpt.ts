import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codex } from "./agents.js";
import { type Person, slugFor } from "./identity.js";
import { RequestError } from "./jobs.js";
import type { Agent } from "./types.js";

/**
 * Sign in with ChatGPT: a person connects their own ChatGPT account, and from then on their
 * requests are made by Codex on their ChatGPT plan instead of on anything the app's owner pays for.
 *
 * OpenAI offers this two ways:
 * - Open-source and locally hosted apps need nothing from OpenAI. Each person registers a client
 *   of their own on first sign-in, and the sign-in comes back to 127.0.0.1 on the person's own
 *   machine. When that's also the runner's machine, the runner receives it. When it isn't, the
 *   page it lands on can't load, and the person pastes its address into the box to finish.
 * - An app with a client ID that OpenAI issued its owner sets `clientId`, and the sign-in comes
 *   back to the app's own address.
 *
 * OpenAI's guide points remotely hosted apps to the second. Which one an app may use is between
 * its owner and OpenAI.
 */
export interface ChatGPTOptions {
  /** The OAuth client ID OpenAI issued you. Leave out for the open-source flow, where each person registers a client of their own. */
  clientId?: string;
  /** For a confidential client: its secret. Sent only to OpenAI's token endpoint, as HTTP Basic. */
  clientSecret?: string;
  /** The exact callback URL registered for `clientId`. Default: this app's address plus `/__computah/chatgpt/callback`. */
  redirectUri?: string;
  /** What the person sees this app called when they approve it. Default "computah". */
  appName?: string;
  /** The model their requests use. Default: Codex's own default. */
  model?: string;
  /**
   * Who has to connect before they may send a request: "members" (people who aren't owners or
   * trusted), "everyone", or nobody (the default), in which case connecting is optional and a
   * person who hasn't is served by the app's own agent.
   */
  require?: "members" | "everyone";
  /** The scopes to ask for. Default: identity plus ChatGPT plan usage. */
  scopes?: string[];
  /** The Codex command, if it isn't `codex` on the PATH. */
  command?: string;
  /** OpenAI's issuer. Only tests change this. */
  issuer?: string;
}

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", PLAN_SCOPE];
const DYNAMIC = "dynamic_agent_client";
/** Where the open-source flow has to come back to. Only the port may differ. */
export const LOOPBACK_CALLBACK = "/auth/callback";
/** The port used when the runner isn't on the person's machine, so nothing is expected to answer there. It's the one OpenAI's guide uses. */
const AWAY_PORT = 1455;
/** Refresh codes that mean the session is gone for good, as opposed to a bad moment on the network. */
const DEAD = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

/** What is kept for one person. Tokens are absent after signing out; the client they registered is kept for next time. */
interface Connection {
  person: string;
  client_id: string;
  subject: string;
  email?: string;
  issuer: string;
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  /** When the access token stops working, in milliseconds. */
  expires_at?: number;
  /** Not before this, in milliseconds, if OpenAI said so. */
  earliest_refresh_at?: number;
  scopes: string[];
  saved_at: string;
}

interface Attempt {
  person: Person;
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** The client this attempt was started with: an issued one, or the registration entrypoint. */
  clientId: string;
  /** Where to send the browser afterwards: the page they were on, at the address they were using. */
  back: string;
  expiresAt: number;
}

interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const random = (bytes = 32) => randomBytes(bytes).toString("base64url");

export class ChatGPT {
  private attempts = new Map<string, Attempt>();
  private refreshing = new Map<string, Promise<string>>();
  private endpoints: Promise<Endpoints> | null = null;
  private keys: { at: number; list: Record<string, unknown>[] } | null = null;
  private host: Promise<string> | null = null;

  constructor(
    /** Where connections are kept. Each is a file only this user can read. */
    private dir: string,
    private options: ChatGPTOptions = {},
  ) {}

  private get issuer() {
    return (this.options.issuer ?? ISSUER).replace(/\/+$/, "");
  }

  private get scopes() {
    return this.options.scopes ?? SCOPES;
  }

  /** Whether this person has to connect before sending a request. `member` says they are neither an owner nor trusted. */
  requires(member: boolean): boolean {
    return this.options.require === "everyone" || (this.options.require === "members" && member);
  }

  // ---------- storage ----------

  private file(person: Person) {
    return join(this.dir, `${slugFor(person)}.json`);
  }

  private async read(person: Person): Promise<Connection | null> {
    try {
      const saved = JSON.parse(await readFile(this.file(person), "utf8")) as Connection;
      // Two people can't share a file, but check anyway: a connection is only ever its own person's.
      return saved.person === person.id && saved.issuer === this.issuer ? saved : null;
    } catch {
      return null;
    }
  }

  /** Written whole to a new file and moved into place, so a crash never leaves half a token set. */
  private async write(person: Person, connection: Connection) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(person);
    const fresh = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(fresh, JSON.stringify(connection, null, 2), { mode: 0o600 });
    await rename(fresh, target);
  }

  /** A stable name for this runner, which OpenAI asks for. It identifies the machine, not anyone using it. */
  private hostId(): Promise<string> {
    this.host ??= (async () => {
      const path = join(this.dir, "host.json");
      try {
        const saved = JSON.parse(await readFile(path, "utf8")) as { id?: string };
        if (typeof saved.id === "string" && saved.id) return saved.id;
      } catch {
        // First time here.
      }
      const id = `urn:uuid:${randomUUID()}`;
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify({ id }), { mode: 0o600 });
      return id;
    })();
    return this.host;
  }

  // ---------- talking to OpenAI ----------

  private discover(): Promise<Endpoints> {
    this.endpoints ??= fetch(`${this.issuer}/.well-known/openid-configuration`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`discovery answered ${response.status}`);
        const found = (await response.json()) as Endpoints & { issuer?: string };
        if (found.issuer !== this.issuer) throw new Error("discovery named a different issuer");
        return found;
      })
      .catch((error: unknown) => {
        this.endpoints = null;
        throw new RequestError(`Couldn't reach ChatGPT's sign-in. ${error instanceof Error ? error.message : ""}`.trim(), 502);
      });
    return this.endpoints;
  }

  private async token(body: Record<string, string>): Promise<{ status: number; data: Record<string, unknown> }> {
    const { token_endpoint } = await this.discover();
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
    const { clientId, clientSecret } = this.options;
    if (clientId && clientSecret) {
      const part = (value: string) => new URLSearchParams({ value }).toString().slice("value=".length);
      headers.authorization = `Basic ${Buffer.from(`${part(clientId)}:${part(clientSecret)}`).toString("base64")}`;
    }
    const response = await fetch(token_endpoint, { method: "POST", headers, body: new URLSearchParams(body) });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, data };
  }

  /** Check an ID token really is OpenAI's, for this client, and from this attempt. Returns who it names. */
  private async identify(idToken: string, clientId: string, nonce?: string): Promise<{ sub: string; email?: string }> {
    const refuse = (why: string) => new RequestError(`ChatGPT's answer couldn't be verified (${why}).`, 502);
    const [head, body, signature] = idToken.split(".");
    if (!head || !body || !signature) throw refuse("it isn't a token");
    let header: { alg?: string; kid?: string };
    let claims: { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string };
    try {
      header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw refuse("it isn't a token");
    }
    if (header.alg !== "RS256") throw refuse("unexpected signing method");
    const find = (list: Record<string, unknown>[]) => list.find((key) => key.kid === header.kid && key.kty === "RSA");
    let key = this.keys && Date.now() - this.keys.at < 60 * 60_000 ? find(this.keys.list) : undefined;
    if (!key) {
      // Unknown key: OpenAI may have rotated theirs, so fetch the current set once.
      const { jwks_uri } = await this.discover();
      const response = await fetch(jwks_uri);
      if (!response.ok) throw refuse("no signing keys");
      this.keys = { at: Date.now(), list: ((await response.json()) as { keys?: Record<string, unknown>[] }).keys ?? [] };
      key = find(this.keys.list);
    }
    if (!key) throw refuse("unknown signing key");
    const valid = verify(
      "RSA-SHA256",
      Buffer.from(`${head}.${body}`),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    );
    if (!valid) throw refuse("bad signature");
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.issuer) throw refuse("wrong issuer");
    if (!audience.includes(clientId)) throw refuse("meant for another app");
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 5000) throw refuse("expired");
    if (nonce !== undefined && claims.nonce !== nonce) throw refuse("from another sign-in attempt");
    if (typeof claims.sub !== "string" || !claims.sub) throw refuse("names nobody");
    return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : undefined };
  }

  // ---------- signing in ----------

  /**
   * Begin a sign-in for this person and return the address to send their browser to.
   * `origin` is the address they're using the app at, and `path` the page to bring them back to.
   */
  async start(person: Person, origin: string, path = "/"): Promise<{ url: string; paste: boolean }> {
    const { authorization_endpoint } = await this.discover();
    const saved = await this.read(person);
    const at = new URL(origin);
    let redirectUri: string;
    let clientId: string;
    let paste = false;
    if (this.options.clientId) {
      clientId = this.options.clientId;
      redirectUri = this.options.redirectUri ?? `${at.origin}/__computah/chatgpt/callback`;
    } else {
      // The open-source flow comes back to 127.0.0.1, which is the person's own machine. If that's
      // this machine too, the runner gets the answer itself. If not, the page won't load, and they
      // paste its address back to finish.
      const here = ["localhost", "127.0.0.1", "[::1]"].includes(at.hostname) || at.hostname.endsWith(".localhost");
      paste = !here;
      clientId = saved?.client_id ?? DYNAMIC;
      redirectUri = `http://127.0.0.1:${here ? at.port || "80" : AWAY_PORT}${LOOPBACK_CALLBACK}`;
    }
    const state = random();
    const verifier = random(48);
    const nonce = random();
    // Only ever send them back to a page of this app, at the address they came from.
    const back = `${at.origin}${path.startsWith("/") && !path.startsWith("//") ? path : "/"}`;
    for (const [key, attempt] of this.attempts) if (attempt.expiresAt < Date.now()) this.attempts.delete(key);
    this.attempts.set(state, { person, verifier, nonce, redirectUri, clientId, back, expiresAt: Date.now() + 10 * 60_000 });

    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: this.scopes.join(" "),
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    });
    if (!this.options.clientId) {
      query.set("ext_agent_host_id", await this.hostId());
      if (clientId === DYNAMIC) query.set("agent_name_hint", this.options.appName ?? "computah");
    }
    // Someone who has connected before skips choosing their account again.
    if (saved?.id_token) query.set("id_token_hint", saved.id_token);
    if (saved?.email) query.set("login_hint", saved.email);
    return { url: `${authorization_endpoint}?${query}`, paste };
  }

  /** Whether a callback belongs to a sign-in this runner started. Lets the front door tell its own callbacks from the app's pages. */
  expects(state: string | null): boolean {
    return !!state && this.attempts.has(state);
  }

  /**
   * Finish a sign-in from what OpenAI sent back. Returns where to send the browser, and whether
   * the person is now connected. The attempt is used up either way.
   *
   * `by` is who is handing the answer over, when a person does it themselves by pasting. An
   * answer can only be finished by the person who started that sign-in.
   */
  async finish(query: URLSearchParams, by?: Person): Promise<{ back: string; connected: boolean; problem?: string }> {
    const state = query.get("state") ?? "";
    const attempt = this.attempts.get(state);
    // Someone else's answer is refused without using it up, so it can't be spoiled for its owner.
    if (attempt && by && attempt.person.id !== by.id) throw new RequestError("That sign-in was started by someone else.", 403);
    this.attempts.delete(state);
    if (!attempt || attempt.expiresAt < Date.now()) throw new RequestError("That sign-in has expired. Start it again from the app.", 400);
    const fail = (problem: string) => ({ back: attempt.back, connected: false, problem });
    if (query.get("error"))
      return fail(
        query.get("error") === "access_denied" ? "You didn't allow it, so nothing was connected." : "ChatGPT didn't complete the sign-in.",
      );
    const code = query.get("code");
    if (!code) return fail("ChatGPT didn't complete the sign-in.");

    // A first registration is told its new client ID here. A returning one already has it, and may not be handed another.
    const returned = query.get("client_id");
    let clientId = attempt.clientId;
    if (clientId === DYNAMIC) {
      if (!returned || returned === DYNAMIC) return fail("ChatGPT didn't finish registering this app. Try again.");
      clientId = returned;
    } else if (returned && returned !== clientId) return fail("ChatGPT answered for a different app.");

    const { status, data } = await this.token({
      grant_type: "authorization_code",
      code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      client_id: clientId,
      resource: RESOURCE,
    });
    if (status !== 200 || typeof data.id_token !== "string") return fail("ChatGPT didn't complete the sign-in. Try again.");
    const who = await this.identify(data.id_token, clientId, attempt.nonce);
    const before = await this.read(attempt.person);
    // Someone reconnecting must come back as the same account. A different one starts over as a new registration.
    if (before && before.client_id === clientId && before.subject !== who.sub)
      return fail("That's a different ChatGPT account from the one connected here.");
    const scopes = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : [];
    const usable = scopes.includes(PLAN_SCOPE) && typeof data.access_token === "string";
    await this.write(attempt.person, this.record(attempt.person.id, clientId, who, data, scopes));
    return usable ? { back: attempt.back, connected: true } : fail("You're signed in, but didn't allow this app to use your ChatGPT plan.");
  }

  private record(
    person: string,
    clientId: string,
    who: { sub: string; email?: string },
    data: Record<string, unknown>,
    scopes: string[],
  ): Connection {
    const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
    const seconds = typeof data.expires_in === "number" ? data.expires_in : 3600;
    const earliest =
      typeof data.earliest_refresh_at === "number" ? data.earliest_refresh_at : Date.parse(text(data.earliest_refresh_at) ?? "");
    return {
      person,
      client_id: clientId,
      subject: who.sub,
      email: who.email,
      issuer: this.issuer,
      id_token: text(data.id_token),
      access_token: text(data.access_token),
      refresh_token: text(data.refresh_token),
      expires_at: Date.now() + seconds * 1000,
      // OpenAI gives this in seconds or as a date. Either way it's kept in milliseconds.
      earliest_refresh_at: Number.isFinite(earliest) ? (earliest < 1e12 ? earliest * 1000 : earliest) : undefined,
      scopes,
      saved_at: new Date().toISOString(),
    };
  }

  // ---------- using it ----------

  /** Whether this person is connected, and as whom. Never includes a token. */
  async status(person: Person | null): Promise<{ connected: boolean; email?: string }> {
    const saved = person ? await this.read(person) : null;
    return {
      connected: !!saved?.refresh_token && saved.scopes.includes(PLAN_SCOPE),
      email: saved?.refresh_token ? saved.email : undefined,
    };
  }

  /** A working access token for this person, renewed if it's about to run out. Throws if they have to sign in again. */
  access(person: Person): Promise<string> {
    // One renewal at a time per person: the refresh token is replaced each time, and two at once would burn it.
    const running = this.refreshing.get(person.id);
    if (running) return running;
    const getting = this.fresh(person).finally(() => this.refreshing.delete(person.id));
    this.refreshing.set(person.id, getting);
    return getting;
  }

  private async fresh(person: Person): Promise<string> {
    const again = new RequestError("Your ChatGPT sign-in has ended. Connect it again.", 401);
    const saved = await this.read(person);
    if (!saved?.refresh_token || !saved.scopes.includes(PLAN_SCOPE)) throw again;
    const now = Date.now();
    const lasts = (saved.expires_at ?? 0) - now;
    const mayRefresh = saved.earliest_refresh_at === undefined || saved.earliest_refresh_at <= now;
    // Good for a while yet, or too early to renew and still valid: use what there is.
    if (saved.access_token && (lasts > 5 * 60_000 || (!mayRefresh && lasts > 0))) return saved.access_token;

    const { status, data } = await this.token({
      grant_type: "refresh_token",
      client_id: saved.client_id,
      refresh_token: saved.refresh_token,
      resource: RESOURCE,
    }).catch(() => ({ status: 0, data: {} as Record<string, unknown> }));
    if (status === 200 && typeof data.access_token === "string") {
      const scopes = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : saved.scopes;
      const next = this.record(
        person.id,
        saved.client_id,
        { sub: saved.subject, email: saved.email },
        { ...data, id_token: data.id_token ?? saved.id_token },
        scopes,
      );
      // The replacement refresh token is the only one that works from here on, so it is saved before anything uses the access token.
      next.refresh_token ??= saved.refresh_token;
      await this.write(person, next);
      if (!next.access_token) throw again;
      return next.access_token;
    }
    const code = typeof data.error === "string" ? data.error : "";
    if (DEAD.has(code)) {
      // The session is over. Keep who they are and the client they registered, so signing in again is quick.
      await this.write(person, { ...saved, access_token: undefined, refresh_token: undefined, expires_at: undefined });
      throw again;
    }
    // A bad moment, not a dead session: nothing is erased. Use the current token if it still has life in it.
    if (saved.access_token && lasts > 0) return saved.access_token;
    throw new RequestError("Couldn't reach ChatGPT to renew your sign-in. Try again in a moment.", 503);
  }

  /** The agent for this person's requests: Codex, on their ChatGPT plan. */
  async agentFor(person: Person): Promise<{ agent: Agent; env: Record<string, string> }> {
    const token = await this.access(person);
    return { agent: planAgent(this.options.model, this.options.command), env: { COMPUTAH_CHATGPT_TOKEN: token } };
  }

  /** Sign this person out: end the session at OpenAI and forget their tokens. Says whether OpenAI confirmed it. */
  async disconnect(person: Person): Promise<{ revoked: boolean }> {
    const saved = await this.read(person);
    if (!saved) return { revoked: true };
    let revoked = !saved.refresh_token;
    if (saved.refresh_token) {
      const { revocation_endpoint } = await this.discover().catch(() => ({ revocation_endpoint: undefined }) as Partial<Endpoints>);
      if (revocation_endpoint) {
        const body = new URLSearchParams({ token: saved.refresh_token, token_type_hint: "refresh_token", client_id: saved.client_id });
        for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
          const response = await fetch(revocation_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
          }).catch(() => null);
          if (response?.status === 200) revoked = true;
          else if (response && response.status < 500) break;
          else await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
    }
    // Local tokens go either way. The client they registered stays, for the next sign-in.
    await this.write(person, { ...saved, access_token: undefined, refresh_token: undefined, id_token: undefined, expires_at: undefined });
    return { revoked };
  }
}

/**
 * Codex pointed at a person's ChatGPT plan, the way OpenAI documents it: a provider that sends
 * their sign-in's access token, read from the environment, with no Codex login of its own.
 */
export function planAgent(model?: string, command?: string): Agent {
  const provider = "computah_chatgpt_plan";
  const set = (key: string, value: string) => ["-c", `${key}=${value}`];
  const agent = codex({
    model,
    args: [
      ...set("model_provider", `"${provider}"`),
      ...set(`model_providers.${provider}.name`, '"ChatGPT plan"'),
      ...set(`model_providers.${provider}.base_url`, `"${RESOURCE}"`),
      ...set(`model_providers.${provider}.env_key`, '"COMPUTAH_CHATGPT_TOKEN"'),
      ...set(`model_providers.${provider}.wire_api`, '"responses"'),
      ...set(`model_providers.${provider}.requires_openai_auth`, "false"),
      ...set(`model_providers.${provider}.supports_websockets`, "false"),
      // A checkout made for one person isn't a repo Codex has been told to trust.
      "--skip-git-repo-check",
    ],
  });
  return {
    name: "codex (chatgpt plan)",
    command: (prompt, cwd) => ({ ...agent.command(prompt, cwd), ...(command ? { command } : {}) }),
    parse(line) {
      // A plan that has run out, or isn't allowed here, should say so in words the person can act on.
      return agent.parse(line).map((event) => {
        if (event.type !== "error") return event;
        if (/subscription_sharing_usage_limit_exceeded/.test(event.message))
          return {
            type: "error" as const,
            message: "You've reached your ChatGPT usage limit for now. You can check it at chatgpt.com/settings/usage.",
          };
        if (/subscription_sharing_user_not_eligible/.test(event.message))
          return {
            type: "error" as const,
            message: "Your ChatGPT account can't be used in other apps (its plan or workspace doesn't allow it).",
          };
        if (/subscription_sharing_invalid_user|401 Unauthorized/.test(event.message))
          return { type: "error" as const, message: "ChatGPT didn't accept your sign-in. Connect it again." };
        return event;
      });
    },
  };
}
