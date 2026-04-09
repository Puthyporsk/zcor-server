import Notification from "../models/Notification.js";
import User from "../models/User.js";

/**
 * Create a notification for a single recipient (fire-and-forget).
 */
export function notifyUser({ recipient, type, title, message, relatedEntity, metadata, createdBy }) {
  if (createdBy && recipient.toString() === createdBy.toString()) return;
  Notification.create({ recipient, type, title, message, relatedEntity, metadata, createdBy }).catch((err) =>
    console.error(`Failed to create ${type} notification:`, err)
  );
}

/**
 * Create notifications for all managers and owners (fire-and-forget).
 * Optionally exclude a specific user (e.g. the one performing the action).
 */
export async function notifyManagers({ type, title, message, relatedEntity, metadata, excludeUserId, createdBy }) {
  try {
    const exclude = excludeUserId || createdBy;
    const managers = await User.find({
      role: { $in: ["owner", "manager"] },
      status: "active",
    }).select("_id");

    for (const m of managers) {
      if (exclude && m._id.equals(exclude)) continue;
      Notification.create({
        recipient: m._id,
        type,
        title,
        message,
        relatedEntity,
        metadata,
        createdBy,
      }).catch((err) => console.error(`Failed to create ${type} notification:`, err));
    }
  } catch (err) {
    console.error(`Failed to notify managers for ${type}:`, err);
  }
}
