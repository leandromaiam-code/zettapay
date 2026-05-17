// Tiny Supabase REST helper for Fabric control plane.
// Mirrors the `sb(method, path, body)` convention used in /opt/fabric-api/server.js
// so wire-up is a drop-in.

'use strict';

function makeSb({ url, serviceRoleKey, fetchImpl = globalThis.fetch }) {
  if (!url) throw new Error('makeSb: url required');
  if (!serviceRoleKey) throw new Error('makeSb: serviceRoleKey required');
  if (typeof fetchImpl !== 'function') throw new Error('makeSb: fetch unavailable');

  return async function sb(method, path, body) {
    const res = await fetchImpl(url + path, {
      method,
      headers: {
        apikey: serviceRoleKey,
        authorization: 'Bearer ' + serviceRoleKey,
        'content-type': 'application/json',
        prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('sb ' + method + ' ' + path + ' -> ' + res.status + ': ' + text.slice(0, 400));
    }
    if (res.status === 204) return null;
    const txt = await res.text();
    if (!txt) return null;
    try {
      return JSON.parse(txt);
    } catch {
      return txt;
    }
  };
}

module.exports = { makeSb };
