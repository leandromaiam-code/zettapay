import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import express from "express";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { listAuditEntries } from "../src/db/audit_journal.js";
import { IncidentService } from "../src/services/incident.js";
import type { SolanaService } from "../src/services/solana.js";
import { registerMerchant } from "../src/services/merchants.js";

const ADMIN_KEY = "incident-admin-key-z22-4-min-len-ok";

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

function startApp(app: express.Express): Promise<RunningServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function fakeSolana(): SolanaService {
  const payerKp = Keypair.generate();
  return {
    getPayerPublicKey: () => payerKp.publicKey,
    getCluster: () => "devnet" as const,
    getMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferToken: vi.fn(async (params: { recipientOwner: PublicKey; amount: number }) => ({
      signature: `sig_${Math.random().toString(36).slice(2, 10)}`,
      payerWallet: payerKp.publicKey.toBase58(),
      recipientWallet: params.recipientOwner.toBase58(),
      amountAtomic: BigInt(Math.round(params.amount * 1_000_000)),
      decimals: 6,
      currency: "USDC",
      mintAddress: "mint_USDC",
    })),
  } as unknown as SolanaService;
}

function authHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "content-type": "application/json",
    "x-api-key": ADMIN_KEY,
    "x-treasury-actor": "oncall-eng",
    ...extra,
  };
}

describe("IncidentService", () => {
  beforeEach(() => {
    closeDatabase();
  });
  afterEach(() => {
    closeDatabase();
  });

  it("starts with kill switch disengaged and operational status", () => {
    const db = openDatabase(":memory:");
    const incidents = new IncidentService(db);
    expect(incidents.isKillSwitchEngaged()).toBe(false);
    expect(incidents.publicStatus().status).toBe("operational");
    expect(incidents.listOpen()).toEqual([]);
  });

  it("rejects engaging kill switch on non-sev1 incidents", () => {
    const db = openDatabase(":memory:");
    const incidents = new IncidentService(db);
    expect(() =>
      incidents.open({
        title: "minor blip",
        severity: "sev2",
        killSwitch: true,
        actor: "oncall",
      }),
    ).toThrow(/sev1/);
  });

  it("opens sev1 with kill switch and reports major_outage", () => {
    const db = openDatabase(":memory:");
    const incidents = new IncidentService(db);
    const inc = incidents.open({
      title: "RPC outage",
      severity: "sev1",
      killSwitch: true,
      affectedComponents: ["pay"],
      initialMessage: "RPC 5xx",
      actor: "oncall",
    });
    expect(inc.killSwitch).toBe(true);
    expect(inc.status).toBe("investigating");
    expect(incidents.isKillSwitchEngaged()).toBe(true);
    const pub = incidents.publicStatus();
    expect(pub.status).toBe("major_outage");
    expect(pub.killSwitch).toBe(true);
    expect(pub.incidents.length).toBe(1);
    expect(pub.incidents[0]?.latestUpdate?.message).toBe("RPC 5xx");
  });

  it("posts updates without changing kill-switch unless requested", () => {
    const db = openDatabase(":memory:");
    const incidents = new IncidentService(db);
    const inc = incidents.open({
      title: "x",
      severity: "sev1",
      killSwitch: true,
      actor: "a",
    });
    incidents.postUpdate(inc.id, {
      status: "identified",
      message: "found root cause",
      actor: "b",
    });
    expect(incidents.isKillSwitchEngaged()).toBe(true);
    incidents.postUpdate(
      inc.id,
      { status: "monitoring", message: "RPC restored", actor: "b" },
      false,
    );
    expect(incidents.isKillSwitchEngaged()).toBe(false);
  });

  it("rejects 'resolved' via /updates and only allows it via resolve()", () => {
    const db = openDatabase(":memory:");
    const incidents = new IncidentService(db);
    const inc = incidents.open({ title: "x", severity: "sev2", actor: "a" });
    expect(() =>
      incidents.postUpdate(inc.id, {
        status: "resolved" as never,
        message: "done",
        actor: "a",
      }),
    ).toThrow(/resolve/);
  });

  it("resolve() clears kill switch and updates status page", () => {
    const db = openDatabase(":memory:");
    const incidents = new IncidentService(db);
    const inc = incidents.open({
      title: "x",
      severity: "sev1",
      killSwitch: true,
      actor: "a",
    });
    incidents.resolve(inc.id, "all clear", "a");
    expect(incidents.isKillSwitchEngaged()).toBe(false);
    expect(incidents.publicStatus().status).toBe("operational");
    expect(incidents.get(inc.id)?.status).toBe("resolved");
    expect(incidents.get(inc.id)?.resolvedAt).not.toBeNull();
  });

  it("rebuilds state from audit_journal so kill switch survives restarts", () => {
    const db = openDatabase(":memory:");
    const original = new IncidentService(db);
    const opened = original.open({
      title: "outage",
      severity: "sev1",
      killSwitch: true,
      actor: "a",
    });
    original.postUpdate(opened.id, {
      status: "identified",
      message: "RPC slot lag",
      actor: "a",
    });

    // Simulating a restart — fresh service, same DB.
    const replayed = new IncidentService(db);
    expect(replayed.isKillSwitchEngaged()).toBe(true);
    const got = replayed.get(opened.id);
    expect(got?.status).toBe("identified");
    expect(got?.killSwitch).toBe(true);
    expect(got?.updates.length).toBe(1);
    expect(got?.updates[0]?.message).toBe("RPC slot lag");
  });

  it("audit_journal records open/update/resolve events for forensics", () => {
    const db = openDatabase(":memory:");
    const incidents = new IncidentService(db);
    const inc = incidents.open({
      title: "outage",
      severity: "sev1",
      killSwitch: true,
      actor: "a",
    });
    incidents.postUpdate(inc.id, {
      status: "monitoring",
      message: "stable",
      actor: "b",
    });
    incidents.resolve(inc.id, "closed", "b");

    const entries = listAuditEntries(db, {
      entityType: "incident",
      entityId: inc.id,
    });
    const events = entries.map((e) => e.event).sort();
    expect(events).toEqual([
      "incident.opened",
      "incident.resolved",
      "incident.updated",
    ]);
  });
});

describe("incident router + kill-switch guard", () => {
  let server: RunningServer;

  beforeEach(async () => {
    closeDatabase();
    const db = openDatabase(":memory:");
    const app = createApp({
      db,
      solana: fakeSolana(),
      incidents: { adminKey: ADMIN_KEY },
    });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("GET /status is public and returns operational by default", async () => {
    const res = await fetch(`${server.url}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      killSwitch: boolean;
      incidents: unknown[];
    };
    expect(body.status).toBe("operational");
    expect(body.killSwitch).toBe(false);
    expect(body.incidents).toEqual([]);
  });

  it("rejects unauthenticated POST /admin/incidents with 401", async () => {
    const res = await fetch(`${server.url}/admin/incidents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x", severity: "sev1" }),
    });
    expect(res.status).toBe(401);
  });

  it("opens sev1 + killSwitch, blocks /pay with 503, then resolves to unblock", async () => {
    const db = openDatabase(":memory:");
    // Need a merchant so /pay reaches the guard before validation 404s.
    registerMerchant(db, {
      name: "t",
      email: "t@t.io",
      walletAddress: "11111111111111111111111111111111",
    });

    const open = await fetch(`${server.url}/admin/incidents`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        title: "RPC outage",
        severity: "sev1",
        killSwitch: true,
        affectedComponents: ["pay", "settlement"],
        initialMessage: "Helius 5xx",
      }),
    });
    expect(open.status).toBe(201);
    const openBody = (await open.json()) as { incident: { id: string; killSwitch: boolean } };
    expect(openBody.incident.killSwitch).toBe(true);
    const incidentId = openBody.incident.id;

    const status = await fetch(`${server.url}/status`);
    const statusBody = (await status.json()) as { status: string; killSwitch: boolean };
    expect(statusBody.status).toBe("major_outage");
    expect(statusBody.killSwitch).toBe(true);

    const blocked = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId: "any",
        amount: 1,
        payerWallet: "11111111111111111111111111111111",
      }),
    });
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("60");
    const blockedBody = (await blocked.json()) as { error: { code: string } };
    expect(blockedBody.error.code).toBe("service_paused");

    const resolved = await fetch(
      `${server.url}/admin/incidents/${incidentId}/resolve`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message: "RPC restored" }),
      },
    );
    expect(resolved.status).toBe(200);

    const statusAfter = await fetch(`${server.url}/status`);
    const statusAfterBody = (await statusAfter.json()) as { status: string };
    expect(statusAfterBody.status).toBe("operational");
  });

  it("rejects engaging killSwitch on sev2", async () => {
    const res = await fetch(`${server.url}/admin/incidents`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        title: "minor",
        severity: "sev2",
        killSwitch: true,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("posts an update visible on the public status page", async () => {
    const open = await fetch(`${server.url}/admin/incidents`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ title: "outage", severity: "sev1" }),
    });
    const id = ((await open.json()) as { incident: { id: string } }).incident.id;

    const update = await fetch(`${server.url}/admin/incidents/${id}/updates`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        status: "identified",
        message: "validator slot lag",
      }),
    });
    expect(update.status).toBe(201);

    const status = (await (await fetch(`${server.url}/status`)).json()) as {
      incidents: Array<{ status: string; latestUpdate: { message: string } | null }>;
    };
    expect(status.incidents[0]?.status).toBe("identified");
    expect(status.incidents[0]?.latestUpdate?.message).toBe(
      "validator slot lag",
    );
  });
});
