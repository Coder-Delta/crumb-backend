import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { User } from "../models.js";

let io;

export function initializeNotificationSocket(httpServer) {
  const origins = (process.env.CLIENT_URL || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  io = new Server(httpServer, {
    cors: { origin: origins, credentials: true },
    transports: ["websocket", "polling"],
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication required."));
      const payload = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: "crumb-api",
        audience: "crumb-client",
      });
      const user = await User.findById(payload.sub).select("_id active");
      if (!user?.active) return next(new Error("Account is unavailable."));
      socket.data.userId = String(user._id);
      next();
    } catch {
      next(new Error("Your session has expired. Please sign in again."));
    }
  });

  io.on("connection", (socket) => {
    socket.join(`user:${socket.data.userId}`);
  });

  return io;
}

export function emitNotification(recipientId, notification) {
  io?.to(`user:${recipientId}`).emit("notification:new", notification);
}

export function disconnectNotificationClients() {
  io?.disconnectSockets(true);
}
