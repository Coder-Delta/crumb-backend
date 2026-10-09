import express from "express";
import { asyncRoute } from "../middleware.js";
import { verifyWebhookSignature } from "../services/razorpay.js";
import { normalizeRazorpayEvent } from "../services/paymentEvents.js";
import { publishRazorpayWebhookEvent } from "../services/rabbitmq.js";
const router = express.Router();

router.post(
  "/payments/razorpay/webhook",
  asyncRoute(async (req, res) => {
    const signature = req.get("x-razorpay-signature") || "";
    if (!verifyWebhookSignature(req.body, signature)) {
      return res.status(400).json({ message: "Invalid webhook signature." });
    }

    let providerEvent;
    try {
      providerEvent = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res
        .status(400)
        .json({ message: "Webhook body is not valid JSON." });
    }

    const paymentEvent = normalizeRazorpayEvent(providerEvent, req.body);
    await publishRazorpayWebhookEvent(paymentEvent);
    res.status(202).json({
      received: true,
      queued: true,
      eventId: paymentEvent.eventId,
    });
  }),
);

export default router;
