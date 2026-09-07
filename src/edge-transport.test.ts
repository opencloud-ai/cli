import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer, globalAgent } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { requestApp, smokeApp } from "./app-edge.js";
import { EdgeTransport } from "./edge-transport.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function adapter(
  handler: Parameters<typeof createServer>[0],
): Promise<{ url: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}` };
}

function appRecord(
  values: Partial<{
    visibility: "public" | "private";
    state: string;
    activeDeploymentId: string | null;
    appUrl: string;
    authUrl: string;
  }> = {},
): Record<string, unknown> {
  return {
    id: "aeea1c71-72a3-4b1d-a32e-213900735091",
    visibility: "public",
    state: "active",
    activeDeploymentId: "99aaf4a9-6730-40df-b982-3b7c0eda4523",
    appUrl: "https://demo.opcl.test",
    authUrl: "https://auth.opcl.test",
    ...values,
  };
}

describe("edge transport", () => {
  it("routes the connection while enforcing the canonical TLS identity and Host", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencloud-edge-tls-"));
    const originalCa = globalAgent.options.ca;
    try {
      const keyPath = path.join(directory, "test-key.pem");
      const certPath = path.join(directory, "test-cert.pem");
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=app.bridge.test", "-addext", "subjectAltName=DNS:app.bridge.test",
        "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
      const cert = await readFile(certPath);
      let receivedHost = "";
      let receivedServername = "";
      const edge = createHttpsServer({ key: await readFile(keyPath), cert }, (request, response) => {
        receivedHost = request.headers.host ?? "";
        receivedServername = (request.socket as import("node:tls").TLSSocket).servername ?? "";
        response.writeHead(302, { location: "https://auth.bridge.test/login" });
        response.end();
      });
      servers.push(edge);
      await new Promise<void>(resolve => edge.listen(0, "127.0.0.1", resolve));
      const port = (edge.address() as AddressInfo).port;
      const app = appRecord({ appUrl: `https://app.bridge.test:${port}`, visibility: "private" });
      await expect(requestApp(app, "/", { method: "HEAD", publicEdgeHost: "127.0.0.1" })).rejects.toThrow(/self-signed|certificate/i);
      globalAgent.options.ca = cert;
      const result = await requestApp(app, "/", { method: "HEAD", publicEdgeHost: "127.0.0.1" });
      expect(result).toMatchObject({ status: 302, method: "HEAD", bodyBytes: 0, url: `https://app.bridge.test:${port}/` });
      expect(receivedHost).toBe(`app.bridge.test:${port}`);
      expect(receivedServername).toBe("app.bridge.test");
      await expect(requestApp(appRecord({ appUrl: `https://other.bridge.test:${port}` }), "/", {
        publicEdgeHost: "127.0.0.1",
      })).rejects.toThrow(/Hostname\/IP does not match|certificate.*altnames/i);
      expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    } finally {
      globalAgent.options.ca = originalCa;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous or non-hostname connection overrides", () => {
    expect(() => new EdgeTransport("http://adapter.test", "bridge.test")).toThrow(/hostname/);
    for (const host of ["https://bridge.test", "bridge.test:443", "bridge.test/path", "user@bridge.test"]) {
      expect(() => new EdgeTransport(undefined, host)).toThrow(/hostname/);
    }
  });

  it("uses the adapter while preserving the canonical Host header", async () => {
    let receivedHost = "";
    let receivedPath = "";
    const edge = await adapter((request, response) => {
      receivedHost = request.headers.host ?? "";
      receivedPath = request.url ?? "";
      response.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": "oc_session=must-not-be-printed",
      });
      response.end("sensitive response body");
    });

    const summary = await requestApp(appRecord(), "/health?full=true", {
      edgeUrl: edge.url,
    });

    expect(receivedHost).toBe("demo.opcl.test");
    expect(receivedPath).toBe("/health?full=true");
    expect(summary).toMatchObject({
      url: "https://demo.opcl.test/health?full=true",
      status: 200,
      ok: true,
      bodyBytes: 23,
    });
    const printed = JSON.stringify(summary);
    expect(printed).not.toContain("sensitive response body");
    expect(printed).not.toContain("must-not-be-printed");
    expect(printed).not.toContain("127.0.0.1");
  });

  it("rejects request paths that replace the canonical origin", async () => {
    const transport = new EdgeTransport();
    expect(() =>
      transport.request("https://demo.opcl.test", "//other.example/path"),
    ).toThrow("must stay within the public origin");
  });

  it("smokes public roots and private auth redirects without leaking locations", async () => {
    const publicEdge = await adapter((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<p>ready</p>");
    });
    const publicResult = await smokeApp(appRecord(), {
      edgeUrl: publicEdge.url,
    });
    expect(publicResult.passed).toBe(true);

    const privateEdge = await adapter((_request, response) => {
      response.writeHead(302, {
        location: "https://auth.opcl.test/login?code=private-value",
      });
      response.end("private redirect body");
    });
    const privateResult = await smokeApp(
      appRecord({ visibility: "private" }),
      { edgeUrl: privateEdge.url },
    );
    expect(privateResult.passed).toBe(true);
    const printed = JSON.stringify(privateResult);
    expect(printed).not.toContain("private-value");
    expect(printed).not.toContain("private redirect body");
    expect(printed).not.toContain("127.0.0.1");
  });
});
