const { AccessToken } = require("livekit-server-sdk");

exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const room = String(body.room || "").trim();
    const identity = String(body.identity || "").trim();
    const role = String(body.role || "viewer").trim();

    if (!room) return { statusCode: 400, body: JSON.stringify({ error: "Missing room" }) };
    if (!identity) return { statusCode: 400, body: JSON.stringify({ error: "Missing identity" }) };

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      return { statusCode: 500, body: JSON.stringify({ error: "LiveKit env vars not set" }) };
    }

    const at = new AccessToken(apiKey, apiSecret, { identity });

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: role === "publisher",
      canSubscribe: true,
    });

    const token = await at.toJwt();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err?.message || String(err) }),
    };
  }
};
