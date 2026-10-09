import express from "express";
import { Restaurant, Food } from "../models.js";
import { asyncRoute } from "../middleware.js";
const router = express.Router();
const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
router.get(
  "/restaurants",
  asyncRoute(async (req, res) => {
    const { q, cuisine, category, sort, veg, minRating, promoted } = req.query;
    const filter = { isOpen: true, isApproved: { $ne: false } };
    if (promoted === "true") filter.promoted = true;
    if (q) {
      const safeQuery = escapeRegex(String(q).slice(0, 80));
      filter.$or = [
        { name: { $regex: safeQuery, $options: "i" } },
        { cuisine: { $regex: safeQuery, $options: "i" } },
        { tags: { $regex: safeQuery, $options: "i" } },
      ];
      const matchingRestaurants = await Food.distinct("restaurant", {
        name: { $regex: safeQuery, $options: "i" },
        available: true,
      });
      filter.$or.push({ _id: { $in: matchingRestaurants } });
    }
    if (cuisine && cuisine !== "All") filter.cuisine = cuisine;
    if (category)
      filter.$and = [
        ...(filter.$and || []),
        { $or: [{ tags: category }, { cuisine: category }] },
      ];
    if (minRating)
      filter.rating = { $gte: Math.min(Number(minRating) || 0, 5) };
    let restaurants = await Restaurant.find(filter).lean();
    if (veg === "true") {
      const [vegetarianIds, nonVegetarianIds] = await Promise.all([
        Food.distinct("restaurant", { veg: true, available: true }),
        Food.distinct("restaurant", { veg: false, available: true }),
      ]);
      restaurants = restaurants.filter(
        (restaurant) =>
          vegetarianIds.some((id) => String(id) === String(restaurant._id)) &&
          !nonVegetarianIds.some((id) => String(id) === String(restaurant._id)),
      );
    }
    if (sort === "rating") restaurants.sort((a, b) => b.rating - a.rating);
    else if (sort === "delivery")
      restaurants.sort(
        (a, b) => parseInt(a.deliveryTime) - parseInt(b.deliveryTime),
      );
    else if (sort === "price")
      restaurants.sort((a, b) => a.priceForTwo - b.priceForTwo);
    else
      restaurants.sort(
        (a, b) =>
          Number(b.promoted) - Number(a.promoted) || b.rating - a.rating,
      );
    res.json({ restaurants, cuisines: await Restaurant.distinct("cuisine") });
  }),
);
router.get(
  "/restaurants/:id",
  asyncRoute(async (req, res) => {
    const restaurant = await Restaurant.findOne({
      $and: [
        { isOpen: true, isApproved: { $ne: false } },
        {
          $or: [
            {
              _id: req.params.id.match(/^[0-9a-f]{24}$/i)
                ? req.params.id
                : null,
            },
            { slug: req.params.id },
          ],
        },
      ],
    });
    if (!restaurant)
      return res.status(404).json({ message: "Restaurant not found." });
    const menu = await Food.find({
      restaurant: restaurant._id,
      available: true,
    }).sort({ category: 1, bestseller: -1 });
    res.json({ restaurant, menu });
  }),
);
router.get(
  "/foods",
  asyncRoute(async (req, res) => {
    const filter = { available: true };
    if (req.query.veg === "true") filter.veg = true;
    const foods = await Food.find(filter).populate("restaurant", "name slug");
    res.json({ foods });
  }),
);

export default router;
