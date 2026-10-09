import express from "express";
import { z } from "zod";
import { Notification } from "../models.js";
import { auth, asyncRoute } from "../middleware.js";

const router = express.Router();

router.get(
  "/notifications",
  auth,
  asyncRoute(async (req, res) => {
    const { limit = 30 } = z
      .object({ limit: z.coerce.number().int().min(1).max(50).default(30) })
      .parse(req.query);
    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ recipient: req.user._id })
        .sort({ createdAt: -1 })
        .limit(limit),
      Notification.countDocuments({ recipient: req.user._id, readAt: null }),
    ]);
    res.json({ notifications, unreadCount });
  }),
);

router.patch(
  "/notifications/read-all",
  auth,
  asyncRoute(async (req, res) => {
    await Notification.updateMany(
      { recipient: req.user._id, readAt: null },
      { $set: { readAt: new Date() } },
    );
    res.json({ message: "Notifications marked as read." });
  }),
);

router.patch(
  "/notifications/:id/read",
  auth,
  asyncRoute(async (req, res) => {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user._id, readAt: null },
      { $set: { readAt: new Date() } },
      { new: true },
    );
    if (!notification) {
      const exists = await Notification.exists({
        _id: req.params.id,
        recipient: req.user._id,
      });
      if (!exists)
        return res.status(404).json({ message: "Notification not found." });
    }
    res.json({ notification });
  }),
);

export default router;
