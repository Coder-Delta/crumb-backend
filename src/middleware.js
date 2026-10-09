import jwt from "jsonwebtoken";
import { User } from "./models.js";

export async function auth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return res.status(401).json({ message: "Please sign in to continue." });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: "crumb-api",
      audience: "crumb-client",
    });
  } catch {
    return res
      .status(401)
      .json({ message: "Your session has expired. Please sign in again." });
  }

  try {
    req.user = await User.findById(payload.sub);
    if (!req.user || !req.user.active) {
      return res
        .status(401)
        .json({ message: "Account not found or disabled." });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
export function admin(req, res, next) {
  if (req.user?.role !== "admin")
    return res.status(403).json({ message: "Admin access required." });
  next();
}
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err?.name === "ZodError")
    return res.status(400).json({
      message: "Please check the details and try again.",
      errors: err.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    });
  if (err?.code === 11000)
    return res
      .status(409)
      .json({ message: "An account with this email already exists." });
  if (err?.name === "ValidationError" || err?.name === "CastError")
    return res.status(400).json({ message: "The submitted data is invalid." });
  if (err?.type === "entity.parse.failed")
    return res
      .status(400)
      .json({ message: "Request body must contain valid JSON." });
  console.error(err);
  res.status(err.status || 500).json({
    message: err.status
      ? err.message
      : "Something went wrong. Please try again.",
  });
}

export function restaurantOwner(req, res, next) {
  if (!["restaurant_owner", "admin"].includes(req.user?.role)) {
    return res
      .status(403)
      .json({ message: "Restaurant owner access required." });
  }
  next();
}

export function asyncRoute(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}
