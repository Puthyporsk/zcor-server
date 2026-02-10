import { Router } from "express";
import User from "../models/User.js";
import requireAuth from "../middleware/requireAuth.js";

const router = Router();

/***
 * GET /api/users (protected)
 * Returns list of users
 */
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const users = await User.find()
      .select({})
      .sort({ createdAt: -1 });

    res.json(users);
  } catch (err) {
    next(err);
  }
});

/***
 * POST /api/users (protected)
 * Create a new user (Manager, Employee)
 */
router.post("/", requireAuth, async (req, res, next) => {
  try {
    // Create user logic here
    res.status(201).json({ message: "TODO: User created" });
  } catch (err) {
    next(err);
  }
});

export default router;