// Odoo auto-login plugin for steel-browser (ledoent).
//
// Logs the session's Chrome into the in-cluster Odoo at onBrowserReady, so
// oca-review / oca-ux browser passes and the demo viewer land on an
// authenticated backend instead of each re-running a login dance. Mirrors the
// proven selectors + gotchas from ws3-harness/driver.mjs odooLogin().
//
// No-op unless STEEL_ODOO_AUTOLOGIN=true. Config (read once at construction):
//   STEEL_ODOO_AUTOLOGIN   "true" to arm (default off)
//   STEEL_ODOO_BASE        e.g. http://odoo-19:8069
//   STEEL_ODOO_DB          target db (multi-db host needs this)
//   STEEL_ODOO_LOGIN       default "admin"
//   STEEL_ODOO_PASSWORD    default "admin"

import type { Page } from "puppeteer-core";
import { BasePlugin, PluginOptions } from "./core/base-plugin.js";

interface OdooConfig {
  enabled: boolean;
  base: string;
  db: string;
  login: string;
  password: string;
}

function readConfig(): OdooConfig {
  return {
    enabled: process.env.STEEL_ODOO_AUTOLOGIN === "true",
    base: process.env.STEEL_ODOO_BASE || "http://odoo-19:8069",
    db: process.env.STEEL_ODOO_DB || "",
    login: process.env.STEEL_ODOO_LOGIN || "admin",
    password: process.env.STEEL_ODOO_PASSWORD || "admin",
  };
}

export class OdooAutoLoginPlugin extends BasePlugin {
  private cfg: OdooConfig;

  constructor(options: Partial<PluginOptions> = {}) {
    super({ name: "odoo-autologin", ...options });
    this.cfg = readConfig();
  }

  // onSessionStart fires BEFORE the browser launches (no Page yet) — announce
  // intent only.
  public override onSessionStart(): void {
    if (this.cfg.enabled) {
      this.log(`armed for ${this.cfg.base} (db=${this.cfg.db || "<none>"})`);
    }
  }

  // onBrowserReady fires after Chrome is up + the primary page refreshed. The
  // hook gets only the launch config, so reach the live Page via the injected
  // CDP service.
  public override async onBrowserReady(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (!this.cdpService) {
      this.log("no cdpService bound — skipping");
      return;
    }
    try {
      const page = await this.cdpService.getPrimaryPage();
      await this.login(page);
      this.log(`logged in → ${page.url()}`);
    } catch (e) {
      // Never abort session creation on a login failure — surface it and leave
      // the browser on the login page for a human to inspect.
      this.log(`auto-login FAILED: ${(e as Error).message}`, "warn");
    }
  }

  private async login(page: Page): Promise<void> {
    const { base, db, login, password } = this.cfg;
    const loginUrl = db
      ? `${base}/web/login?db=${encodeURIComponent(db)}`
      : `${base}/web/login`;

    // domcontentloaded, NOT networkidle — Odoo longpolls forever.
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Multi-db host (list_db=True, no dbfilter): ?db= alone doesn't bind on the
    // website-themed page — select it explicitly so the POST carries it.
    if (db && (await page.$('select[name="db"]'))) {
      await page.select('select[name="db"]', db).catch(() => []);
      await page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => null);
    }

    const userSel = 'input[name="login"], input[type="email"]';
    if (await page.$(userSel)) {
      await page.type(userSel, login);
      const pwSel = 'input[name="password"], input[type="password"]';
      if (await page.$(pwSel)) await page.type(pwSel, password);
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 })
          .catch(() => null),
        this.clickSubmit(page),
      ]);
    }

    // Force the backend so we don't linger on a portal/website landing.
    await page
      .goto(`${base}/odoo`, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => null);
    await page.waitForSelector(".o_main_navbar, .o_web_client", { timeout: 60000 });

    // Surface wrong-credentials loudly instead of returning a half-state.
    if (/\/web\/login/.test(page.url())) {
      const err = await page
        .$eval(".alert-danger, .o_login_invalid", (el) => el.textContent || "")
        .catch(() => "");
      throw new Error(`still on /web/login${err ? ": " + err.trim() : ""}`);
    }
  }

  private async clickSubmit(page: Page): Promise<void> {
    // Odoo's login submit is a btn-primary submit button; try the robust
    // selectors in order. (Avoid page.evaluate/document so the build doesn't
    // need the DOM lib in tsconfig.)
    for (const sel of [
      'button[type="submit"]',
      ".oe_login_form button",
      "button.btn-primary",
    ]) {
      if (await page.$(sel)) {
        await page.click(sel).catch(() => undefined);
        return;
      }
    }
  }

  private log(msg: string, level: "info" | "warn" = "info"): void {
    // eslint-disable-next-line no-console
    (level === "warn" ? console.warn : console.log)(`[odoo-autologin] ${msg}`);
  }
}
