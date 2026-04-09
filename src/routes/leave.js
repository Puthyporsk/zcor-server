import { Router } from "express";
import mongoose from "mongoose";
import LeaveRequest from "../models/LeaveRequest.js";
import LeaveBalance from "../models/LeaveBalance.js";
import LeaveAccrualPolicy from "../models/LeaveAccrualPolicy.js";
import User from "../models/User.js";
import requireAuth from "../middleware/requireAuth.js";
import requireRole from "../middleware/requireRole.js";
import { badRequest, forbidden, notFound } from "../utils/httpError.js";
import { notifyUser, notifyManagers } from "../utils/notify.js";
import { splitHoursByYear, getAvailableHours, initializeYearBalance } from "../utils/leaveAccrual.js";

const router = Router();

const LEAVE_TYPES = ["sick", "vacation", "personal"];

function requestResponse(req) {
    return {
        id:             req._id,
        employee:       req.employee,
        type:           req.type,
        startDate:      req.startDate,
        endDate:        req.endDate,
        totalHours:     req.totalHours,
        yearBreakdown:  req.yearBreakdown || [],
        reason:         req.reason || "",
        status:         req.status,
        reviewedBy:     req.reviewedBy || null,
        reviewedAt:     req.reviewedAt || null,
        reviewNote:     req.reviewNote || "",
        createdAt:      req.createdAt,
        updatedAt:      req.updatedAt,
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

        // Check for overlapping approved or pending leave
        const overlap = await LeaveRequest.findOne({
            employee: req.user._id,
            status: { $in: ["approved", "pending"] },
            startDate: { $lte: end },
            endDate:   { $gte: start },
        });
        if (overlap) {
            throw badRequest("You already have an approved or pending leave request that overlaps with the selected dates");
        }

        // Block requests beyond current year + 1
        const currentYear = new Date().getFullYear();
        const reqEndYear = end.getFullYear();
        if (reqEndYear > currentYear + 1) {
            throw badRequest("Leave requests cannot extend beyond next year");
        }

        // Compute year breakdown for cross-year support
        const yearBreakdown = splitHoursByYear(start, end, parsedHours);

        // Load policy and employee for mode-aware validation
        const policy = await LeaveAccrualPolicy.findOne({}) || new LeaveAccrualPolicy();
        const employee = await User.findById(req.user._id);

        // Validate each year's balance
        for (const { year, hours } of yearBreakdown) {
            // Auto-initialize balance for future years
            await initializeYearBalance(employee, type, year, policy);
            const balance = await LeaveBalance.findOne({ employee: req.user._id, type, year });
            const available = getAvailableHours(balance, employee, policy, type, year);
            if (hours > available) {
                throw badRequest(`Insufficient ${type} leave balance for ${year}. Available: ${available}h, Requested: ${hours}h`);
            }
        }

        const leaveReq = await LeaveRequest.create({
            employee:   req.user._id,
            type,
            startDate:  start,
            endDate:    end,
            totalHours: parsedHours,
            yearBreakdown,
            reason:     reason ? String(reason).trim() : undefined,
        });

        // Add to pending balance for each year
        for (const { year, hours } of yearBreakdown) {
            await LeaveBalance.findOneAndUpdate(
                { employee: req.user._id, type, year },
                { $inc: { pending: hours } },
                { upsert: true, new: true }
            );
        }

        await leaveReq.populate("employee", "firstName lastName userId employeeMeta");

        // Notify managers/owners
        const requesterName = `${req.user.firstName} ${req.user.lastName}`.trim();
        notifyManagers({
            type: "leave_request_submitted",
            title: "Leave Request Submitted",
            message: `${requesterName} submitted a ${type} leave request.`,
            relatedEntity: { kind: "LeaveRequest", item: leaveReq._id },
            createdBy: req.user._id,
        });

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

        // Check for overlapping approved or pending leave (exclude this request)
        const overlap = await LeaveRequest.findOne({
            _id: { $ne: leaveReq._id },
            employee: req.user._id,
            status: { $in: ["approved", "pending"] },
            startDate: { $lte: leaveReq.endDate },
            endDate:   { $gte: leaveReq.startDate },
        });
        if (overlap) {
            throw badRequest("You already have an approved or pending leave request that overlaps with the selected dates");
        }

        if (totalHours !== undefined) {
            const h = parseFloat(totalHours);
            if (isNaN(h) || h < 0.25) throw badRequest("totalHours must be at least 0.25");
            leaveReq.totalHours = h;
        }
        if (reason !== undefined) leaveReq.reason = String(reason).trim();

        // Block requests beyond current year + 1
        const currentYear = new Date().getFullYear();
        if (leaveReq.endDate.getFullYear() > currentYear + 1) {
            throw badRequest("Leave requests cannot extend beyond next year");
        }

        // Compute new year breakdown
        const newBreakdown = splitHoursByYear(leaveReq.startDate, leaveReq.endDate, leaveReq.totalHours);
        const oldBreakdown = leaveReq.yearBreakdown?.length
            ? leaveReq.yearBreakdown
            : [{ year: oldYear, hours: oldHours }]; // legacy fallback

        // Load policy and employee for mode-aware validation
        const policy = await LeaveAccrualPolicy.findOne({}) || new LeaveAccrualPolicy();
        const employee = await User.findById(req.user._id);

        // Revert old pending, then validate and apply new pending
        for (const { year, hours } of oldBreakdown) {
            await LeaveBalance.findOneAndUpdate(
                { employee: req.user._id, type: oldType, year },
                [{ $set: { pending: { $max: [0, { $subtract: ["$pending", hours] }] } } }]
            );
        }

        // Validate new breakdown
        for (const { year, hours } of newBreakdown) {
            await initializeYearBalance(employee, leaveReq.type, year, policy);
            const balance = await LeaveBalance.findOne({ employee: req.user._id, type: leaveReq.type, year });
            const available = getAvailableHours(balance, employee, policy, leaveReq.type, year);
            if (hours > available) {
                // Restore old pending before throwing
                for (const ob of oldBreakdown) {
                    await LeaveBalance.findOneAndUpdate(
                        { employee: req.user._id, type: oldType, year: ob.year },
                        { $inc: { pending: ob.hours } },
                        { upsert: true }
                    );
                }
                throw badRequest(`Insufficient ${leaveReq.type} leave balance for ${year}. Available: ${available}h, Requested: ${hours}h`);
            }
        }

        // Apply new pending
        for (const { year, hours } of newBreakdown) {
            await LeaveBalance.findOneAndUpdate(
                { employee: req.user._id, type: leaveReq.type, year },
                { $inc: { pending: hours } },
                { upsert: true }
            );
        }

        leaveReq.yearBreakdown = newBreakdown;
        await leaveReq.save();

        await leaveReq.populate("employee", "firstName lastName userId employeeMeta");
        return res.json(requestResponse(leaveReq));
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/leave/:id
 * Delete a leave request. Only the request owner.
 * Adjusts balances based on current status before removing.
 */
router.delete("/:id", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Request not found");

        const leaveReq = await LeaveRequest.findById(req.params.id);
        if (!leaveReq) throw notFound("Request not found");

        if (!leaveReq.employee.equals(req.user._id)) {
            throw forbidden("You can only delete your own requests");
        }

        const { type, totalHours, startDate, status } = leaveReq;
        const breakdown = leaveReq.yearBreakdown?.length
            ? leaveReq.yearBreakdown
            : [{ year: startDate.getFullYear(), hours: totalHours }]; // legacy fallback

        // Return hours to balance based on status
        if (status === "pending") {
            for (const { year, hours } of breakdown) {
                await LeaveBalance.findOneAndUpdate(
                    { employee: req.user._id, type, year },
                    [{ $set: { pending: { $max: [0, { $subtract: ["$pending", hours] }] } } }]
                );
            }
        } else if (status === "approved") {
            for (const { year, hours } of breakdown) {
                await LeaveBalance.findOneAndUpdate(
                    { employee: req.user._id, type, year },
                    [{ $set: { used: { $max: [0, { $subtract: ["$used", hours] }] } } }]
                );
            }
        }
        // denied/cancelled — no balance adjustment needed

        await leaveReq.deleteOne();

        return res.json({ message: "Request deleted" });
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
        const breakdown = leaveReq.yearBreakdown?.length
            ? leaveReq.yearBreakdown
            : [{ year: startDate.getFullYear(), hours: totalHours }]; // legacy fallback

        leaveReq.status     = action === "approve" ? "approved" : "denied";
        leaveReq.reviewedBy = req.user._id;
        leaveReq.reviewedAt = new Date();
        leaveReq.reviewNote = reviewNote ? String(reviewNote).trim() : undefined;

        await leaveReq.save();

        // Move hours from pending → used (approved) or just remove from pending (denied)
        for (const { year, hours } of breakdown) {
            if (action === "approve") {
                await LeaveBalance.findOneAndUpdate(
                    { employee: leaveReq.employee, type, year },
                    [{ $set: {
                        pending: { $max: [0, { $subtract: ["$pending", hours] }] },
                        used:    { $add: ["$used", hours] },
                    } }],
                    { upsert: true }
                );
            } else {
                await LeaveBalance.findOneAndUpdate(
                    { employee: leaveReq.employee, type, year },
                    [{ $set: { pending: { $max: [0, { $subtract: ["$pending", hours] }] } } }]
                );
            }
        }

        await leaveReq.populate("employee", "firstName lastName userId employeeMeta");
        await leaveReq.populate("reviewedBy", "firstName lastName userId");

        // Notify the employee
        const reviewerName = `${req.user.firstName} ${req.user.lastName}`.trim();
        const leaveStatus = action === "approve" ? "approved" : "denied";
        notifyUser({
            recipient: leaveReq.employee._id,
            type: action === "approve" ? "leave_request_approved" : "leave_request_denied",
            title: `Leave Request ${action === "approve" ? "Approved" : "Denied"}`,
            message: `${reviewerName} ${leaveStatus} your ${type} leave request.${reviewNote ? ` Note: ${reviewNote}` : ""}`,
            relatedEntity: { kind: "LeaveRequest", item: leaveReq._id },
            createdBy: req.user._id,
        });

        return res.json(requestResponse(leaveReq));
    } catch (err) {
        next(err);
    }
});

export default router;
