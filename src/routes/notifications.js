import { Router } from "express";
import Notification from "../models/Notification.js";
import requireAuth from "../middleware/requireAuth.js";

const router = Router();

/**
 * GET /api/notifications
 * Returns user's notifications, newest first.
 * Query: ?unreadOnly=true&limit=20&skip=0
 */
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const filter = { recipient: req.user._id, deletedAt: null };
    if (req.query.unreadOnly === "true") filter.read = false;

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const skip = Number(req.query.skip) || 0;

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json(notifications);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/notifications/unread-count
 * Returns { count } for badge display.
 */
router.get("/unread-count", requireAuth, async (req, res, next) => {
  try {
    const count = await Notification.countDocuments({
      recipient: req.user._id,
      read: false,
      deletedAt: null,
    });
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/notifications/read-all
 * Mark all user's notifications as read.
 */
router.patch("/read-all", requireAuth, async (req, res, next) => {
  try {
    await Notification.updateMany(
      { recipient: req.user._id, read: false, deletedAt: null },
      { read: true }
    );
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read (verify ownership).
 */
router.patch("/:id/read", requireAuth, async (req, res, next) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user._id },
      { read: true },
      { new: true }
    );
    if (!notification) return res.status(404).json({ message: "Notification not found" });
    res.json(notification);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/notifications/:id
 * Soft-delete a single notification (verify ownership).
 */
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user._id, deletedAt: null },
      { deletedAt: new Date() },
      { new: true }
    );
    if (!notification) return res.status(404).json({ message: "Notification not found" });
    res.json({ message: "Notification deleted" });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/notifications
 * Soft-delete all notifications for the user.
 */
router.delete("/", requireAuth, async (req, res, next) => {
  try {
    await Notification.updateMany(
      { recipient: req.user._id, deletedAt: null },
      { deletedAt: new Date() }
    );
    res.json({ message: "All notifications deleted" });
  } catch (err) {
    next(err);
  }
});

export default router;
