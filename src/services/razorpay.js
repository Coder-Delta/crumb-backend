import crypto from "node:crypto";

function credentials() {
  const { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: keySecret } =
    process.env;
  if (!keyId || !keySecret)
    throw Object.assign(
      new Error(
        "Online payments are not configured. Add Razorpay test keys to backend/.env.",
      ),
      { status: 503 },
    );
  return { keyId, keySecret };
}

async function request(path, body) {
  const { keyId, keySecret } = credentials();
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(12000),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(result.error?.description || "Razorpay request failed."),
      { status: 502 },
    );
  return result;
}

function safeHexEqual(actual, expected) {
  if (!/^[a-f\d]{64}$/i.test(actual) || !/^[a-f\d]{64}$/i.test(expected))
    return false;
  return crypto.timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
}

export const createRazorpayOrder = (body) => request("/orders", body);
export const fetchRazorpayPayment = (paymentId) =>
  request(`/payments/${encodeURIComponent(paymentId)}`);
export function verifyCheckoutSignature(orderId, paymentId, signature) {
  const { keySecret } = credentials();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return safeHexEqual(signature, expected);
}
export function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret)
    throw Object.assign(new Error("Payment webhook is not configured."), {
      status: 503,
    });
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return safeHexEqual(signature, expected);
}
