import { Router } from "express";
import mongoose from "mongoose";
import LeaveRequest from "../models/LeaveRequest.js";
import LeaveBalance from "../models/LeaveBalance.js";
import requireAuth from "../middleware/requireAuth.js";
import requireRole from "../middleware/requireRole.js";
import { badRequest, forbidden, notFound } from "../utils/httpError.js";

const router = Router();

const LEAVE_TYPES = ["sick", "vacation", "personal"];

function requestResponse(req) {
    return {
        id:          req._id,
        employee:    req.employee,
        type:        req.type,
        startDate:   req.startDate,
        endDate:     req.endDate,
        totalHours:  req.totalHours,
        reason:      req.reason || "",
        status:      req.status,
        reviewedBy:  req.reviewedBy || null,
        reviewedAt:  req.reviewedAt || null,
        reviewNote:  req.reviewNote || "",
        createdAt:   req.createdAt,
        updatedAt:   req.updatedAt,
    };
}

// ─── Leave Balances (defined BEFORE /:id routes to avoid Express matching "balances" as an id) ───

/**
 * GET /api/leave/balances
 * Get leave balances.
 * Employees → their own only.
 * Managers/owners → all, or filtered by ?userId=<id>
 * Query: ?year=2026, ?userId=<id>
 */
router.get("/balances", requireAuth, async (req, res, next) => {
    try {
        const { year, userId } = req.query;
        const isPrivileged = ["owner", "manager"].includes(req.user.role);

        const filter = {};

        if (!isPrivileged) {
            filter.employee = req.user._id;
        } else if (userId) {
            if (!mongoose.isValidObjectId(userId)) throw badRequest("Invalid userId");
            filter.employee = userId;
        }

        if (year) {
            const y = parseInt(year, 10);
            if (isNaN(y)) throw badRequest("year must be a number");
            filter.year = y;
        }

        const balances = await LeaveBalance.find(filter)
            .populate("employee", "firstName lastName userId employeeMeta")
            .sort({ year: -1, type: 1 });

        return res.json(balances);
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/leave/balances
 * Set or update allocated hours for an employee. Managers/owners only.
 * Body: { employeeId, type, year, allocated }
 */
router.patch("/balances", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        const { employeeId, type, year, allocated } = req.body || {};

        if (!employeeId) throw badRequest("employeeId is required");
        if (!type)       throw badRequest("type is required");
        if (!year)       throw badRequest("year is required");
        if (allocated === undefined || allocated === null) throw badRequest("allocated is required");

        if (!mongoose.isValidObjectId(employeeId)) throw badRequest("Invalid employeeId");
        if (!LEAVE_TYPES.includes(type)) throw badRequest(`type must be one of: ${LEAVE_TYPES.join(", ")}`);

        const y = parseInt(year, 10);
        if (isNaN(y)) throw badRequest("year must be a number");

        const parsedAllocated = parseFloat(allocated);
        if (isNaN(parsedAllocated) || parsedAllocated < 0) throw badRequest("allocated must be a non-negative number");

        const balance = await LeaveBalance.findOneAndUpdate(
            { employee: employeeId, type, year: y },
            { $set: { allocated: parsedAllocated } },
            { upsert: true, new: true }
        ).populate("employee", "firstName lastName userId employeeMeta");

        return res.json(balance);
    } catch (err) {
        next(err);
    }
});

// ─── Leave Requests ───────────────────────────────────────────────────────────

/**
 * GET /api/leave
 * List leave requests.
 * Employees → their own only.
 * Managers/owners → all, or filtered by ?userId=<id>
 * Query: ?status=pending|approved|denied|cancelled, ?year=2026, ?userId=<id>
 */
router.get("/", requireAuth, async (req, res, next) => {
    try {
        const { status, year, userId } = req.query;
        const isPrivileged = ["owner", "manager"].includes(req.user.role);

        const filter = {};

        if (!isPrivileged) {
            filter.employee = req.user._id;
        } else if (userId) {
            if (!mongoose.isValidObjectId(userId)) throw badRequest("Invalid userId");
            filter.employee = userId;
        }

        if (status) {
            const VALID = ["pending", "approved", "denied", "cancelled"];
            if (!VALID.includes(status)) throw badRequest(`status must be one of: ${VALID.join(", ")}`);
            filter.status = status;
        }

        if (year) {
            const y = parseInt(year, 10);
            if (isNaN(y)) throw badRequest("year must be a number");
            filter.startDate = {
                $gte: new Date(y, 0, 1),
                $lte: new Date(y, 11, 31, 23, 59, 59, 999),
            };
        }

        const requests = await LeaveRequest.find(filter)
            .populate("employee", "firstName lastName userId employeeMeta")
            .populate("reviewedBy", "firstName lastName userId")
            .sort({ startDate: -1, createdAt: -1 });

        return res.json(requests.map(requestResponse));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/leave
 * Create a new leave request (any authenticated user, for themselves).
 * Body: { type, startDate, endDate, totalHours, reason? }
 */
router.post("/", requireAuth, async (req, res, next) => {
    try {
        const { type, startDate, endDate, totalHours, reason } = req.body || {};

        if (!type)       throw badRequest("type is required");
        if (!startDate)  throw badRequest("startDate is required");
        if (!endDate)    throw badRequest("endDate is required");
        if (totalHours === undefined || totalHours === null) throw badRequest("totalHours is required");

        if (!LEAVE_TYPES.includes(type)) throw badRequest(`type must be one of: ${LEAVE_TYPES.join(", ")}`);

        const start = new Date(startDate);
        const end   = new Date(endDate);
        if (isNaN(start.getTime())) throw badRequest("startDate is invalid");
        if (isNaN(end.getTime()))   throw badRequest("endDate is invalid");
        if (end < start)            throw badRequest("endDate must be on or after startDate");

        const parsedHours = parseFloat(totalHours);
        if (isNaN(parsedHours) || parsedHours < 0.25) throw badRequest("totalHours must be at least 0.25");

        const leaveReq = await LeaveRequest.create({
            employee:   req.user._id,
            type,
            startDate:  start,
            endDate:    end,
            totalHours: parsedHours,
            reason:     reason ? String(reason).trim() : undefined,
        });

        // Add to pending balance for this year
        const year = start.getFullYear();
        await LeaveBalance.findOneAndUpdate(
            { employee: req.user._id, type, year },
            { $inc: { pending: parsedHours } },
            { upsert: true, new: true }
        );

        await leaveReq.populate("employee", "firstName lastName userId employeeMeta");
        return res.status(201).json(requestResponse(leaveReq));
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/leave/:id
 * Get a single leave request.
 * Employees can only fetch their own.
 */
router.get("/:id", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Request not found");

        const leaveReq = await LeaveRequest.findById(req.params.id)
            .populate("employee", "firstName lastName userId employeeMeta")
            .populate("reviewedBy", "firstName lastName userId");

        if (!leaveReq) throw notFound("Request not found");

        const isPrivileged = ["owner", "manager"].includes(req.user.role);
        if (!isPrivileged && !leaveReq.employee._id.equals(req.user._id)) {
            throw forbidden("You do not have permission to view this request");
        }

        return res.json(requestResponse(leaveReq));
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/leave/:id
 * Edit a pending leave request. Only the request owner; only pending requests.
 * Body: { type?, startDate?, endDate?, totalHours?, reason? }
 */
router.patch("/:id", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Request not found");

        const leaveReq = await LeaveRequest.findById(req.params.id);
        if (!leaveReq) throw notFound("Request not found");

        if (!leaveReq.employee.equals(req.user._id)) {
            throw forbidden("You can only edit your own requests");
        }
        if (leaveReq.status !== "pending") {
            throw badRequest("Only pending requests can be edited");
        }

        const { type, startDate, endDate, totalHours, reason } = req.body || {};
        const oldHours = leaveReq.totalHours;
        const oldYear  = leaveReq.startDate.getFullYear();
        const oldType  = leaveReq.type;

        if (type !== undefined) {
            if (!LEAVE_TYPES.includes(type)) throw badRequest(`type must be one of: ${LEAVE_TYPES.join(", ")}`);
            leaveReq.type = type;
        }
        if (startDate !== undefined) {
            const d = new Date(startDate);
            if (isNaN(d.getTime())) throw badRequest("startDate is invalid");
            leaveReq.startDate = d;
        }
        if (endDate !== undefined) {
            const d = new Date(endDate);
            if (isNaN(d.getTime())) throw badRequest("endDate is invalid");
            leaveReq.endDate = d;
        }
        if (leaveReq.endDate < leaveReq.startDate) {
            throw badRequest("endDate must be on or after startDate");
        }
        if (totalHours !== undefined) {
            const h = parseFloat(totalHours);
            if (isNaN(h) || h < 0.25) throw badRequest("totalHours must be at least 0.25");
            leaveReq.totalHours = h;
        }
        if (reason !== undefined) leaveReq.reason = String(reason).trim();

        await leaveReq.save();

        // Adjust pending balance: remove old, add new
        const newYear  = leaveReq.startDate.getFullYear();
        const newType  = leaveReq.type;
        const newHours = leaveReq.totalHours;

        if (oldYear === newYear && oldType === newType) {
            const diff = newHours - oldHours;
            if (diff !== 0) {
                await LeaveBalance.findOneAndUpdate(
                    { employee: req.user._id, type: newType, year: newYear },
                    [{ $set: { pending: { $max: [0, { $add: ["$pending", diff] }] } } }],
                    { upsert: true }
                );
            }
        } else {
            // Type or year changed — remove from old bucket, add to new bucket
            await LeaveBalance.findOneAndUpdate(
                { employee: req.user._id, type: oldType, year: oldYear },
                [{ $set: { pending: { $max: [0, { $subtract: ["$pending", oldHours] }] } } }]
            );
            await LeaveBalance.findOneAndUpdate(
                { employee: req.user._id, type: newType, year: newYear },
                { $inc: { pending: newHours } },
                { upsert: true }
            );
        }

        await leaveReq.populate("employee", "firstName lastName userId employeeMeta");
        return res.json(requestResponse(leaveReq));
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/leave/:id
 * Cancel a pending leave request. Only the request owner.
 */
router.delete("/:id", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Request not found");

        const leaveReq = await LeaveRequest.findById(req.params.id);
        if (!leaveReq) throw notFound("Request not found");

        if (!leaveReq.employee.equals(req.user._id)) {
            throw forbidden("You can only cancel your own requests");
        }
        if (leaveReq.status !== "pending") {
            throw badRequest("Only pending requests can be cancelled");
        }

        const { type, totalHours, startDate } = leaveReq;
        const year = startDate.getFullYear();

        leaveReq.status = "cancelled";
        await leaveReq.save();

        // Release the pending hours (clamped to 0)
        await LeaveBalance.findOneAndUpdate(
            { employee: req.user._id, type, year },
            [{ $set: { pending: { $max: [0, { $subtract: ["$pending", totalHours] }] } } }]
        );

        return res.json({ message: "Request cancelled" });
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/leave/:id/review
 * Approve or deny a pending request. Managers/owners only.
 * Body: { action: "approve" | "deny", reviewNote? }
 */
router.patch("/:id/review", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Request not found");

        const leaveReq = await LeaveRequest.findById(req.params.id);
        if (!leaveReq) throw notFound("Request not found");

        if (leaveReq.status !== "pending") {
            throw badRequest("Only pending requests can be reviewed");
        }

        const { action, reviewNote } = req.body || {};
        if (!["approve", "deny"].includes(action)) throw badRequest('action must be "approve" or "deny"');

        const { type, totalHours, startDate } = leaveReq;
        const year = startDate.getFullYear();

        leaveReq.status     = action === "approve" ? "approved" : "denied";
        leaveReq.reviewedBy = req.user._id;
        leaveReq.reviewedAt = new Date();
        leaveReq.reviewNote = reviewNote ? String(reviewNote).trim() : undefined;

        await leaveReq.save();

        // Move hours from pending → used (approved) or just remove from pending (denied)
        if (action === "approve") {
            await LeaveBalance.findOneAndUpdate(
                { employee: leaveReq.employee, type, year },
                [{ $set: {
                    pending: { $max: [0, { $subtract: ["$pending", totalHours] }] },
                    used:    { $add: ["$used", totalHours] },
                } }],
                { upsert: true }
            );
        } else {
            await LeaveBalance.findOneAndUpdate(
                { employee: leaveReq.employee, type, year },
                [{ $set: { pending: { $max: [0, { $subtract: ["$pending", totalHours] }] } } }]
            );
        }

        await leaveReq.populate("employee", "firstName lastName userId employeeMeta");
        await leaveReq.populate("reviewedBy", "firstName lastName userId");
        return res.json(requestResponse(leaveReq));
    } catch (err) {
        next(err);
    }
});

export default router;
