import mongoose from "mongoose";
import { Notification, Order } from "../models.js";
import { emitNotification } from "./notificationSocket.js";

const statusMessages = {
  confirmed: "The restaurant confirmed your order.",
  preparing: "The kitchen is preparing your food.",
  on_the_way: "Your order is on the way.",
  delivered: "Your order has been delivered. Enjoy!",
  cancelled: "Your order was cancelled.",
};

async function saveAndDeliver({ recipient, order, eventKey, ...details }) {
  if (!recipient) return;

  const now = new Date();
  const notification = {
    _id: new mongoose.Types.ObjectId(),
    recipient,
    order: order._id,
    eventKey,
    ...details,
    readAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const result = await Notification.updateOne(
    { recipient, eventKey },
    { $setOnInsert: notification },
    { upsert: true, timestamps: false },
  );
  if (result.upsertedCount) {
    emitNotification(String(recipient), {
      ...notification,
      _id: String(notification._id),
      recipient: String(recipient),
      order: String(order._id),
    });
  }
}

async function notificationContext(orderId) {
  return Order.findById(orderId)
    .select("user restaurant items status total")
    .populate("user", "name")
    .populate("restaurant", "name owner");
}

export async function notifyOrderPlaced(orderId) {
  try {
    const order = await notificationContext(orderId);
    if (!order) return;
    const restaurantName = order.restaurant?.name || "the restaurant";
    const orderNumber = String(order._id).slice(-7).toUpperCase();
    const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
    const customerName = order.user?.name || "A customer";

    await Promise.all([
      saveAndDeliver({
        recipient: order.user?._id,
        order,
        eventKey: `order:${order._id}:placed:buyer`,
        type: "order_status",
        title: "Order placed",
        message: `Your order at ${restaurantName} is on its way to the kitchen.`,
        link: `/orders/${order._id}`,
      }),
      saveAndDeliver({
        recipient: order.restaurant?.owner,
        order,
        eventKey: `order:${order._id}:placed:seller`,
        type: "new_order",
        title: "New order received",
        message: `Order #${orderNumber} from ${customerName} · ${itemCount} item${itemCount === 1 ? "" : "s"}.`,
        link: "/owner",
      }),
    ]);
  } catch (error) {
    console.error("Could not save order placed notifications:", error.message);
  }
}

export async function notifyOrderStatusChanged(orderId, status) {
  try {
    const order = await notificationContext(orderId);
    if (!order?.user?._id || !statusMessages[status]) return;

    await saveAndDeliver({
      recipient: order.user._id,
      order,
      eventKey: `order:${order._id}:status:${status}`,
      type: "order_status",
      title: status === "delivered" ? "Order delivered" : "Order update",
      message: statusMessages[status],
      link: `/orders/${order._id}`,
    });
  } catch (error) {
    console.error("Could not save order status notification:", error.message);
  }
}

export async function notifyOrderCancelledByBuyer(orderId) {
  try {
    const order = await notificationContext(orderId);
    if (!order?.restaurant?.owner) return;

    await saveAndDeliver({
      recipient: order.restaurant.owner,
      order,
      eventKey: `order:${order._id}:cancelled:buyer`,
      type: "order_cancelled",
      title: "Order cancelled",
      message: `Order #${String(order._id).slice(-7).toUpperCase()} was cancelled by the customer.`,
      link: "/owner",
    });
  } catch (error) {
    console.error("Could not save order cancellation notification:", error.message);
  }
}
