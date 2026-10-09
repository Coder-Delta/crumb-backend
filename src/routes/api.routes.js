import express from "express";
import paymentsRouter from "./payments.routes.js";
import locationRouter from "./location.routes.js";
import authRouter from "./auth.routes.js";
import restaurantsRouter from "./restaurants.routes.js";
import ordersRouter from "./orders.routes.js";
import ownerRouter from "./owner.routes.js";
import adminRouter from "./admin.routes.js";
import notificationsRouter from "./notifications.routes.js";

const router = express.Router();
router.use(paymentsRouter);
router.use(locationRouter);
router.use(authRouter);
router.use(restaurantsRouter);
router.use(ordersRouter);
router.use(ownerRouter);
router.use(adminRouter);
router.use(notificationsRouter);

export default router;
