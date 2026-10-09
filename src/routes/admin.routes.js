import express from "express";
import { z } from "zod";
import { User, Restaurant, Food, Order } from "../models.js";
import { auth, admin, asyncRoute } from "../middleware.js";
import { notifyOrderStatusChanged } from "../services/notifications.js";
const router = express.Router();
const imageSchema = z.union([
  z.string().url(),
  z.string().regex(/^\/images\/[a-zA-Z0-9/_-]+\.(?:avif|gif|jpe?g|png|webp)$/i),
]);

router.get(
  "/admin/stats",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const [users, restaurants, foods, orders, revenue] = await Promise.all([
      User.countDocuments(),
      Restaurant.countDocuments(),
      Food.countDocuments(),
      Order.countDocuments({ paymentStatus: { $in: ["paid", "cod"] } }),
      Order.aggregate([
        {
          $match: {
            status: { $ne: "cancelled" },
            paymentStatus: { $in: ["paid", "cod"] },
          },
        },
        { $group: { _id: null, total: { $sum: "$total" } } },
      ]),
    ]);
    res.json({
      stats: {
        users,
        restaurants,
        foods,
        orders,
        revenue: revenue[0]?.total || 0,
      },
    });
  }),
);
router.get(
  "/admin/users",
  auth,
  admin,
  asyncRoute(async (req, res) =>
    res.json({ users: await User.find().sort({ createdAt: -1 }) }),
  ),
);
router.patch(
  "/admin/users/:id",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const data = z
      .object({
        active: z.boolean().optional(),
        role: z.enum(["customer", "restaurant_owner"]).optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0)
      .parse(req.body);
    if (String(req.user._id) === req.params.id && data.active === false)
      return res
        .status(400)
        .json({ message: "You cannot disable your own admin account." });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found." });
    if (user.role === "admin")
      return res
        .status(400)
        .json({ message: "Admin roles cannot be changed here." });
    if (
      data.role === "customer" &&
      (await Restaurant.exists({ owner: user._id }))
    )
      return res.status(409).json({
        message: "Reassign this user’s restaurants before changing their role.",
      });
    Object.assign(user, data);
    await user.save();
    res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        active: user.active,
        createdAt: user.createdAt,
      },
    });
  }),
);
router.get(
  "/admin/orders",
  auth,
  admin,
  asyncRoute(async (req, res) =>
    res.json({
      orders: await Order.find({ paymentStatus: { $in: ["paid", "cod"] } })
        .populate("user", "name email")
        .populate("restaurant", "name")
        .sort({ createdAt: -1 }),
    }),
  ),
);
router.patch(
  "/admin/orders/:id",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const status = z
      .enum(["confirmed", "preparing", "on_the_way", "delivered", "cancelled"])
      .parse(req.body.status);
    const order = await Order.findOne({
      _id: req.params.id,
      paymentStatus: { $in: ["paid", "cod"] },
    });
    if (!order) return res.status(404).json({ message: "Order not found." });
    order.status = status;
    await order.save();
    await notifyOrderStatusChanged(order._id, status);
    await order.populate("user", "name email");
    await order.populate("restaurant", "name");
    res.json({ order });
  }),
);
router.get(
  "/admin/restaurants",
  auth,
  admin,
  asyncRoute(async (req, res) =>
    res.json({
      restaurants: await Restaurant.find()
        .populate("owner", "name email")
        .sort({ createdAt: -1 }),
    }),
  ),
);
router.patch(
  "/admin/restaurants/:id/owner",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const data = z
      .object({
        ownerId: z
          .string()
          .regex(/^[0-9a-f]{24}$/i)
          .nullable(),
      })
      .strict()
      .parse(req.body);
    if (
      data.ownerId &&
      !(await User.exists({
        _id: data.ownerId,
        role: "restaurant_owner",
        active: true,
      }))
    )
      return res
        .status(400)
        .json({ message: "Select an active restaurant owner account." });
    const restaurant = await Restaurant.findByIdAndUpdate(
      req.params.id,
      { owner: data.ownerId },
      { new: true },
    ).populate("owner", "name email");
    if (!restaurant)
      return res.status(404).json({ message: "Restaurant not found." });
    res.json({ restaurant });
  }),
);
const restaurantInput = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(140)
    .regex(/^[a-z0-9-]+$/),
  cuisine: z.array(z.string().max(40)).min(1),
  description: z.string().max(500).optional(),
  address: z.string().max(250).optional(),
  contactPhone: z.string().max(30).optional(),
  image: imageSchema,
  deliveryTime: z.string().max(40).optional(),
  deliveryFee: z.number().min(0).max(1000).optional(),
  priceForTwo: z.number().min(0).max(100000).optional(),
  rating: z.number().min(0).max(5).optional(),
  isApproved: z.boolean().optional(),
  isOpen: z.boolean().optional(),
  promoted: z.boolean().optional(),
});
router.post(
  "/admin/restaurants",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const data = restaurantInput.parse(req.body);
    res.status(201).json({ restaurant: await Restaurant.create(data) });
  }),
);
router.patch(
  "/admin/restaurants/:id",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const data = restaurantInput.partial().parse(req.body);
    const restaurant = await Restaurant.findByIdAndUpdate(req.params.id, data, {
      new: true,
      runValidators: true,
    });
    if (!restaurant)
      return res.status(404).json({ message: "Restaurant not found." });
    res.json({ restaurant });
  }),
);
router.delete(
  "/admin/restaurants/:id",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    await Promise.all([
      Restaurant.findByIdAndDelete(req.params.id),
      Food.deleteMany({ restaurant: req.params.id }),
    ]);
    res.json({ message: "Restaurant and its menu removed." });
  }),
);
router.get(
  "/admin/foods",
  auth,
  admin,
  asyncRoute(async (req, res) =>
    res.json({
      foods: await Food.find()
        .populate("restaurant", "name")
        .sort({ createdAt: -1 }),
    }),
  ),
);
const foodInput = z.object({
  restaurant: z.string().regex(/^[0-9a-f]{24}$/i),
  name: z.string().trim().min(2).max(120),
  description: z.string().max(500).optional(),
  category: z.string().max(50).optional(),
  image: imageSchema,
  price: z.number().min(0).max(100000),
  veg: z.boolean().optional(),
  bestseller: z.boolean().optional(),
  available: z.boolean().optional(),
});
router.post(
  "/admin/foods",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const data = foodInput.parse(req.body);
    if (!(await Restaurant.exists({ _id: data.restaurant })))
      return res.status(400).json({ message: "Choose a valid restaurant." });
    res.status(201).json({ food: await Food.create(data) });
  }),
);
router.patch(
  "/admin/foods/:id",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const data = foodInput.partial().parse(req.body);
    const food = await Food.findByIdAndUpdate(req.params.id, data, {
      new: true,
      runValidators: true,
    });
    if (!food) return res.status(404).json({ message: "Food item not found." });
    res.json({ food });
  }),
);
router.delete(
  "/admin/foods/:id",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    await Food.findByIdAndDelete(req.params.id);
    res.json({ message: "Food item removed." });
  }),
);

export default router;
