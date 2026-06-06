/**
 * ──────────────────────────────────────────────────────────────
 *  KoboToolbox CORS Proxy — Cloudflare Worker  (v4)
 *
 *  New in v4:
 *  - POST to /submit/ handled server-side by the Worker itself
 *    using the KoboToolbox Enketo submission endpoint, bypassing
 *    browser permission restrictions entirely.
 *
 *  HOW IT WORKS:
 *    Browser  → POST https://your-proxy.workers.dev/submit/
 *    Worker   → builds OpenRosa XML and POSTs to Kobo directly
 *    Response → success/fail JSON back to browser
 *
 *  DEPLOY:
 *    1. Go to https://workers.cloudflare.com — sign up free
 *    2. Create Worker → delete default code → paste this file
 *    3. Click Save & Deploy → copy the .workers.dev URL
 *    4. In the tool: Server → Custom URL → paste your Worker URL
 * ──────────────────────────────────────────────────────────────
 */

const KOBO_TARGET    = "https://eu.kobotoolbox.org";
const ALLOWED_ORIGIN = "*";

export default {
  async fetch(request, env, ctx) {

    if (request.method === "OPTIONS") return preflightResponse();

    const url = new URL(request.url);

    // ── Status page ──────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "") {
      return jsonResponse(200, {
        status: "KoboToolbox CORS Proxy v4 ✓",
        target: KOBO_TARGET,
        endpoints: {
          proxy:  "Any /api/* path is forwarded to Kobo",
          submit: "POST /submit/ — server-side submission creation",
          debug:  "GET /debug/ — echo request headers",
        }
      });
    }

    // ── Debug: echo headers ──────────────────────────────────
    if (url.pathname.startsWith("/debug/")) {
      const hdrs = {};
      for (const [k, v] of request.headers.entries()) hdrs[k] = v;
      return jsonResponse(200, { method: request.method, headers: hdrs });
    }

    // ── Server-side submission creation ──────────────────────
    // Browser POSTs JSON: { token, formUid, idString, version, data: {...} }
    // Worker builds XML and submits to Kobo server-to-server
    if (url.pathname === "/submit/" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch(e) { return jsonResponse(400, { error: "Invalid JSON body" }); }

      const { token, formUid, idString, version, data, formUuid } = body;
      if (!token || !formUid || !data) {
        return jsonResponse(400, { error: "Missing required fields: token, formUid, data" });
      }

      // Generate a UUID for this submission instance
      function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      }

      // Build payload in the exact shape kc-eu.kobotoolbox.org/api/v1/submissions expects:
      // { id, submission: { formhub: { uuid }, meta: { instanceID }, ...fields } }
      const instanceUUID = generateUUID();
      const submissionPayload = {
        id: idString || formUid,
        submission: {
          formhub: { uuid: formUuid || '' },
          meta:    { instanceID: `uuid:${instanceUUID}` },
          ...data
        }
      };

      // The correct EU submission endpoint (kc-eu, not kf-eu or eu)
      const endpoint = 'https://kc-eu.kobotoolbox.org/api/v1/submissions';

      let koboResp, respBody = '';
      try {
        koboResp = await fetch(endpoint, {
          method:  'POST',
          headers: {
            'Authorization': `Token ${token}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify(submissionPayload),
        });
        try { respBody = await koboResp.text(); } catch(e) {}
      } catch(e) {
        return jsonResponse(502, { error: 'Fetch to kc-eu failed', detail: e.message });
      }

      if ([200, 201, 202, 204].includes(koboResp.status)) {
        return jsonResponse(201, { success: true, status: koboResp.status, endpoint, instanceID: `uuid:${instanceUUID}` });
      }
      return jsonResponse(koboResp.status, {
        error:    'Submission failed',
        status:   koboResp.status,
        endpoint,
        response: respBody.slice(0, 500),
        payload:  submissionPayload
      });
    }

    // ── Forward all other /api/* requests to Kobo ────────────
    if (!url.pathname.startsWith("/api/")) {
      return jsonResponse(403, { error: "Only /api/ paths are proxied.", received: url.pathname });
    }

    const targetUrl = KOBO_TARGET + url.pathname + url.search;
    let bodyBuffer = null;
    if (!["GET", "HEAD"].includes(request.method)) {
      try { bodyBuffer = await request.arrayBuffer(); } catch(e) {}
    }

    const forwardHeaders = new Headers();
    for (const [k, v] of request.headers.entries()) {
      if (!HOP_BY_HOP.includes(k.toLowerCase())) forwardHeaders.set(k, v);
    }

    let koboResponse;
    try {
      koboResponse = await fetch(targetUrl, {
        method: request.method, headers: forwardHeaders, body: bodyBuffer
      });
    } catch(e) {
      return jsonResponse(502, { error: "Proxy could not reach Kobo.", detail: e.message });
    }

    const respHeaders = new Headers(koboResponse.headers);
    respHeaders.set("Access-Control-Allow-Origin",  ALLOWED_ORIGIN);
    respHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    respHeaders.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-CSRFToken");

    return new Response(koboResponse.body, {
      status: koboResponse.status,
      statusText: koboResponse.statusText,
      headers: respHeaders,
    });
  }
};

// ── Helpers ───────────────────────────────────────────────────

const HOP_BY_HOP = [
  "connection","keep-alive","proxy-authenticate","proxy-authorization",
  "te","trailers","transfer-encoding","upgrade"
];

function objToXml(obj) {
  return Object.entries(obj).map(([k, v]) => {
    if (Array.isArray(v)) return v.map(item => `<${k}>${objToXml(item)}</${k}>`).join('');
    if (v !== null && typeof v === 'object') return `<${k}>${objToXml(v)}</${k}>`;
    return `<${k}>${escXml(String(v ?? ''))}</${k}>`;
  }).join('');
}

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type":                 "application/json",
      "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-CSRFToken",
    }
  });
}

function preflightResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-CSRFToken",
      "Access-Control-Max-Age":       "86400",
    }
  });
}
