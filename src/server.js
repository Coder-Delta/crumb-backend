import "dotenv/config";
import mongoose from "mongoose";
import app from "./app.js";
import { validateEnvironment } from "./config/environment.js";

validateEnvironment();
const port = Number(process.env.PORT || 5000);
const server = await mongoose
  .connect(process.env.MONGODB_URI)
  .then(() =>
    app.listen(port, () => console.log(`Crumb API listening on port ${port}`)),
  );

async function shutdown(signal) {
  console.log(`${signal} received; shutting down gracefully.`);
  server.close(async () => {
    await mongoose.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
