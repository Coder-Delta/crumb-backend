import express from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware.js";
const router = express.Router();
const geocodeCache = new Map();
let lastGeocodeRequestAt = 0;

router.get("/health", (req, res) =>
  res.json({ status: "ok", service: "crumb-api" }),
);
router.get(
  "/location/reverse",
  asyncRoute(async (req, res) => {
    const { latitude, longitude } = z
      .object({
        latitude: z.coerce.number().min(-90).max(90),
        longitude: z.coerce.number().min(-180).max(180),
      })
      .parse(req.query);
    const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const cached = geocodeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return res.json(cached.result);
    const wait = 1000 - (Date.now() - lastGeocodeRequestAt);
    if (wait > 0) {
      res.set("Retry-After", String(Math.ceil(wait / 1000)));
      return res.status(429).json({
        message: "Location lookup is busy. Please try again in a moment.",
      });
    }
    lastGeocodeRequestAt = Date.now();
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.search = new URLSearchParams({
      format: "jsonv2",
      lat: String(latitude),
      lon: String(longitude),
      zoom: "18",
      addressdetails: "1",
    }).toString();
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          process.env.NOMINATIM_USER_AGENT ||
          "CrumbFoodOrdering/1.0 (http://localhost:5173)",
        Referer:
          process.env.CLIENT_URL?.split(",")[0] || "http://localhost:5173",
        "Accept-Language": "en",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok)
      throw Object.assign(
        new Error(
          "Address lookup service is unavailable. Please enter your address manually.",
        ),
        { status: 502 },
      );
    const data = await response.json();
    if (!data.display_name)
      throw Object.assign(
        new Error(
          "We could not find a street address here. Please enter it manually.",
        ),
        { status: 404 },
      );
    const result = {
      latitude,
      longitude,
      address: data.display_name,
      addressDetails: data.address || {},
    };
    geocodeCache.set(key, { result, expiresAt: Date.now() + 5 * 60 * 1000 });
    if (geocodeCache.size > 500)
      geocodeCache.delete(geocodeCache.keys().next().value);
    res.json(result);
  }),
);

export default router;
