import { Router } from "express";
import mongoose from "mongoose";
import TimeEntry from "../models/TimeEntry.js";
import requireAuth from "../middleware/requireAuth.js";
import requireRole from "../middleware/requireRole.js";
import { badRequest, forbidden, notFound } from "../utils/httpError.js";

const router = Router();

// Shape returned to the client
function entryResponse(entry) {
    return {
        id:          entry._id,
        project:     entry.project,
        task:        entry.task,
        description: entry.description || "",
        date:        entry.date,
        hours:       entry.hours,
        type:        entry.type,
        status:      entry.status,
        submittedAt: entry.submittedAt || null,
        reviewedBy:  entry.reviewedBy  || null,
        reviewedAt:  entry.reviewedAt  || null,
        reviewNote:  entry.reviewNote  || "",
        user:        entry.user,
        createdAt:   entry.createdAt,
        updatedAt:   entry.updatedAt,
    };
}

/**
 * GET /api/time-entries
 * List time entries.
 *
 * Employees  → always their own entries only.
 * Managers / Owners → all entries by default; pass ?userId=<id> to filter to one user.
 *
 * Query params:
 *   ?from=YYYY-MM-DD   start of date range (inclusive)
 *   ?to=YYYY-MM-DD     end of date range (inclusive)
 *   ?status=draft|submitted|approved|rejected
 *   ?userId=<mongoId>  (managers/owners only)
 */
router.get("/", requireAuth, async (req, res, next) => {
    try {
        const { from, to, status, userId } = req.query;
        const isPrivileged = ["owner", "manager"].includes(req.user.role);

        const filter = {};

        // Role-based user scoping
        if (!isPrivileged) {
            filter.user = req.user._id;
        } else if (userId) {
            if (!mongoose.isValidObjectId(userId)) {
                throw badRequest("Invalid userId");
            }
            filter.user = userId;
        }

        // Date range
        if (from || to) {
            filter.date = {};
            if (from) filter.date.$gte = new Date(from);
            if (to) {
                const toDate = new Date(to);
                toDate.setHours(23, 59, 59, 999);
                filter.date.$lte = toDate;
            }
        }

        // Status
        const VALID_STATUSES = ["draft", "submitted", "approved", "rejected"];
        if (status) {
            if (!VALID_STATUSES.includes(status)) {
                throw badRequest(`status must be one of: ${VALID_STATUSES.join(", ")}`);
            }
            filter.status = status;
        }

        const entries = await TimeEntry.find(filter)
            .populate("user", "firstName lastName userId")
            .populate("reviewedBy", "firstName lastName userId")
            .sort({ date: -1, createdAt: -1 });

        return res.json(entries.map(entryResponse));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/time-entries
 * Create a new time entry (any authenticated user).
 * Body: { project, task, description?, date, hours, type? }
 */
router.post("/", requireAuth, async (req, res, next) => {
    try {
        const { project, task, description, date, hours, type } = req.body || {};

        if (!project) throw badRequest("project is required");
        if (!task)    throw badRequest("task is required");
        if (!date)    throw badRequest("date is required");
        if (hours === undefined || hours === null) throw badRequest("hours is required");

        const parsedHours = parseFloat(hours);
        if (isNaN(parsedHours) || parsedHours < 0.25 || parsedHours > 24) {
            throw badRequest("hours must be a number between 0.25 and 24");
        }

        const entry = await TimeEntry.create({
            user:        req.user._id,
            project:     String(project).trim(),
            task:        String(task).trim(),
            description: description ? String(description).trim() : undefined,
            date:        new Date(date),
            hours:       parsedHours,
            type:        type || "billable",
        });

        return res.status(201).json(entryResponse(entry));
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/time-entries/:id
 * Get a single entry.
 * Employees can only fetch their own; managers/owners can fetch any.
 */
router.get("/:id", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Entry not found");

        const entry = await TimeEntry.findById(req.params.id)
            .populate("user", "firstName lastName userId")
            .populate("reviewedBy", "firstName lastName userId");

        if (!entry) throw notFound("Entry not found");

        const isPrivileged = ["owner", "manager"].includes(req.user.role);
        if (!isPrivileged && !entry.user._id.equals(req.user._id)) {
            throw forbidden("You do not have permission to view this entry");
        }

        return res.json(entryResponse(entry));
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/time-entries/:id
 * Update an entry's core fields.
 * Only the entry owner may edit; only draft or rejected entries can be edited.
 * Body: { project?, task?, description?, date?, hours?, type? }
 */
router.patch("/:id", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Entry not found");

        const entry = await TimeEntry.findById(req.params.id);
        if (!entry) throw notFound("Entry not found");

        if (!entry.user.equals(req.user._id)) {
            throw forbidden("You can only edit your own entries");
        }

        if (!["draft", "rejected"].includes(entry.status)) {
            throw badRequest("Only draft or rejected entries can be edited");
        }

        const { project, task, description, date, hours, type } = req.body || {};

        if (project !== undefined) entry.project = String(project).trim();
        if (task    !== undefined) entry.task    = String(task).trim();
        if (description !== undefined) entry.description = String(description).trim();
        if (date    !== undefined) entry.date    = new Date(date);
        if (type    !== undefined) entry.type    = type;

        if (hours !== undefined) {
            const parsedHours = parseFloat(hours);
            if (isNaN(parsedHours) || parsedHours < 0.25 || parsedHours > 24) {
                throw badRequest("hours must be a number between 0.25 and 24");
            }
            entry.hours = parsedHours;
        }

        // Editing a rejected entry resets it to draft
        if (entry.status === "rejected") {
            entry.status     = "draft";
            entry.reviewedBy = undefined;
            entry.reviewedAt = undefined;
            entry.reviewNote = undefined;
        }

        await entry.save();
        return res.json(entryResponse(entry));
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/time-entries/:id
 * Delete an entry. Only the owner; only draft entries.
 */
router.delete("/:id", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Entry not found");

        const entry = await TimeEntry.findById(req.params.id);
        if (!entry) throw notFound("Entry not found");

        if (!entry.user.equals(req.user._id)) {
            throw forbidden("You can only delete your own entries");
        }

        if (entry.status !== "draft") {
            throw badRequest("Only draft entries can be deleted");
        }

        await entry.deleteOne();
        return res.json({ message: "Entry deleted" });
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/time-entries/:id/submit
 * Submit a draft entry for manager review. Only the entry owner.
 */
router.patch("/:id/submit", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Entry not found");

        const entry = await TimeEntry.findById(req.params.id);
        if (!entry) throw notFound("Entry not found");

        if (!entry.user.equals(req.user._id)) {
            throw forbidden("You can only submit your own entries");
        }

        if (entry.status !== "draft") {
            throw badRequest("Only draft entries can be submitted");
        }

        entry.status      = "submitted";
        entry.submittedAt = new Date();
        await entry.save();

        return res.json(entryResponse(entry));
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/time-entries/:id/review
 * Approve or reject a submitted entry. Managers and owners only.
 * Body: { action: "approve" | "reject", reviewNote? }
 */
router.patch("/:id/review", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Entry not found");

        const entry = await TimeEntry.findById(req.params.id);
        if (!entry) throw notFound("Entry not found");

        if (entry.status !== "submitted") {
            throw badRequest("Only submitted entries can be reviewed");
        }

        const { action, reviewNote } = req.body || {};

        if (!["approve", "reject"].includes(action)) {
            throw badRequest('action must be "approve" or "reject"');
        }

        entry.status     = action === "approve" ? "approved" : "rejected";
        entry.reviewedBy = req.user._id;
        entry.reviewedAt = new Date();
        entry.reviewNote = reviewNote ? String(reviewNote).trim() : undefined;

        await entry.save();

        await entry.populate("reviewedBy", "firstName lastName userId");
        return res.json(entryResponse(entry));
    } catch (err) {
        next(err);
    }
});

export default router;
