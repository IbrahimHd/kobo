export default {
  async fetch(request) {

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method !== "POST") {
      return new Response("POST only", { status: 405, headers: cors });
    }

    try {
      const body = await request.json();

      const { server, token, assetUid, assignments } = body;

      const url = `${server}/api/v2/assets/${assetUid}/permission-assignments/bulk/`;

      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Token ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(assignments)
      });

      const text = await r.text();

      return new Response(JSON.stringify({
        ok: r.ok,
        status: r.status,
        response: text
      }), {
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });

    } catch (e) {
      return new Response(JSON.stringify({
        ok: false,
        error: e.message
      }), {
        status: 500,
        headers: cors
      });
    }
  }
};
