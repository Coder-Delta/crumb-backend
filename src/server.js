import "dotenv/config";
import { createServer } from "node:http";
import mongoose from "mongoose";
import app from "./app.js";
import { validateEnvironment } from "./config/environment.js";
import {
  startPaymentEventWorker,
  closePaymentEventWorker,
} from "./services/rabbitmq.js";
import {
  disconnectNotificationClients,
  initializeNotificationSocket,
} from "./services/notificationSocket.js";

validateEnvironment();
const port = Number(process.env.PORT || 5000);
await mongoose.connect(process.env.MONGODB_URI);
startPaymentEventWorker();
const server = createServer(app);
initializeNotificationSocket(server);
server.listen(port, () =>
  console.log(`Crumb API listening on port ${port}`),
);

async function shutdown(signal) {
  console.log(`${signal} received; shutting down gracefully.`);
  disconnectNotificationClients();
  server.close(async () => {
    await closePaymentEventWorker();
    await mongoose.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
