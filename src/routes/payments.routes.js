import express from "express";
import { Order } from "../models.js";
import { asyncRoute } from "../middleware.js";
import { verifyWebhookSignature } from "../services/razorpay.js";
const router = express.Router();

router.post(
  "/payments/razorpay/webhook",
  asyncRoute(async (req, res) => {
    if (
      !verifyWebhookSignature(req.body, req.get("x-razorpay-signature") || "")
    )
      return res.status(400).json({ message: "Invalid webhook signature." });
    const event = JSON.parse(req.body.toString("utf8"));
    if (event.event === "payment.captured" || event.event === "order.paid") {
      const payment = event.payload?.payment?.entity;
      const paidOrder = event.payload?.order?.entity;
      const razorpayOrderId = payment?.order_id || paidOrder?.id;
      if (razorpayOrderId) {
        const order = await Order.findOne({ razorpayOrderId });
        const paidAmount = payment?.amount ?? paidOrder?.amount_paid;
        const currency = payment?.currency ?? paidOrder?.currency;
        const captured =
          event.event === "order.paid" || payment?.status === "captured";
        if (
          order &&
          captured &&
          currency === "INR" &&
          Number(paidAmount) === Math.round(order.total * 100)
        ) {
          order.paymentStatus = "paid";
          order.razorpayPaymentId = payment?.id || order.razorpayPaymentId;
          if (order.status === "payment_pending") order.status = "placed";
          await order.save();
        }
      }
    }
    res.json({ received: true });
  }),
);

export default router;
