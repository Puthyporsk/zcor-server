import { Router } from "express";
import mongoose from "mongoose";
import ClockSession from "../models/ClockSession.js";
import TimeEntry from "../models/TimeEntry.js";
import LeaveRequest from "../models/LeaveRequest.js";
import requireAuth from "../middleware/requireAuth.js";
import { badRequest } from "../utils/httpError.js";

const router = Router();

const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours

function roundToQuarter(n) {
  return Math.max(0.25, Math.round(n * 4) / 4);
}

async function populateSession(session) {
  await session.populate("project", "name");
  await session.populate("task", "name");
  return session;
}

function sessionResponse(session) {
  return {
    id:          session._id,
    project:     session.project ? { id: session.project._id, name: session.project.name } : null,
    task:        session.task    ? { id: session.task._id,    name: session.task.name    } : null,
    description: session.description || "",
    clockIn:     session.clockIn,
    clockOut:    session.clockOut,
    hours:       session.hours,
    status:      session.status,
    timeEntryId: session.timeEntryId,
    createdAt:   session.createdAt,
  };
}

/**
 * GET /api/clock/active
 * Returns the user's active clock session, or null.
 */
router.get("/active", requireAuth, async (req, res, next) => {
  try {
    let session = await ClockSession.findOne({ user: req.user._id, status: "active" });

    if (!session) return res.json(null);

    // Auto-close stale sessions
    const elapsed = Date.now() - new Date(session.clockIn).getTime();
    if (elapsed > STALE_THRESHOLD_MS) {
      session.status = "auto-closed";
      await session.save();
      await populateSession(session);
      return res.json({ ...sessionResponse(session), stale: true });
    }

    await populateSession(session);
    res.json(sessionResponse(session));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/clock/in
 * Start a new clock session.
 * Body: { projectId, taskId, description? }
 */
router.post("/in", requireAuth, async (req, res, next) => {
  try {
    const { projectId, taskId, description } = req.body || {};

    if (!projectId) throw badRequest("projectId is required");
    if (!taskId)    throw badRequest("taskId is required");
    if (!mongoose.isValidObjectId(projectId)) throw badRequest("Invalid projectId");
    if (!mongoose.isValidObjectId(taskId))    throw badRequest("Invalid taskId");

    // Check for existing active session
    const existing = await ClockSession.findOne({ user: req.user._id, status: "active" });
    if (existing) {
      // Auto-close if stale
      const elapsed = Date.now() - new Date(existing.clockIn).getTime();
      if (elapsed > STALE_THRESHOLD_MS) {
        existing.status = "auto-closed";
        await existing.save();
        await populateSession(existing);
        return res.status(409).json({
          message: "You have a stale clock session that needs to be resolved first.",
          staleSession: { ...sessionResponse(existing), stale: true },
        });
      }
      throw badRequest("You already have an active clock session. Clock out first.");
    }

    // Leave conflict check
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const leaveOnDay = await LeaveRequest.findOne({
      employee:  req.user._id,
      status:    "approved",
      type:      "vacation",
      startDate: { $lte: today },
      endDate:   { $gte: today },
    });
    if (leaveOnDay) throw badRequest("You have approved leave today and cannot clock in.");

    const session = await ClockSession.create({
      user:        req.user._id,
      project:     projectId,
      task:        taskId,
      description: description ? String(description).trim() : undefined,
      clockIn:     new Date(),
    });

    await populateSession(session);
    res.status(201).json(sessionResponse(session));
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/clock/out
 * End the active clock session and create a TimeEntry.
 * Body: { projectId?, taskId?, description?, type? }
 */
router.patch("/out", requireAuth, async (req, res, next) => {
  try {
    const session = await ClockSession.findOne({ user: req.user._id, status: "active" });
    if (!session) throw badRequest("No active clock session found.");

    const { projectId, taskId, description, type } = req.body || {};

    // Allow overrides
    if (projectId && mongoose.isValidObjectId(projectId)) session.project = projectId;
    if (taskId && mongoose.isValidObjectId(taskId))       session.task = taskId;
    if (description !== undefined) session.description = String(description).trim();

    const now = new Date();
    session.clockOut = now;
    session.hours = roundToQuarter((now - session.clockIn) / 3600000);

    // Create the TimeEntry
    const entry = await TimeEntry.create({
      user:        req.user._id,
      project:     session.project,
      task:        session.task,
      description: session.description || undefined,
      date:        session.clockIn, // work date = the day they clocked in
      hours:       session.hours,
      type:        type || "billable",
      entryMethod: "clock",
    });

    session.timeEntryId = entry._id;
    session.status = "completed";
    await session.save();

    await entry.populate("project", "name");
    await entry.populate("task", "name");
    await populateSession(session);

    res.json({
      session: sessionResponse(session),
      entry: {
        id:          entry._id,
        project:     entry.project ? { id: entry.project._id, name: entry.project.name } : null,
        task:        entry.task    ? { id: entry.task._id,    name: entry.task.name    } : null,
        description: entry.description || "",
        date:        entry.date,
        hours:       entry.hours,
        type:        entry.type,
        status:      entry.status,
        entryMethod: entry.entryMethod,
        createdAt:   entry.createdAt,
        updatedAt:   entry.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/clock/resolve
 * Resolve a stale (auto-closed) session by providing a clock-out time.
 * Body: { clockOut, projectId?, taskId?, description?, type? }
 */
router.patch("/resolve", requireAuth, async (req, res, next) => {
  try {
    const session = await ClockSession.findOne({ user: req.user._id, status: "auto-closed" });
    if (!session) throw badRequest("No stale session to resolve.");

    const { clockOut, projectId, taskId, description, type } = req.body || {};
    if (!clockOut) throw badRequest("clockOut time is required.");

    const clockOutDate = new Date(clockOut);
    if (clockOutDate <= session.clockIn) throw badRequest("Clock-out must be after clock-in.");

    const diffHours = (clockOutDate - session.clockIn) / 3600000;
    if (diffHours > 24) throw badRequest("Session cannot exceed 24 hours.");

    if (projectId && mongoose.isValidObjectId(projectId)) session.project = projectId;
    if (taskId && mongoose.isValidObjectId(taskId))       session.task = taskId;
    if (description !== undefined) session.description = String(description).trim();

    session.clockOut = clockOutDate;
    session.hours = roundToQuarter(diffHours);

    const entry = await TimeEntry.create({
      user:        req.user._id,
      project:     session.project,
      task:        session.task,
      description: session.description || undefined,
      date:        session.clockIn,
      hours:       session.hours,
      type:        type || "billable",
      entryMethod: "clock",
    });

    session.timeEntryId = entry._id;
    session.status = "completed";
    await session.save();

    await entry.populate("project", "name");
    await entry.populate("task", "name");

    res.json({ message: "Session resolved.", entryId: entry._id });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/clock/discard
 * Discard an active or stale session without creating an entry.
 */
router.delete("/discard", requireAuth, async (req, res, next) => {
  try {
    const session = await ClockSession.findOne({
      user: req.user._id,
      status: { $in: ["active", "auto-closed"] },
    });
    if (!session) throw badRequest("No session to discard.");

    session.status = "discarded";
    await session.save();

    res.json({ message: "Session discarded." });
  } catch (err) {
    next(err);
  }
});

export default router;
