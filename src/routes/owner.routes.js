import express from "express";
import { z } from "zod";
import { Restaurant, Food, Order } from "../models.js";
import { auth, restaurantOwner, asyncRoute } from "../middleware.js";
import { notifyOrderStatusChanged } from "../services/notifications.js";
const router = express.Router();
const owner = restaurantOwner;
const imageSchema = z.union([
  z.string().url(),
  z.string().regex(/^\/images\/[a-zA-Z0-9/_-]+\.(?:avif|gif|jpe?g|png|webp)$/i),
]);
const ownerFoodInput = z.object({
  restaurantId: z.string().regex(/^[0-9a-f]{24}$/i),
  name: z.string().trim().min(2).max(120),
  description: z.string().max(500).optional(),
  category: z.string().trim().min(2).max(50),
  image: imageSchema.optional(),
  price: z.number().min(1).max(100000),
  veg: z.boolean().default(false),
  bestseller: z.boolean().default(false),
});
router.get(
  "/owner/orders",
  auth,
  owner,
  asyncRoute(async (req, res) => {
    const restaurantFilter =
      req.user.role === "admin" ? {} : { owner: req.user._id };
    const restaurants = await Restaurant.find(restaurantFilter).select(
      "name image isOpen isApproved",
    );
    const orders = await Order.find({
      restaurant: { $in: restaurants.map((restaurant) => restaurant._id) },
      paymentStatus: { $in: ["paid", "cod"] },
      status: { $ne: "payment_pending" },
    })
      .populate("user", "name email phone")
      .populate("restaurant", "name image")
      .sort({ createdAt: -1 });
    res.json({ restaurants, orders });
  }),
);
router.patch(
  "/owner/orders/:id",
  auth,
  owner,
  asyncRoute(async (req, res) => {
    const nextStatus = z
      .enum(["confirmed", "preparing", "on_the_way", "delivered", "cancelled"])
      .parse(req.body.status);
    const restaurantIds = await Restaurant.find(
      req.user.role === "admin" ? {} : { owner: req.user._id },
    ).distinct("_id");
    const order = await Order.findOne({
      _id: req.params.id,
      restaurant: { $in: restaurantIds },
    });
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (!["paid", "cod"].includes(order.paymentStatus))
      return res.status(409).json({
        message: "Only paid or cash-on-delivery orders can be prepared.",
      });
    const transitions = {
      placed: ["confirmed", "cancelled"],
      confirmed: ["preparing", "cancelled"],
      preparing: ["on_the_way", "cancelled"],
      on_the_way: ["delivered"],
      delivered: [],
      cancelled: [],
    };
    if (!transitions[order.status]?.includes(nextStatus))
      return res.status(409).json({
        message: `Cannot move an order from ${order.status} to ${nextStatus}.`,
      });
    order.status = nextStatus;
    await order.save();
    await notifyOrderStatusChanged(order._id, nextStatus);
    res.json({ order });
  }),
);
router.get(
  "/owner/menu",
  auth,
  owner,
  asyncRoute(async (req, res) => {
    const restaurantFilter =
      req.user.role === "admin" ? {} : { owner: req.user._id };
    const restaurantIds =
      await Restaurant.find(restaurantFilter).distinct("_id");
    const foods = await Food.find({ restaurant: { $in: restaurantIds } })
      .populate("restaurant", "name")
      .sort({ restaurant: 1, category: 1, name: 1 });
    res.json({ foods });
  }),
);

router.post(
  "/owner/menu",
  auth,
  owner,
  asyncRoute(async (req, res) => {
    const data = ownerFoodInput.parse(req.body);
    const restaurant = await Restaurant.findOne({
      _id: data.restaurantId,
      ...(req.user.role === "admin" ? {} : { owner: req.user._id }),
    });
    if (!restaurant)
      return res
        .status(404)
        .json({ message: "Restaurant not found in your account." });
    const { restaurantId, ...foodData } = data;
    const food = await Food.create({
      ...foodData,
      image:
        foodData.image ||
        "/images/food/photo-1546069901-ba9599a7e63c.jpg",
      restaurant: restaurant._id,
    });
    res.status(201).json({ food: await food.populate("restaurant", "name") });
  }),
);
router.patch(
  "/owner/menu/:id",
  auth,
  owner,
  asyncRoute(async (req, res) => {
    const data = ownerFoodInput
      .omit({ restaurantId: true })
      .partial()
      .strict()
      .parse(req.body);
    const restaurantIds = await Restaurant.find(
      req.user.role === "admin" ? {} : { owner: req.user._id },
    ).distinct("_id");
    const food = await Food.findOneAndUpdate(
      { _id: req.params.id, restaurant: { $in: restaurantIds } },
      data,
      { new: true, runValidators: true },
    ).populate("restaurant", "name");
    if (!food) return res.status(404).json({ message: "Menu item not found." });
    res.json({ food });
  }),
);

export default router;
