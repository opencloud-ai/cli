import { chromium } from "playwright";
import { z } from "zod";

const uiAppSchema = z.object({
  id: z.uuid(),
  visibility: z.enum(["public", "private"]),
  state: z.string(),
  activeDeploymentId: z.uuid().nullable(),
  appUrl: z.url(),
  authUrl: z.url(),
});

interface BrowserRequestResult {
  ok(): boolean;
  status(): number;
}

interface UiPage {
  on(event: string, listener: (...args: any[]) => void): void;
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<unknown>;
  waitForLoadState(
    state: "networkidle",
    options: { timeout: number },
  ): Promise<void>;
  waitForTimeout(milliseconds: number): Promise<void>;
  evaluate<T>(callback: () => Promise<T>): Promise<T>;
  url(): string;
}

interface UiBrowserContext {
  request: {
    post(
      url: string,
      options: {
        data: Record<string, string>;
        failOnStatusCode: boolean;
        timeout: number;
      },
    ): Promise<BrowserRequestResult>;
  };
  newPage(): Promise<UiPage>;
}

interface UiBrowser {
  newContext(options: {
    ignoreHTTPSErrors: boolean;
  }): Promise<UiBrowserContext>;
  close(): Promise<void>;
}

interface UiBrowserLauncher {
  launch(options: {
    headless: boolean;
    executablePath?: string;
  }): Promise<UiBrowser>;
}

export interface VerifyAppUiOptions {
  chromiumPath?: string;
  timeoutMs?: number;
  email?: string;
  password?: string;
  requireInteraction?: boolean;
  launcher?: UiBrowserLauncher;
}

type InteractionCoverage = "view-transition" | "state-assertion";

interface BrowserEvaluation {
  title: string;
  visibleTextLength: number;
  landmarkCount: number;
  sdk: {
    package: string;
    version: string;
    module: string;
    types: string;
    exportedVersion: string;
    configMatched: boolean;
    typesStatus: number;
  };
  session: "established" | "none";
  interactionContract: {
    declared: boolean;
    required: boolean;
    checks: string[];
    coverage: InteractionCoverage[];
  };
}

function diagnosticText(value: unknown): string {
  const source =
    value instanceof Error
      ? `${value.name}: ${value.message}`
      : typeof value === "string"
        ? value
        : String(value);
  return source
    .replace(/([?&](?:token|key|secret|password|code)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]")
    .slice(0, 500);
}

function requiredPrivateCredentials(
  app: z.infer<typeof uiAppSchema>,
  options: VerifyAppUiOptions,
): { email: string; password: string } | null {
  if (app.visibility === "public") return null;
  const email =
    options.email ?? process.env.OPENCLOUD_VERIFY_USER_A_EMAIL;
  const password =
    options.password ?? process.env.OPENCLOUD_VERIFY_USER_A_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Private UI verification requires OPENCLOUD_VERIFY_USER_A_EMAIL and OPENCLOUD_VERIFY_USER_A_PASSWORD",
    );
  }
  return { email, password };
}

export async function verifyAppUi(
  rawApp: unknown,
  options: VerifyAppUiOptions = {},
): Promise<Record<string, unknown>> {
  const app = uiAppSchema.parse(rawApp);
  if (app.state !== "active" || !app.activeDeploymentId) {
    throw new Error("UI verification requires an active deployment");
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const credentials = requiredPrivateCredentials(app, options);
  const launcher = options.launcher ?? (chromium as unknown as UiBrowserLauncher);
  let browser: UiBrowser;
  try {
    browser = await launcher.launch({
      headless: true,
      ...(options.chromiumPath
        ? { executablePath: options.chromiumPath }
        : {}),
    });
  } catch (error) {
    throw new Error(
      `Could not launch Chromium for OpenCloud UI verification. Run "npx playwright install chromium" or set OPENCLOUD_CHROMIUM_PATH. ${diagnosticText(error)}`,
    );
  }

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const serverErrors: string[] = [];
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    if (credentials) {
      const login = await context.request.post(
        `${app.authUrl}/v1/auth/_internal/verifier-session`,
        {
          data: credentials,
          failOnStatusCode: false,
          timeout: timeoutMs,
        },
      );
      if (!login.ok()) {
        throw new Error(
          `Central Auth login returned HTTP ${login.status()}`,
        );
      }
    }

    const page = await context.newPage();
    const appOrigin = new URL(app.appUrl).origin;
    page.on("console", (message: { type(): string; text(): string }) => {
      if (message.type() === "error") {
        consoleErrors.push(diagnosticText(message.text()));
      }
    });
    page.on("pageerror", (error: Error) => {
      pageErrors.push(diagnosticText(error));
    });
    page.on(
      "requestfailed",
      (request: {
        url(): string;
        failure(): { errorText?: string } | null;
      }) => {
        const url = new URL(request.url());
        if (url.origin === appOrigin) {
          failedRequests.push(
            `${url.pathname}: ${diagnosticText(
              request.failure()?.errorText ?? "request failed",
            )}`,
          );
        }
      },
    );
    page.on(
      "response",
      (response: { status(): number; url(): string }) => {
        const url = new URL(response.url());
        if (url.origin === appOrigin && response.status() >= 500) {
          serverErrors.push(`${url.pathname}: HTTP ${response.status()}`);
        }
      },
    );

    await page.goto(app.appUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page
      .waitForLoadState("networkidle", {
        timeout: Math.min(timeoutMs, 5_000),
      })
      .catch(() => undefined);
    await page.waitForTimeout(750);

    const evaluation = await page.evaluate(async (): Promise<BrowserEvaluation> => {
      const response = await fetch("/_opencloud/config", {
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(`Runtime config returned HTTP ${response.status}`);
      }
      const runtime = await response.json() as {
        appId: string;
        visibility: "public" | "private";
        javascriptSdk: {
          package: string;
          version: string;
          module: string;
          types: string;
        };
      };
      const sdk = await import(runtime.javascriptSdk.module) as {
        OPEN_CLOUD_JS_VERSION?: string;
        createOpenCloudClient?: () => {
          config(): Promise<{ appId: string; javascriptSdk: { version: string } }>;
          session(): Promise<unknown>;
          dispose(): void;
        };
      };
      if (typeof sdk.createOpenCloudClient !== "function") {
        throw new Error("SDK does not export createOpenCloudClient");
      }
      const client = sdk.createOpenCloudClient();
      try {
        const [config, session, typesResponse] = await Promise.all([
          client.config(),
          client.session(),
          fetch(runtime.javascriptSdk.types, {
            credentials: "same-origin",
          }),
        ]);
        const visibleTextLength =
          document.body?.innerText.replace(/\s+/g, " ").trim().length ?? 0;
        const requiredContract =
          document
            .querySelector('meta[name="opencloud-ui-contract"]')
            ?.getAttribute("content") === "required";
        const candidate = (
          globalThis as typeof globalThis & {
            __opencloudVerify?: (context: {
              client: ReturnType<NonNullable<typeof sdk.createOpenCloudClient>>;
              config: typeof config;
              session: unknown;
            }) => Promise<unknown> | unknown;
          }
        ).__opencloudVerify;
        let interactionContract: BrowserEvaluation["interactionContract"] = {
          declared: false,
          required: requiredContract,
          checks: [],
          coverage: [],
        };
        if (candidate !== undefined) {
          if (typeof candidate !== "function") {
            throw new Error(
              "window.__opencloudVerify must be a function",
            );
          }
          const timeout = new Promise<never>((_, reject) => {
            globalThis.setTimeout(
              () =>
                reject(
                  new Error(
                    "App-supplied UI verification timed out after 10 seconds",
                  ),
                ),
              10_000,
            );
          });
          const rawResult = await Promise.race([
            Promise.resolve(candidate({ client, config, session })),
            timeout,
          ]);
          if (
            !rawResult ||
            typeof rawResult !== "object" ||
            (rawResult as { passed?: unknown }).passed !== true
          ) {
            throw new Error(
              "App-supplied UI verification did not return passed: true",
            );
          }
          const rawChecks = (rawResult as { checks?: unknown }).checks;
          if (
            !Array.isArray(rawChecks) ||
            rawChecks.length < 1 ||
            rawChecks.length > 20 ||
            rawChecks.some(
              (check) =>
                typeof check !== "string" ||
                check.length < 1 ||
                check.length > 160,
            )
          ) {
            throw new Error(
              "App-supplied UI verification must return 1-20 short check names",
            );
          }
          const rawCoverage = (
            rawResult as { coverage?: unknown }
          ).coverage;
          if (
            rawCoverage !== undefined &&
            (!Array.isArray(rawCoverage) ||
              rawCoverage.some(
                (item) =>
                  item !== "view-transition" &&
                  item !== "state-assertion",
              ))
          ) {
            throw new Error(
              "App-supplied UI verification coverage must contain only view-transition and state-assertion",
            );
          }
          interactionContract = {
            declared: true,
            required: requiredContract,
            checks: rawChecks as string[],
            coverage: [
              ...new Set(
                (rawCoverage ?? []) as InteractionCoverage[],
              ),
            ],
          };
        }
        return {
          title: document.title,
          visibleTextLength,
          landmarkCount: document.querySelectorAll(
            "main, [role=main], header, nav",
          ).length,
          sdk: {
            package: runtime.javascriptSdk.package,
            version: runtime.javascriptSdk.version,
            module: runtime.javascriptSdk.module,
            types: runtime.javascriptSdk.types,
            exportedVersion: sdk.OPEN_CLOUD_JS_VERSION ?? "",
            configMatched:
              config.appId === runtime.appId &&
              config.javascriptSdk.version === runtime.javascriptSdk.version,
            typesStatus: typesResponse.status,
          },
          session: session ? "established" : "none",
          interactionContract,
        };
      } finally {
        client.dispose();
      }
    });

    const finalUrl = page.url();
    const failures: string[] = [];
    if (new URL(finalUrl).origin !== appOrigin) {
      failures.push(`navigation ended at unexpected origin ${new URL(finalUrl).origin}`);
    }
    if (evaluation.visibleTextLength < 20) {
      failures.push("document rendered fewer than 20 visible text characters");
    }
    if (evaluation.sdk.package !== "@opencloud/js") {
      failures.push("runtime advertised an unexpected SDK package");
    }
    if (
      !evaluation.sdk.exportedVersion ||
      evaluation.sdk.exportedVersion !== evaluation.sdk.version
    ) {
      failures.push("SDK export and runtime versions do not match");
    }
    if (!evaluation.sdk.configMatched) {
      failures.push("SDK config did not match runtime config");
    }
    if (evaluation.sdk.typesStatus !== 200) {
      failures.push(
        `SDK declarations returned HTTP ${evaluation.sdk.typesStatus}`,
      );
    }
    if (app.visibility === "private" && evaluation.session !== "established") {
      failures.push("private app did not establish an SDK session");
    }
    const interactionRequired =
      evaluation.interactionContract.required ||
      options.requireInteraction === true;
    if (
      interactionRequired &&
      !evaluation.interactionContract.declared
    ) {
      failures.push(
        "app requires window.__opencloudVerify but did not declare it",
      );
    }
    if (interactionRequired && evaluation.interactionContract.declared) {
      for (const requiredCoverage of [
        "view-transition",
        "state-assertion",
      ] as const) {
        if (
          !evaluation.interactionContract.coverage.includes(
            requiredCoverage,
          )
        ) {
          failures.push(
            `app interaction contract did not cover ${requiredCoverage}`,
          );
        }
      }
    }
    failures.push(
      ...consoleErrors.map((message) => `console: ${message}`),
      ...pageErrors.map((message) => `page: ${message}`),
      ...failedRequests.map((message) => `request: ${message}`),
      ...serverErrors.map((message) => `response: ${message}`),
    );
    if (failures.length) {
      throw new Error(
        `OpenCloud UI verification failed: ${failures.join("; ")}`,
      );
    }

    return {
      passed: true,
      appId: app.id,
      deploymentId: app.activeDeploymentId,
      appUrl: app.appUrl,
      finalUrl,
      visibility: app.visibility,
      document: {
        title: evaluation.title,
        visibleTextLength: evaluation.visibleTextLength,
        landmarkCount: evaluation.landmarkCount,
      },
      sdk: evaluation.sdk,
      session: evaluation.session,
      interactionContract: {
        ...evaluation.interactionContract,
        required: interactionRequired,
      },
      diagnostics: {
        consoleErrors: 0,
        pageErrors: 0,
        failedSameOriginRequests: 0,
        serverErrors: 0,
      },
    };
  } finally {
    await browser.close();
  }
}
