import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Connector } from "../src/contract.ts";
import {
  ConnectorError,
  connectorPackage,
  findConnectors,
  loadConnector,
} from "../src/registry.ts";
import { tempDir } from "./helpers.ts";

const connector = (id: string): Connector => ({
  id,
  capabilities: {
    sharedContext: true,
    workflowPerIssue: false,
    squads: true,
    skills: true,
    metrics: [],
  },
  pull: () => Promise.resolve({}),
  plan: () => Promise.resolve([]),
  apply: () => Promise.resolve(),
});

const notFound = (): Error =>
  Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" });

describe("loadConnector", () => {
  it("imports @10xagents/connector-<id>, as `connector` or as the default export", async () => {
    const asked: string[] = [];
    const named = await loadConnector("acme", {
      importer: (specifier) => {
        asked.push(specifier);
        return Promise.resolve({ connector: connector("acme") });
      },
    });
    expect(named.id).toBe("acme");
    expect(asked).toEqual(["@10xagents/connector-acme"]);
    const byDefault = await loadConnector("acme", {
      importer: () => Promise.resolve({ default: connector("acme") }),
    });
    expect(byDefault.capabilities.sharedContext).toBe(true);
  });

  it("names the package to install when it's missing", async () => {
    await expect(
      loadConnector("acme", { importer: () => Promise.reject(notFound()) }),
    ).rejects.toThrow(new ConnectorError("no connector acme: install @10xagents/connector-acme"));
  });

  it("finds a missing package through the real import too", async () => {
    await expect(loadConnector("not-installed-anywhere", { cwd: tempDir() })).rejects.toThrow(
      "no connector not-installed-anywhere: install @10xagents/connector-not-installed-anywhere",
    );
  });

  it("reports a package that fails to load", async () => {
    await expect(
      loadConnector("acme", {
        importer: () => Promise.reject(new SyntaxError("Unexpected token")),
      }),
    ).rejects.toThrow("connector acme: @10xagents/connector-acme failed to load: Unexpected token");
  });

  it("refuses a module that exports no connector, or another one", async () => {
    for (const module of [{}, { connector: { id: "acme" } }, { default: 3 }, null]) {
      await expect(
        loadConnector("acme", { importer: () => Promise.resolve(module) }),
      ).rejects.toThrow(/exports no connector/);
    }
    await expect(
      loadConnector("acme", { importer: () => Promise.resolve({ connector: connector("other") }) }),
    ).rejects.toThrow("connector acme: @10xagents/connector-acme exports connector other");
  });

  it("refuses an id that isn't a plain name", async () => {
    for (const id of ["../evil", "", "Acme", "a/b"]) {
      await expect(loadConnector(id, { importer: () => Promise.resolve({}) })).rejects.toThrow(
        ConnectorError,
      );
    }
  });
});

describe("findConnectors", () => {
  it("lists the connector packages installed above the working directory", () => {
    const dir = tempDir();
    for (const name of ["connector-acme", "connector-", "other"]) {
      mkdirSync(join(dir, "node_modules", "@10xagents", name), { recursive: true });
    }
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    const ids = findConnectors(nested);
    expect(ids).toContain("acme");
    expect(ids).not.toContain("");
    expect(ids).toEqual([...new Set(ids)].toSorted());
  });

  it("names the package", () => {
    expect(connectorPackage("multica")).toBe("@10xagents/connector-multica");
  });
});
