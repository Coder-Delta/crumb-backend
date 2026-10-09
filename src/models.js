import mongoose from "mongoose";

const { Schema, model } = mongoose;
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, select: false },
    googleId: { type: String, unique: true, sparse: true, select: false },
    role: {
      type: String,
      enum: ["customer", "restaurant_owner", "admin"],
      default: "customer",
    },
    active: { type: Boolean, default: true },
    phone: String,
    addresses: [
      {
        label: String,
        line: String,
        city: String,
        postalCode: String,
        latitude: Number,
        longitude: Number,
      },
    ],
  },
  { timestamps: true },
);
const restaurantSchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", index: true },
    cuisine: [String],
    description: String,
    address: String,
    contactPhone: String,
    image: String,
    rating: { type: Number, default: 4.5 },
    ratingCount: { type: Number, default: 0 },
    deliveryTime: { type: String, default: "25–35 min" },
    deliveryFee: { type: Number, default: 0 },
    minOrder: { type: Number, default: 0 },
    priceForTwo: { type: Number, default: 300 },
    promoted: { type: Boolean, default: false },
    isApproved: { type: Boolean, default: true },
    isOpen: { type: Boolean, default: true },
    tags: [String],
  },
  { timestamps: true },
);
const foodSchema = new Schema(
  {
    restaurant: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    description: String,
    category: { type: String, default: "Popular" },
    image: String,
    price: { type: Number, required: true, min: 0 },
    veg: { type: Boolean, default: false },
    bestseller: { type: Boolean, default: false },
    available: { type: Boolean, default: true },
  },
  { timestamps: true },
);
const orderSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    restaurant: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    items: [
      {
        food: { type: Schema.Types.ObjectId, ref: "Food" },
        name: String,
        image: String,
        price: Number,
        quantity: { type: Number, min: 1, max: 50 },
      },
    ],
    subtotal: Number,
    deliveryFee: Number,
    tax: Number,
    total: Number,
    address: { type: String, required: true },
    deliveryLocation: { latitude: Number, longitude: Number },
    paymentMethod: {
      type: String,
      enum: ["razorpay", "cash"],
      default: "razorpay",
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "cod", "failed"],
      default: "pending",
    },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpayEventIds: { type: [String], default: [], select: false },
    status: {
      type: String,
      enum: [
        "payment_pending",
        "placed",
        "confirmed",
        "preparing",
        "on_the_way",
        "delivered",
        "cancelled",
      ],
      default: "payment_pending",
    },
    eta: { type: Date, required: true },
  },
  { timestamps: true },
);
const notificationSchema = new Schema(
  {
    recipient: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    eventKey: { type: String, required: true },
    type: {
      type: String,
      enum: ["new_order", "order_status", "order_cancelled"],
      required: true,
    },
    title: { type: String, required: true, maxlength: 100 },
    message: { type: String, required: true, maxlength: 240 },
    link: { type: String, required: true, maxlength: 200 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);
notificationSchema.index({ recipient: 1, eventKey: 1 }, { unique: true });
notificationSchema.index({ recipient: 1, createdAt: -1 });
export const User = mongoose.models.User || model("User", userSchema);
export const Restaurant =
  mongoose.models.Restaurant || model("Restaurant", restaurantSchema);
export const Food = mongoose.models.Food || model("Food", foodSchema);
export const Order = mongoose.models.Order || model("Order", orderSchema);
export const Notification =
  mongoose.models.Notification || model("Notification", notificationSchema);
