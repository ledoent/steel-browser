// Odoo auto-login plugin for steel-browser (ledoent).
//
// Pre-authenticates a session's Chrome into the in-cluster Odoo so the live
// view / agent lands on the backend. Identity is PER SESSION — there is no
// pod-level super-user default. Each consumer has its own role/login.
//
// Where creds come from, in priority order:
//   1. Per-session, set by the caller in POST /v1/sessions:
//        { "userPreferences": { "odoo": {
//            "db": "<db>", "login": "<user>", "password": "<pw>",
//            "base": "http://odoo-19:8069"   // optional; defaults to STEEL_ODOO_BASE
//        } } }
//      → logs in as THAT identity (the agent's own role).
//   2. Demo fallback (human/demo viewer opening a session with no creds):
//        STEEL_ODOO_DEMO_DB / STEEL_ODOO_DEMO_LOGIN / STEEL_ODOO_DEMO_PASSWORD
//      → a single, narrow demo identity. Leave unset to disable the fallback.
//   3. Neither → NO-OP. We never log in as a guessed/default identity.
//
// Master switch: STEEL_ODOO_AUTOLOGIN=true (else the whole plugin no-ops).
// Default base for per-session creds that omit `base`: STEEL_ODOO_BASE.
//
// onBrowserReady is awaited inside steel's 60s-bounded launch path, so the
// login runs fire-and-forget (off the critical path) — it can never block or
// fail session creation. Mirrors ws3-harness/driver.mjs odooLogin().

import type { Page } from "puppeteer-core";
import { BasePlugin, PluginOptions, BrowserLauncherOptions } from "./core/base-plugin.js";

interface OdooCreds {
  base: string;
  db: string;
  login: string;
  password: string;
  source: "session" | "demo";
}

interface PluginCfg {
  enabled: boolean;
  defaultBase: string;
  demo: { base: string; db: string; login: string; password: string } | null;
}

function readCfg(): PluginCfg {
  const defaultBase = process.env.STEEL_ODOO_BASE || "http://odoo-19:8069";
  const dLogin = process.env.STEEL_ODOO_DEMO_LOGIN;
  const dPass = process.env.STEEL_ODOO_DEMO_PASSWORD;
  const demo =
    dLogin && dPass
      ? {
          base: process.env.STEEL_ODOO_DEMO_BASE || defaultBase,
          db: process.env.STEEL_ODOO_DEMO_DB || "",
          login: dLogin,
          password: dPass,
        }
      : null;
  return {
    enabled: process.env.STEEL_ODOO_AUTOLOGIN === "true",
    defaultBase,
    demo,
  };
}

export class OdooAutoLoginPlugin extends BasePlugin {
  private cfg: PluginCfg;
  // Resolved in onSessionStart (per session), consumed by the next
  // onBrowserReady. null ⇒ this session does not auto-login.
  private pending: OdooCreds | null = null;

  constructor(options: Partial<PluginOptions> = {}) {
    super({ name: "odoo-autologin", ...options });
    this.cfg = readCfg();
  }

  // Resolve the identity for THIS session: caller-supplied creds first, demo
  // fallback second, otherwise none. No super-user default.
  private resolve(sessionConfig?: BrowserLauncherOptions): OdooCreds | null {
    const s = (sessionConfig?.userPreferences as Record<string, any> | undefined)?.odoo as
      | Record<string, string>
      | undefined;
    if (s && s.login && s.password) {
      return {
        base: s.base || this.cfg.defaultBase,
        db: s.db || "",
        login: s.login,
        password: s.password,
        source: "session",
      };
    }
    if (this.cfg.demo) {
      return { ...this.cfg.demo, source: "demo" };
    }
    return null;
  }

  // onSessionStart fires BEFORE launch and ONLY for real sessions (POST
  // /v1/sessions) — not the idle boot browser. Resolve+arm the identity here.
  public override onSessionStart(sessionConfig: BrowserLauncherOptions): void {
    if (!this.cfg.enabled) return;
    this.pending = this.resolve(sessionConfig);
    if (this.pending) {
      this.log(
        `armed (${this.pending.source}) → ${this.pending.login}@${this.pending.base} db=${this.pending.db || "<none>"}`,
      );
    } else {
      this.log("no per-session creds and no demo fallback — not logging in");
    }
  }

  public override onBrowserReady(): void {
    // Fire-and-forget: do NOT block the 60s-bounded launch path.
    if (!this.cfg.enabled || !this.cdpService || !this.pending) return;
    const creds = this.pending;
    this.pending = null;
    void this.runLogin(creds);
  }

  private async runLogin(creds: OdooCreds): Promise<void> {
    const cdp = this.cdpService;
    if (!cdp) return;
    // Let steel finish wiring the session's primary page (it refreshes the
    // primary target right after ready; a page grabbed too eagerly detaches).
    await this.sleep(1500);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const page = await cdp.getPrimaryPage();
        await this.login(page, creds);
        this.log(`logged in (${creds.source}) → ${page.url()}`);
        return;
      } catch (e) {
        const msg = (e as Error).message;
        const swap = /detached|Target closed|Session closed|Execution context|Cannot find context/i.test(msg);
        if (attempt < 2 && swap) {
          this.log(`attempt ${attempt} hit a page swap (${msg.slice(0, 60)}…); retrying`, "warn");
          await this.sleep(2000);
          continue;
        }
        // Background task — a failure (wrong creds/db, browser torn down) is
        // logged and swallowed; it can't affect session creation.
        this.log(`auto-login skipped/failed: ${msg}`, "warn");
        return;
      }
    }
  }

  private async login(page: Page, creds: OdooCreds): Promise<void> {
    const { base, db, login, password } = creds;
    const loginUrl = db
      ? `${base}/web/login?db=${encodeURIComponent(db)}`
      : `${base}/web/login`;

    // domcontentloaded, NOT networkidle — Odoo longpolls forever.
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for the login form to render (website-themed builds add it a beat
    // after domcontentloaded).
    const userSel = 'input[name="login"], input[type="email"]';
    const userField = await page
      .waitForSelector(userSel, { visible: true, timeout: 15000 })
      .catch(() => null);
    if (!userField) {
      throw new Error("login form never appeared");
    }

    await page.type(userSel, login);
    const pwH = await page.$('input[name="password"], input[type="password"]');
    if (pwH) await pwH.type(password);

    // Bind the db and submit the LOGIN form specifically. Two website-theme
    // traps this avoids:
    //   1. The db field is an <input name="db"> (text), not a <select>, and
    //      ?db= doesn't reliably prefill it — set it explicitly.
    //   2. The page has MULTIPLE <button type=submit> (the website search form's
    //      precedes the login form's in the DOM), so clicking the first submit
    //      on the page submits SEARCH, never the login → bounce back to /login.
    //      Scope to the form that actually contains the login field.
    const prep = await page
      .evaluate((dbName) => {
        const loginEl = document.querySelector('input[name="login"], input[type="email"]');
        const form = (loginEl && loginEl.closest("form")) as HTMLFormElement | null;
        if (!form) return "no-login-form";
        if (dbName) {
          const dbEl = form.querySelector('input[name="db"], select[name="db"]') as
            | HTMLInputElement
            | HTMLSelectElement
            | null;
          if (dbEl) {
            (dbEl as HTMLInputElement).value = dbName;
            dbEl.dispatchEvent(new Event("input", { bubbles: true }));
            dbEl.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        return "ok";
      }, db)
      .catch((e) => `err:${e}`);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null),
      page
        .evaluate(() => {
          const loginEl = document.querySelector('input[name="login"], input[type="email"]');
          const form = (loginEl && loginEl.closest("form")) as HTMLFormElement | null;
          if (!form) return;
          const btn = form.querySelector('button[type="submit"], button:not([type])') as
            | HTMLButtonElement
            | null;
          if (btn) btn.click();
          else if (form.requestSubmit) form.requestSubmit();
          else form.submit();
        })
        .catch(() => undefined),
    ]);
    this.log(`submitted login form (${prep})`);

    // Force the backend so we don't linger on a portal/website landing.
    await page
      .goto(`${base}/odoo`, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => null);
    await page.waitForSelector(".o_main_navbar, .o_web_client", { timeout: 60000 });

    if (/\/web\/login/.test(page.url())) {
      const err = await page
        .$eval(".alert-danger, .o_login_invalid", (el) => el.textContent || "")
        .catch(() => "");
      throw new Error(`still on /web/login${err ? ": " + err.trim() : ""}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private log(msg: string, level: "info" | "warn" = "info"): void {
    // eslint-disable-next-line no-console
    (level === "warn" ? console.warn : console.log)(`[odoo-autologin] ${msg}`);
  }
}
