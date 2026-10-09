import crypto from "node:crypto";
import { Order } from "../models.js";
import { notifyOrderPlaced } from "./notifications.js";

export class PaymentEventError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "PaymentEventError";
    this.retryable = retryable;
  }
}

export function normalizeRazorpayEvent(providerEvent, rawBody) {
  const payment = providerEvent.payload?.payment?.entity;
  const order = providerEvent.payload?.order?.entity;
  const eventType = providerEvent.event;
  const orderId = payment?.order_id || order?.id;

  if (!eventType || typeof eventType !== "string") {
    throw new PaymentEventError("Webhook event type is missing.");
  }

  const eventId =
    typeof providerEvent.id === "string" && providerEvent.id.length > 0
      ? providerEvent.id
      : crypto.createHash("sha256").update(rawBody).digest("hex");

  return {
    schemaVersion: 1,
    eventId,
    eventType,
    razorpayOrderId: orderId,
    razorpayPaymentId: payment?.id,
    paymentStatus: payment?.status,
    amount: payment?.amount ?? order?.amount_paid,
    currency: payment?.currency ?? order?.currency,
    receivedAt: new Date().toISOString(),
  };
}

export async function applyCapturedPayment(event) {
  if (!["payment.captured", "order.paid"].includes(event.eventType)) {
    return { ignored: true };
  }
  if (!event.razorpayOrderId || !event.eventId) {
    throw new PaymentEventError("Payment event is missing its identifiers.");
  }
  if (
    event.eventType === "payment.captured" &&
    event.paymentStatus !== "captured"
  ) {
    throw new PaymentEventError(
      "Captured payment event has an invalid status.",
    );
  }
  if (event.currency !== "INR" || !Number.isSafeInteger(Number(event.amount))) {
    throw new PaymentEventError("Payment amount or currency is invalid.");
  }

  const order = await Order.findOne({
    razorpayOrderId: event.razorpayOrderId,
  }).select("+razorpayEventIds");
  if (!order) {
    throw new PaymentEventError("Local order has not arrived yet.", {
      retryable: true,
    });
  }
  if (order.paymentMethod !== "razorpay") {
    throw new PaymentEventError(
      "Payment event does not belong to an online order.",
    );
  }
  if (Number(event.amount) !== Math.round(order.total * 100)) {
    throw new PaymentEventError(
      "Captured amount does not match the local order.",
    );
  }
  if (order.razorpayEventIds.includes(event.eventId)) {
    return { duplicate: true, orderId: String(order._id) };
  }

  // One atomic document update makes repeated deliveries safe and keeps the order
  // state intact if another allowed transition occurred while the event was queued.
  const result = await Order.collection.updateOne(
    { _id: order._id, razorpayOrderId: event.razorpayOrderId },
    [
      {
        $set: {
          paymentStatus: "paid",
          razorpayPaymentId: {
            $ifNull: ["$razorpayPaymentId", event.razorpayPaymentId || null],
          },
          status: {
            $cond: [
              { $eq: ["$status", "payment_pending"] },
              "placed",
              "$status",
            ],
          },
          razorpayEventIds: {
            $setUnion: [
              { $ifNull: ["$razorpayEventIds", []] },
              [event.eventId],
            ],
          },
        },
      },
    ],
  );

  if (!result.matchedCount) {
    throw new PaymentEventError("Order changed while payment was processed.", {
      retryable: true,
    });
  }
  await notifyOrderPlaced(order._id);
  return { processed: true, orderId: String(order._id) };
}
