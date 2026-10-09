import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { z } from "zod";
import { User, Restaurant } from "../models.js";
import { auth, asyncRoute } from "../middleware.js";
import { authenticateGoogleCredential } from "../services/googleAuth.js";
const router = express.Router();
const emailSchema = z.string().email().max(254);
const safeUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  phone: user.phone,
  addresses: user.addresses,
});
function tokenFor(user) {
  return jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, {
    expiresIn: "7d",
    issuer: "crumb-api",
    audience: "crumb-client",
  });
}
router.post(
  "/auth/register",
  asyncRoute(async (req, res) => {
    const data = z
      .object({
        name: z.string().trim().min(2).max(80),
        email: emailSchema,
        password: z.string().min(8).max(72),
        accountType: z.enum(["buyer", "seller"]).default("buyer"),
        restaurant: z
          .object({
            name: z.string().trim().min(2).max(120),
            cuisine: z.array(z.string().trim().min(2).max(40)).min(1).max(8),
            address: z.string().trim().min(5).max(250),
            contactPhone: z.string().trim().min(7).max(30),
            description: z.string().trim().max(500).optional(),
          })
          .optional(),
      })
      .superRefine((value, context) => {
        if (value.accountType === "seller" && !value.restaurant) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["restaurant"],
            message: "Restaurant details are required for seller registration.",
          });
        }
      })
      .parse(req.body);
    const user = await User.create({
      name: data.name,
      email: data.email.toLowerCase(),
      password: await bcrypt.hash(data.password, 12),
      role: data.accountType === "seller" ? "restaurant_owner" : "customer",
    });
    if (data.accountType === "seller") {
      try {
        const business = data.restaurant;
        const slugBase =
          business.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 110) || "restaurant";
        await Restaurant.create({
          ...business,
          slug: `${slugBase}-${crypto.randomBytes(3).toString("hex")}`,
          image:
            "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1000&q=85",
          cuisine: business.cuisine,
          tags: business.cuisine,
          owner: user._id,
          isApproved: false,
          isOpen: false,
        });
      } catch (error) {
        await User.deleteOne({ _id: user._id });
        throw error;
      }
    }
    res.status(201).json({ token: tokenFor(user), user: safeUser(user) });
  }),
);
router.post(
  "/auth/login",
  asyncRoute(async (req, res) => {
    const data = z
      .object({ email: emailSchema, password: z.string().min(1).max(72) })
      .parse(req.body);
    const user = await User.findOne({ email: data.email.toLowerCase() }).select(
      "+password",
    );
    if (
      !user ||
      !user.active ||
      !user.password ||
      !(await bcrypt.compare(data.password, user.password))
    )
      return res
        .status(401)
        .json({ message: "Email or password is incorrect." });
    res.json({ token: tokenFor(user), user: safeUser(user) });
  }),
);
router.post(
  "/auth/google",
  asyncRoute(async (req, res) => {
    const { credential } = z
      .object({ credential: z.string().min(20).max(5000) })
      .strict()
      .parse(req.body);
    const user = await authenticateGoogleCredential(credential);
    res.json({ token: tokenFor(user), user: safeUser(user) });
  }),
);
router.get("/auth/me", auth, (req, res) =>
  res.json({ user: safeUser(req.user) }),
);
router.patch(
  "/auth/me",
  auth,
  asyncRoute(async (req, res) => {
    const data = z
      .object({
        name: z.string().trim().min(2).max(80).optional(),
        phone: z.string().max(30).optional(),
        addresses: z
          .array(
            z.object({
              label: z.string().max(30),
              line: z.string().max(250),
              city: z.string().max(80),
              postalCode: z.string().max(20),
              latitude: z.number().min(-90).max(90).optional(),
              longitude: z.number().min(-180).max(180).optional(),
            }),
          )
          .max(10)
          .optional(),
      })
      .strict()
      .parse(req.body);
    Object.assign(req.user, data);
    await req.user.save();
    res.json({ user: safeUser(req.user) });
  }),
);

export default router;
