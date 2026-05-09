import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'veridian-fabric',
    version: 'v0',
    timestamp: new Date().toISOString(),
    contracts: {
      ingest: {
        method: 'POST',
        path: '/api/n8n/ingest',
        auth: 'header X-Fabric-Token',
        body: {
          workspace_slug: 'string',
          kind: 'hipotese | metric | journal',
          data: 'object (depende de kind)',
        },
      },
    },
  });
}
