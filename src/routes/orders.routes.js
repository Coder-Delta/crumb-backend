import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Restaurant, Food, Order } from "../models.js";
import { auth, asyncRoute } from "../middleware.js";
import {
  createRazorpayOrder,
  fetchRazorpayPayment,
  verifyCheckoutSignature,
} from "../services/razorpay.js";
import { applyCapturedPayment } from "../services/paymentEvents.js";
import {
  notifyOrderCancelledByBuyer,
  notifyOrderPlaced,
} from "../services/notifications.js";
const router = express.Router();

router.post(
  "/orders",
  auth,
  asyncRoute(async (req, res) => {
    const data = z
      .object({
        restaurantId: z.string().regex(/^[0-9a-f]{24}$/i),
        items: z
          .array(
            z.object({
              foodId: z.string().regex(/^[0-9a-f]{24}$/i),
              quantity: z.number().int().min(1).max(50),
            }),
          )
          .min(1)
          .max(60),
        address: z.string().trim().min(8).max(300),
        deliveryLocation: z
          .object({
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
          })
          .optional(),
        paymentMethod: z.enum(["razorpay", "cash"]).default("razorpay"),
      })
      .parse(req.body);
    const restaurant = await Restaurant.findById(data.restaurantId);
    if (!restaurant || !restaurant.isOpen)
      return res
        .status(400)
        .json({ message: "This restaurant is currently unavailable." });
    const ids = data.items.map((item) => item.foodId);
    const foods = await Food.find({
      _id: { $in: ids },
      restaurant: restaurant._id,
      available: true,
    });
    if (foods.length !== new Set(ids).size)
      return res.status(400).json({
        message: "One or more items are unavailable. Please refresh your cart.",
      });
    const byId = new Map(foods.map((food) => [String(food._id), food]));
    const items = data.items.map((item) => {
      const food = byId.get(item.foodId);
      if (!food)
        throw Object.assign(
          new Error(
            "One or more items are unavailable. Please refresh your cart.",
          ),
          { status: 400 },
        );
      return {
        food: food._id,
        name: food.name,
        image: food.image,
        price: food.price,
        quantity: item.quantity,
      };
    });
    const subtotal = items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    const deliveryFee = subtotal >= 499 ? 0 : restaurant.deliveryFee;
    const tax = Math.round(subtotal * 0.05);
    const total = subtotal + deliveryFee + tax;
    const orderId = new mongoose.Types.ObjectId();
    let razorpayOrder;
    if (data.paymentMethod === "razorpay") {
      razorpayOrder = await createRazorpayOrder({
        amount: Math.round(total * 100),
        currency: "INR",
        receipt: orderId.toString(),
        notes: {
          crumbOrderId: orderId.toString(),
          restaurantId: restaurant._id.toString(),
        },
      });
    }
    const order = await Order.create({
      _id: orderId,
      user: req.user._id,
      restaurant: restaurant._id,
      items,
      subtotal,
      deliveryFee,
      tax,
      total,
      address: data.address,
      deliveryLocation: data.deliveryLocation,
      paymentMethod: data.paymentMethod,
      paymentStatus: data.paymentMethod === "cash" ? "cod" : "pending",
      status: data.paymentMethod === "cash" ? "placed" : "payment_pending",
      razorpayOrderId: razorpayOrder?.id,
      eta: new Date(Date.now() + 35 * 60 * 1000),
    });
    if (data.paymentMethod === "cash") await notifyOrderPlaced(order._id);
    res.status(201).json({
      order: await order.populate("restaurant", "name image"),
      payment: razorpayOrder
        ? {
            keyId: process.env.RAZORPAY_KEY_ID,
            orderId: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
          }
        : null,
    });
  }),
);
router.post(
  "/orders/:id/payment/verify",
  auth,
  asyncRoute(async (req, res) => {
    const data = z
      .object({
        razorpay_order_id: z.string().min(1),
        razorpay_payment_id: z.string().min(1),
        razorpay_signature: z.string().regex(/^[a-f\d]{64}$/i),
      })
      .strict()
      .parse(req.body);
    const order = await Order.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (order.paymentStatus === "paid")
      return res.json({
        order: await order.populate("restaurant", "name image"),
      });
    if (
      !order.razorpayOrderId ||
      order.razorpayOrderId !== data.razorpay_order_id
    )
      return res
        .status(400)
        .json({ message: "Payment does not match this order." });
    if (
      !verifyCheckoutSignature(
        order.razorpayOrderId,
        data.razorpay_payment_id,
        data.razorpay_signature,
      )
    )
      return res
        .status(400)
        .json({ message: "Payment signature could not be verified." });
    const payment = await fetchRazorpayPayment(data.razorpay_payment_id);
    if (
      payment.order_id !== order.razorpayOrderId ||
      payment.status !== "captured" ||
      payment.amount !== Math.round(order.total * 100) ||
      payment.currency !== "INR"
    ) {
      return res.status(409).json({
        message:
          "Payment is not captured yet. Do not retry the payment; refresh in a moment or contact support.",
      });
    }
    await applyCapturedPayment({
      schemaVersion: 1,
      eventId: `checkout:${payment.id}`,
      eventType: "payment.captured",
      razorpayOrderId: payment.order_id,
      razorpayPaymentId: payment.id,
      paymentStatus: payment.status,
      amount: payment.amount,
      currency: payment.currency,
    });
    const verifiedOrder = await Order.findById(order._id).populate(
      "restaurant",
      "name image",
    );
    res.json({ order: verifiedOrder });
  }),
);
router.get(
  "/orders/:id/payment/retry",
  auth,
  asyncRoute(async (req, res) => {
    const order = await Order.findOne({
      _id: req.params.id,
      user: req.user._id,
      status: "payment_pending",
      paymentStatus: "pending",
    }).populate("restaurant", "name image");
    if (!order?.razorpayOrderId)
      return res
        .status(404)
        .json({ message: "No pending online payment was found." });
    res.json({
      order,
      payment: {
        keyId: process.env.RAZORPAY_KEY_ID,
        orderId: order.razorpayOrderId,
        amount: Math.round(order.total * 100),
        currency: "INR",
      },
    });
  }),
);
router.get(
  "/orders",
  auth,
  asyncRoute(async (req, res) => {
    const orders = await Order.find({
      user: req.user._id,
      status: { $ne: "payment_pending" },
    })
      .populate("restaurant", "name image")
      .sort({ createdAt: -1 });
    res.json({ orders });
  }),
);
router.get(
  "/orders/:id",
  auth,
  asyncRoute(async (req, res) => {
    const filter = { _id: req.params.id };
    if (!["admin", "restaurant_owner"].includes(req.user.role))
      filter.user = req.user._id;
    const order = await Order.findOne(filter)
      .populate("restaurant", "name image")
      .populate("user", "name email");
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (
      req.user.role === "restaurant_owner" &&
      !(await Restaurant.exists({
        _id: order.restaurant?._id || order.restaurant,
        owner: req.user._id,
      }))
    )
      return res.status(404).json({ message: "Order not found." });
    res.json({ order });
  }),
);
router.patch(
  "/orders/:id/cancel",
  auth,
  asyncRoute(async (req, res) => {
    const order = await Order.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (!["placed", "confirmed"].includes(order.status))
      return res
        .status(400)
        .json({ message: "This order can no longer be cancelled." });
    order.status = "cancelled";
    await order.save();
    await notifyOrderCancelledByBuyer(order._id);
    res.json({ order });
  }),
);

export default router;
