import { Router } from "express";
import mongoose from "mongoose";
import Shift from "../models/Shift.js";
import requireAuth from "../middleware/requireAuth.js";
import requireRole from "../middleware/requireRole.js";
import { badRequest, forbidden, notFound } from "../utils/httpError.js";

const router = Router();

// Parse "HH:MM" into total minutes (for overlap comparison)
function timeToMinutes(t) {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
}

function isValidTime(t) {
    return /^\d{2}:\d{2}$/.test(t);
}

function shiftResponse(shift) {
    return {
        id:        shift._id,
        employee:  shift.employee,
        date:      shift.date,
        startTime: shift.startTime,
        endTime:   shift.endTime,
        task:      shift.task || null,
        notes:     shift.notes || "",
        createdBy: shift.createdBy,
        createdAt: shift.createdAt,
        updatedAt: shift.updatedAt,
    };
}

// Returns the start/end of the calendar day for a given date
function dayBounds(date) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);
    return { dayStart, dayEnd };
}

// Checks for time overlap against existing shifts (excludes one shift by id if provided)
async function checkOverlap(employeeId, date, startTime, endTime, excludeId = null) {
    const { dayStart, dayEnd } = dayBounds(date);
    const filter = {
        employee: employeeId,
        date: { $gte: dayStart, $lte: dayEnd },
    };
    if (excludeId) filter._id = { $ne: excludeId };

    const existing = await Shift.find(filter);
    const startMin = timeToMinutes(startTime);
    const endMin   = timeToMinutes(endTime);

    for (const s of existing) {
        const sStart = timeToMinutes(s.startTime);
        const sEnd   = timeToMinutes(s.endTime);
        if (startMin < sEnd && endMin > sStart) {
            throw badRequest(
                `Shift overlaps with an existing shift (${s.startTime}–${s.endTime})`
            );
        }
    }
}

/**
 * GET /api/shifts
 * All authenticated users can see all shifts.
 * Query: ?from=YYYY-MM-DD, ?to=YYYY-MM-DD, ?userId=, ?taskId=
 */
router.get("/", requireAuth, async (req, res, next) => {
    try {
        const { from, to, userId, taskId } = req.query;
        const filter = {};

        if (userId) {
            if (!mongoose.isValidObjectId(userId)) throw badRequest("Invalid userId");
            filter.employee = userId;
        }

        if (taskId) {
            if (!mongoose.isValidObjectId(taskId)) throw badRequest("Invalid taskId");
            filter.task = taskId;
        }

        if (from || to) {
            filter.date = {};
            if (from) filter.date.$gte = new Date(from);
            if (to) {
                const toDate = new Date(to);
                toDate.setHours(23, 59, 59, 999);
                filter.date.$lte = toDate;
            }
        }

        const shifts = await Shift.find(filter)
            .populate("employee", "firstName lastName userId employeeMeta")
            .populate("task", "name")
            .populate("createdBy", "firstName lastName")
            .sort({ date: 1, startTime: 1 });

        return res.json(shifts.map(shiftResponse));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/shifts
 * Create a shift. Managers/owners only.
 * Body: { employeeId, date, startTime, endTime, taskId?, notes? }
 */
router.post("/", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        const { employeeId, date, startTime, endTime, taskId, notes } = req.body || {};

        if (!employeeId) throw badRequest("employeeId is required");
        if (!date)       throw badRequest("date is required");
        if (!startTime)  throw badRequest("startTime is required");
        if (!endTime)    throw badRequest("endTime is required");

        if (!mongoose.isValidObjectId(employeeId)) throw badRequest("Invalid employeeId");
        if (!isValidTime(startTime)) throw badRequest("startTime must be in HH:MM format");
        if (!isValidTime(endTime))   throw badRequest("endTime must be in HH:MM format");

        if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
            throw badRequest("endTime must be after startTime");
        }

        await checkOverlap(employeeId, date, startTime, endTime);

        const shift = await Shift.create({
            employee:  employeeId,
            date:      new Date(date),
            startTime,
            endTime,
            task:      taskId && mongoose.isValidObjectId(taskId) ? taskId : undefined,
            notes:     notes ? String(notes).trim() : undefined,
            createdBy: req.user._id,
        });

        await shift.populate("employee", "firstName lastName userId employeeMeta");
        await shift.populate("task", "name");

        return res.status(201).json(shiftResponse(shift));
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/shifts/:id
 * Edit a shift.
 * - Managers/owners: can edit all fields (employee, date, startTime, endTime, task, notes)
 * - Assigned employee: can only edit startTime, endTime, task, notes
 */
router.patch("/:id", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Shift not found");

        const shift = await Shift.findById(req.params.id);
        if (!shift) throw notFound("Shift not found");

        const isPrivileged      = ["owner", "manager"].includes(req.user.role);
        const isAssignedEmployee = shift.employee.equals(req.user._id);

        if (!isPrivileged && !isAssignedEmployee) {
            throw forbidden("You can only edit your own shifts");
        }

        const { startTime, endTime, taskId, notes } = req.body || {};

        let newStartTime = shift.startTime;
        let newEndTime   = shift.endTime;

        if (startTime !== undefined) {
            if (!isValidTime(startTime)) throw badRequest("startTime must be in HH:MM format");
            newStartTime = startTime;
        }
        if (endTime !== undefined) {
            if (!isValidTime(endTime)) throw badRequest("endTime must be in HH:MM format");
            newEndTime = endTime;
        }

        if (timeToMinutes(newEndTime) <= timeToMinutes(newStartTime)) {
            throw badRequest("endTime must be after startTime");
        }

        // Overlap check if times changed
        if (startTime !== undefined || endTime !== undefined) {
            await checkOverlap(shift.employee, shift.date, newStartTime, newEndTime, shift._id);
        }

        shift.startTime = newStartTime;
        shift.endTime   = newEndTime;
        if (taskId !== undefined) {
            shift.task = taskId && mongoose.isValidObjectId(taskId) ? taskId : undefined;
        }
        if (notes !== undefined) shift.notes = String(notes).trim();

        // Privileged-only fields
        if (isPrivileged) {
            const { employeeId, date } = req.body || {};
            if (employeeId !== undefined) {
                if (!mongoose.isValidObjectId(employeeId)) throw badRequest("Invalid employeeId");
                shift.employee = employeeId;
            }
            if (date !== undefined) shift.date = new Date(date);
        }

        await shift.save();
        await shift.populate("employee", "firstName lastName userId employeeMeta");
        await shift.populate("task", "name");

        return res.json(shiftResponse(shift));
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/shifts/:id
 * Delete a shift. Managers/owners only.
 */
router.delete("/:id", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Shift not found");

        const shift = await Shift.findById(req.params.id);
        if (!shift) throw notFound("Shift not found");

        await shift.deleteOne();
        return res.json({ message: "Shift deleted" });
    } catch (err) {
        next(err);
    }
});

export default router;
