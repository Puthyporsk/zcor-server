import { Router } from "express";
import LeaveAccrualPolicy from "../models/LeaveAccrualPolicy.js";
import requireAuth from "../middleware/requireAuth.js";
import requireRole from "../middleware/requireRole.js";
import { badRequest } from "../utils/httpError.js";
import { processYearEndCarryover, calculateTerminationPayout } from "../utils/leaveAccrual.js";
import LeaveBalance from "../models/LeaveBalance.js";
import User from "../models/User.js";
import mongoose from "mongoose";

const router = Router();

/**
 * GET /api/leave-policy
 * Fetch the company-level accrual policy (any authenticated user).
 */
router.get("/", requireAuth, async (req, res, next) => {
    try {
        let policy = await LeaveAccrualPolicy.findOne({});
        if (!policy) {
            // Return defaults without persisting
            policy = new LeaveAccrualPolicy();
        }
        return res.json(policy);
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/leave-policy
 * Create or update the singleton accrual policy. Owner only.
 */
router.put("/", requireAuth, requireRole("owner"), async (req, res, next) => {
    try {
        const {
            accrualEnabled,
            tenureTiers,
            accrualCapMultiplier,
            carryoverLimits,
            waitingPeriodDays,
            availabilityMode,
            maxBorrowAheadHours,
            midYearHireProration,
        } = req.body || {};

        // Validate tenure tiers
        if (tenureTiers !== undefined) {
            if (!Array.isArray(tenureTiers) || tenureTiers.length === 0) {
                throw badRequest("tenureTiers must be a non-empty array");
            }
            for (const tier of tenureTiers) {
                if (tier.minYears === undefined || tier.vacationHours === undefined ||
                    tier.sickHours === undefined || tier.personalHours === undefined) {
                    throw badRequest("Each tier must have minYears, vacationHours, sickHours, personalHours");
                }
            }
            // Must have a tier starting at 0 years
            if (!tenureTiers.some((t) => t.minYears === 0)) {
                throw badRequest("Must include a tier with minYears: 0");
            }
        }

        // Validate availabilityMode
        if (availabilityMode !== undefined) {
            const VALID_MODES = ["front_loaded", "accrual_only", "hybrid"];
            if (!VALID_MODES.includes(availabilityMode)) {
                throw badRequest(`availabilityMode must be one of: ${VALID_MODES.join(", ")}`);
            }
        }

        // Validate maxBorrowAheadHours
        if (maxBorrowAheadHours !== undefined) {
            for (const t of ["vacation", "sick", "personal"]) {
                if (maxBorrowAheadHours[t] !== undefined && (typeof maxBorrowAheadHours[t] !== "number" || maxBorrowAheadHours[t] < 0)) {
                    throw badRequest(`maxBorrowAheadHours.${t} must be a non-negative number`);
                }
            }
        }

        const update = {};
        if (accrualEnabled !== undefined) update.accrualEnabled = accrualEnabled;
        if (tenureTiers !== undefined)     update.tenureTiers = tenureTiers;
        if (accrualCapMultiplier !== undefined) update.accrualCapMultiplier = accrualCapMultiplier;
        if (carryoverLimits !== undefined)      update.carryoverLimits = carryoverLimits;
        if (waitingPeriodDays !== undefined)    update.waitingPeriodDays = waitingPeriodDays;
        if (availabilityMode !== undefined)     update.availabilityMode = availabilityMode;
        if (maxBorrowAheadHours !== undefined)  update.maxBorrowAheadHours = maxBorrowAheadHours;
        if (midYearHireProration !== undefined) update.midYearHireProration = midYearHireProration;

        const policy = await LeaveAccrualPolicy.findOneAndUpdate(
            {},
            { $set: update },
            { upsert: true, new: true, runValidators: true }
        );

        return res.json(policy);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/leave-policy/carryover
 * Process year-end carryover. Owner only.
 * Body: { fromYear }
 */
router.post("/carryover", requireAuth, requireRole("owner"), async (req, res, next) => {
    try {
        const { fromYear } = req.body || {};
        if (!fromYear) throw badRequest("fromYear is required");
        const year = parseInt(fromYear, 10);
        if (isNaN(year)) throw badRequest("fromYear must be a number");

        const result = await processYearEndCarryover(year);
        return res.json(result);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/leave-policy/accrual-summary
 * Get accrual summary for an employee. Manager/owner only.
 * Query: ?employeeId=&year=
 */
router.get("/accrual-summary", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        const { employeeId, year } = req.query;
        if (!employeeId) throw badRequest("employeeId is required");
        if (!mongoose.isValidObjectId(employeeId)) throw badRequest("Invalid employeeId");

        const y = parseInt(year || new Date().getFullYear(), 10);

        const balances = await LeaveBalance.find({ employee: employeeId, year: y });
        const employee = await User.findById(employeeId);
        const policy = await LeaveAccrualPolicy.findOne({});

        const summary = {};
        for (const bal of balances) {
            summary[bal.type] = {
                allocated: bal.allocated,
                used: bal.used,
                pending: bal.pending,
                remaining: bal.allocated - bal.used - bal.pending,
                carriedOver: bal.carriedOver || 0,
                accrualLog: bal.accrualLog || [],
            };
        }

        return res.json({
            employee: employee
                ? { id: employee._id, name: `${employee.firstName} ${employee.lastName}` }
                : null,
            year: y,
            accrualEnabled: policy?.accrualEnabled || false,
            balances: summary,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/leave-policy/termination-payout/:employeeId
 * Calculate what would be owed if the employee were terminated today. Owner only.
 */
router.get(
    "/termination-payout/:employeeId",
    requireAuth,
    requireRole("owner"),
    async (req, res, next) => {
        try {
            const { employeeId } = req.params;
            if (!mongoose.isValidObjectId(employeeId)) throw badRequest("Invalid employeeId");

            const employee = await User.findById(employeeId);
            if (!employee) throw badRequest("Employee not found");

            const year = new Date().getFullYear();
            const balDocs = await LeaveBalance.find({ employee: employeeId, year });
            const balMap = {};
            for (const b of balDocs) balMap[b.type] = { allocated: b.allocated, used: b.used };

            const payout = calculateTerminationPayout(employee, balMap);

            return res.json({
                employee: { id: employee._id, name: `${employee.firstName} ${employee.lastName}` },
                year,
                ...payout,
            });
        } catch (err) {
            next(err);
        }
    }
);

export default router;
