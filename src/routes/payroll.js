import { Router } from "express";
import mongoose from "mongoose";
import PayPeriod from "../models/PayPeriod.js";
import Payslip from "../models/Payslip.js";
import User from "../models/User.js";
import TimeEntry from "../models/TimeEntry.js";
import LeaveRequest from "../models/LeaveRequest.js";
import requireAuth from "../middleware/requireAuth.js";
import requireRole from "../middleware/requireRole.js";
import { badRequest, forbidden, notFound, conflict } from "../utils/httpError.js";
import Notification from "../models/Notification.js";
import { notifyUser, notifyManagers } from "../utils/notify.js";
import { calcWeeklyOvertime, calculatePayslip } from "../utils/payrollCalc.js";
import { accrueLeaveForPayPeriod } from "../utils/leaveAccrual.js";
import LeaveBalance from "../models/LeaveBalance.js";

const router = Router();

// ─── Helpers ──────────────────────────────────────────────

function payPeriodResponse(pp) {
    return {
        id: pp._id,
        startDate: pp.startDate,
        endDate: pp.endDate,
        frequency: pp.frequency,
        status: pp.status,
        createdBy: pp.createdBy,
        approvedBy: pp.approvedBy,
        approvedAt: pp.approvedAt,
        paidAt: pp.paidAt,
        createdAt: pp.createdAt,
        updatedAt: pp.updatedAt,
    };
}

function payslipResponse(ps) {
    return {
        id: ps._id,
        employee: ps.employee,
        payPeriod: ps.payPeriod,
        regularHours: ps.regularHours,
        overtimeHours: ps.overtimeHours,
        paidLeaveHours: ps.paidLeaveHours,
        totalHours: ps.totalHours,
        payType: ps.payType,
        payRate: ps.payRate,
        otRate: ps.otRate,
        regularPay: ps.regularPay,
        overtimePay: ps.overtimePay,
        grossPay: ps.grossPay,
        deductions: ps.deductions,
        totalDeductions: ps.totalDeductions,
        netPay: ps.netPay,
        employerCosts: ps.employerCosts,
        totalEmployerCosts: ps.totalEmployerCosts,
        payment: ps.payment,
        adjustments: ps.adjustments,
        createdAt: ps.createdAt,
        updatedAt: ps.updatedAt,
    };
}

/**
 * Get approved time entry hours grouped by date for an employee in a date range.
 */
async function getApprovedHours(employeeId, startDate, endDate) {
    const entries = await TimeEntry.find({
        user: employeeId,
        status: "approved",
        date: { $gte: startDate, $lte: endDate },
    });

    return entries.map((e) => ({ date: e.date, hours: e.hours }));
}

/**
 * Get approved paid leave hours for an employee in a date range.
 */
async function getPaidLeaveHours(employeeId, startDate, endDate) {
    const requests = await LeaveRequest.find({
        employee: employeeId,
        status: "approved",
        type: { $in: ["vacation", "sick"] },
        startDate: { $lte: endDate },
        endDate: { $gte: startDate },
    });

    return requests.reduce((sum, r) => sum + (r.totalHours || 0), 0);
}

/**
 * Calculate year-to-date gross for an employee (for FICA caps).
 */
async function getYtdGross(employeeId, beforeDate) {
    const yearStart = new Date(beforeDate.getFullYear(), 0, 1);
    const priorSlips = await Payslip.find({
        employee: employeeId,
        createdAt: { $gte: yearStart, $lt: beforeDate },
    });
    return priorSlips.reduce((sum, s) => sum + (s.grossPay || 0), 0);
}

// ─── PAY PERIODS ──────────────────────────────────────────

/**
 * GET /api/payroll/pay-periods
 * List all pay periods. Managers/owners only.
 * Query: ?status=, ?frequency=
 */
router.get(
    "/pay-periods",
    requireAuth,
    requireRole("owner", "manager"),
    async (req, res, next) => {
        try {
            const { status, frequency } = req.query;
            const filter = {};
            if (status) filter.status = status;
            if (frequency) filter.frequency = frequency;

            const periods = await PayPeriod.find(filter)
                .populate("createdBy", "firstName lastName")
                .populate("approvedBy", "firstName lastName")
                .sort({ startDate: -1 });

            return res.json(periods.map(payPeriodResponse));
        } catch (err) {
            next(err);
        }
    }
);

/**
 * POST /api/payroll/pay-periods
 * Create a new pay period and auto-generate payslips.
 * Body: { startDate, endDate, frequency }
 */
router.post(
    "/pay-periods",
    requireAuth,
    requireRole("owner", "manager"),
    async (req, res, next) => {
        try {
            const { startDate, endDate, frequency } = req.body || {};

            if (!startDate) throw badRequest("startDate is required");
            if (!endDate) throw badRequest("endDate is required");
            if (!frequency) throw badRequest("frequency is required");
            if (!["biweekly", "monthly"].includes(frequency)) {
                throw badRequest("frequency must be biweekly or monthly");
            }

            const start = new Date(startDate);
            const end = new Date(endDate);
            if (end <= start) throw badRequest("endDate must be after startDate");

            // Check for overlapping pay periods with the same frequency
            const overlap = await PayPeriod.findOne({
                frequency,
                startDate: { $lte: end },
                endDate: { $gte: start },
            });
            if (overlap) throw conflict("A pay period with this frequency already overlaps these dates");

            const payPeriod = await PayPeriod.create({
                startDate: start,
                endDate: end,
                frequency,
                createdBy: req.user._id,
            });

            // Find all active employees with matching pay frequency
            const employees = await User.find({
                status: "active",
                "employeeMeta.payFrequency": frequency,
            }).select("+employeeMeta +taxInfo +payrollDeductions");

            // Generate payslips
            const payslips = [];
            for (const emp of employees) {
                const dailyHours = await getApprovedHours(emp._id, start, end);
                const paidLeaveHours = await getPaidLeaveHours(emp._id, start, end);

                const overtimeEligible = emp.employeeMeta?.overtimeEligible !== false;
                const { regularHours, overtimeHours } = calcWeeklyOvertime(dailyHours, overtimeEligible);

                const ytdGross = await getYtdGross(emp._id, start);

                const calc = calculatePayslip(
                    emp,
                    { regularHours, overtimeHours, paidLeaveHours },
                    frequency,
                    ytdGross
                );

                payslips.push({
                    employee: emp._id,
                    payPeriod: payPeriod._id,
                    ...calc,
                });
            }

            if (payslips.length > 0) {
                await Payslip.insertMany(payslips);
            }

            await payPeriod.populate("createdBy", "firstName lastName");

            return res.status(201).json({
                payPeriod: payPeriodResponse(payPeriod),
                payslipCount: payslips.length,
            });
        } catch (err) {
            next(err);
        }
    }
);

/**
 * GET /api/payroll/pay-periods/:id
 * Get a pay period with its payslips. Managers/owners only.
 */
router.get(
    "/pay-periods/:id",
    requireAuth,
    requireRole("owner", "manager"),
    async (req, res, next) => {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Pay period not found");

            const period = await PayPeriod.findById(req.params.id)
                .populate("createdBy", "firstName lastName")
                .populate("approvedBy", "firstName lastName");
            if (!period) throw notFound("Pay period not found");

            const payslips = await Payslip.find({ payPeriod: period._id })
                .populate("employee", "firstName lastName userId employeeMeta")
                .sort({ "employee.lastName": 1 });

            // Attach leave accrual info for each payslip
            const year = new Date(period.endDate).getFullYear();
            const employeeIds = payslips.map((ps) => ps.employee?._id).filter(Boolean);
            const leaveBalances = await LeaveBalance.find({
                employee: { $in: employeeIds },
                year,
            });

            // Build a map: employeeId -> { vacation: {...}, sick: {...}, personal: {...} }
            const accrualMap = {};
            for (const bal of leaveBalances) {
                const empId = bal.employee.toString();
                if (!accrualMap[empId]) accrualMap[empId] = {};
                const logEntry = (bal.accrualLog || []).find(
                    (l) => l.payPeriod?.toString() === period._id.toString()
                );
                accrualMap[empId][bal.type] = {
                    accrued: logEntry?.hoursAccrued ?? 0,
                    note: logEntry?.note || null,
                    allocated: bal.allocated,
                    used: bal.used,
                    pending: bal.pending,
                    remaining: Math.max(0, bal.allocated - bal.used - bal.pending),
                };
            }

            const payslipsWithAccrual = payslips.map((ps) => ({
                ...payslipResponse(ps),
                leaveAccrual: accrualMap[ps.employee?._id?.toString()] || null,
            }));

            return res.json({
                payPeriod: payPeriodResponse(period),
                payslips: payslipsWithAccrual,
            });
        } catch (err) {
            next(err);
        }
    }
);

/**
 * PATCH /api/payroll/pay-periods/:id
 * Update pay period status.
 * Body: { action: "review" | "approve" | "pay" }
 *
 * Transitions: draft → reviewed → approved → paid
 * Only owners can approve/pay.
 */
router.patch(
    "/pay-periods/:id",
    requireAuth,
    requireRole("owner", "manager"),
    async (req, res, next) => {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Pay period not found");

            const period = await PayPeriod.findById(req.params.id);
            if (!period) throw notFound("Pay period not found");

            const { action } = req.body || {};

            if (action === "review") {
                if (period.status !== "draft") throw badRequest("Can only review a draft pay period");
                period.status = "reviewed";
            } else if (action === "approve") {
                if (req.user.role !== "owner") throw forbidden("Only owners can approve pay periods");
                if (period.status !== "reviewed") throw badRequest("Can only approve a reviewed pay period");
                period.status = "approved";
                period.approvedBy = req.user._id;
                period.approvedAt = new Date();
            } else if (action === "pay") {
                if (req.user.role !== "owner") throw forbidden("Only owners can mark pay periods as paid");
                if (period.status !== "approved") throw badRequest("Can only pay an approved pay period");
                period.status = "paid";
                period.paidAt = new Date();

                // Mark all payslips as paid
                await Payslip.updateMany(
                    { payPeriod: period._id },
                    {
                        "payment.status": "paid",
                        "payment.method": "manual",
                        "payment.processedAt": new Date(),
                    }
                );

                // Accrue leave hours for employees in this pay period
                await accrueLeaveForPayPeriod(period);
            } else {
                throw badRequest("action must be one of: review, approve, pay");
            }

            await period.save();
            await period.populate("createdBy", "firstName lastName");
            await period.populate("approvedBy", "firstName lastName");

            // Notify managers/owners about status change
            const actorName = `${req.user.firstName} ${req.user.lastName}`.trim();
            const periodLabel = `${new Date(period.startDate).toLocaleDateString("en-US")} – ${new Date(period.endDate).toLocaleDateString("en-US")}`;
            notifyManagers({
                type: "pay_period_status_change",
                title: "Pay Period Updated",
                message: `${actorName} moved pay period ${periodLabel} to "${period.status}".`,
                relatedEntity: { kind: "PayPeriod", item: period._id },
                excludeUserId: req.user._id,
            });

            // Notify employees when payslips become visible (approved or paid)
            if (action === "approve" || action === "pay") {
                const payslips = await Payslip.find({ payPeriod: period._id }).select("employee");
                for (const ps of payslips) {
                    notifyUser({
                        recipient: ps.employee,
                        type: "payslip_available",
                        title: action === "pay" ? "Payslip Paid" : "Payslip Available",
                        message: `Your payslip for ${periodLabel} is now ${action === "pay" ? "marked as paid" : "available to view"}.`,
                        relatedEntity: { kind: "Payslip", item: ps._id },
                    });
                }
            }

            return res.json(payPeriodResponse(period));
        } catch (err) {
            next(err);
        }
    }
);

/**
 * DELETE /api/payroll/pay-periods/:id
 * Delete a draft pay period and its payslips. Owners only.
 */
router.delete(
    "/pay-periods/:id",
    requireAuth,
    requireRole("owner"),
    async (req, res, next) => {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Pay period not found");

            const period = await PayPeriod.findById(req.params.id);
            if (!period) throw notFound("Pay period not found");
            if (period.status !== "draft") throw badRequest("Can only delete draft pay periods");

            await Payslip.deleteMany({ payPeriod: period._id });
            await period.deleteOne();

            return res.json({ message: "Pay period and payslips deleted" });
        } catch (err) {
            next(err);
        }
    }
);

// ─── PAYSLIPS ─────────────────────────────────────────────

/**
 * GET /api/payroll/payslips/me
 * Employee views their own payslip history.
 * Query: ?payPeriodId=
 */
router.get("/payslips/me", requireAuth, async (req, res, next) => {
    try {
        const filter = { employee: req.user._id };
        if (req.query.payPeriodId) {
            if (!mongoose.isValidObjectId(req.query.payPeriodId)) throw badRequest("Invalid payPeriodId");
            filter.payPeriod = req.query.payPeriodId;
        }

        // Employees can only see payslips from approved/paid periods
        const visiblePeriods = await PayPeriod.find({
            status: { $in: ["approved", "paid"] },
        }).select("_id");
        const periodIds = visiblePeriods.map((p) => p._id);
        filter.payPeriod = filter.payPeriod
            ? { $in: [filter.payPeriod].filter((id) => periodIds.some((p) => p.equals(id))) }
            : { $in: periodIds };

        const payslips = await Payslip.find(filter)
            .populate("payPeriod", "startDate endDate frequency status")
            .sort({ createdAt: -1 });

        return res.json(payslips.map(payslipResponse));
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/payroll/payslips/:id
 * View a single payslip.
 * Employees can only view their own (from approved/paid periods).
 * Managers/owners can view any.
 */
router.get("/payslips/:id", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Payslip not found");

        const payslip = await Payslip.findById(req.params.id)
            .populate("employee", "firstName lastName userId employeeMeta")
            .populate("payPeriod", "startDate endDate frequency status");
        if (!payslip) throw notFound("Payslip not found");

        const isPrivileged = ["owner", "manager"].includes(req.user.role);
        if (!isPrivileged) {
            if (!payslip.employee._id.equals(req.user._id)) {
                throw forbidden("You can only view your own payslips");
            }
            if (!["approved", "paid"].includes(payslip.payPeriod?.status)) {
                throw notFound("Payslip not found");
            }
        }

        // Attach leave accrual info
        const year = new Date(payslip.payPeriod.endDate).getFullYear();
        const empBalances = await LeaveBalance.find({
            employee: payslip.employee._id,
            year,
        });
        const leaveAccrual = {};
        for (const bal of empBalances) {
            const logEntry = (bal.accrualLog || []).find(
                (l) => l.payPeriod?.toString() === payslip.payPeriod._id.toString()
            );
            leaveAccrual[bal.type] = {
                accrued: logEntry?.hoursAccrued ?? 0,
                note: logEntry?.note || null,
                allocated: bal.allocated,
                used: bal.used,
                pending: bal.pending,
                remaining: Math.max(0, bal.allocated - bal.used - bal.pending),
            };
        }

        return res.json({ ...payslipResponse(payslip), leaveAccrual });
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/payroll/payslips/:id
 * Manager adjusts payslip line items (only when pay period is draft or reviewed).
 * Body: { regularHours?, overtimeHours?, paidLeaveHours?, note? }
 *
 * Recalculates pay based on adjusted hours.
 */
router.patch(
    "/payslips/:id",
    requireAuth,
    requireRole("owner", "manager"),
    async (req, res, next) => {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Payslip not found");

            const payslip = await Payslip.findById(req.params.id).populate("payPeriod");
            if (!payslip) throw notFound("Payslip not found");

            if (!["draft", "reviewed"].includes(payslip.payPeriod?.status)) {
                throw badRequest("Can only adjust payslips in draft or reviewed pay periods");
            }

            const employee = await User.findById(payslip.employee);
            if (!employee) throw notFound("Employee not found");

            const { regularHours, overtimeHours, paidLeaveHours, note } = req.body || {};

            const hours = {
                regularHours: regularHours !== undefined ? Number(regularHours) : payslip.regularHours,
                overtimeHours: overtimeHours !== undefined ? Number(overtimeHours) : payslip.overtimeHours,
                paidLeaveHours: paidLeaveHours !== undefined ? Number(paidLeaveHours) : payslip.paidLeaveHours,
            };

            const ytdGross = await getYtdGross(employee._id, payslip.payPeriod.startDate);
            const calc = calculatePayslip(employee, hours, payslip.payPeriod.frequency, ytdGross);

            Object.assign(payslip, calc);
            payslip.adjustments = {
                note: note || payslip.adjustments?.note,
                adjustedBy: req.user._id,
                adjustedAt: new Date(),
            };

            await payslip.save();
            await payslip.populate("employee", "firstName lastName userId employeeMeta");

            return res.json(payslipResponse(payslip));
        } catch (err) {
            next(err);
        }
    }
);

/**
 * POST /api/payroll/pay-periods/:id/recalculate
 * Recalculate all payslips for a draft/reviewed pay period.
 * Useful after time entries are updated.
 */
router.post(
    "/pay-periods/:id/recalculate",
    requireAuth,
    requireRole("owner", "manager"),
    async (req, res, next) => {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Pay period not found");

            const period = await PayPeriod.findById(req.params.id);
            if (!period) throw notFound("Pay period not found");
            if (!["draft", "reviewed"].includes(period.status)) {
                throw badRequest("Can only recalculate draft or reviewed pay periods");
            }

            // Recalculate existing payslips
            const payslips = await Payslip.find({ payPeriod: period._id });
            const existingEmployeeIds = new Set(payslips.map((ps) => ps.employee.toString()));

            for (const payslip of payslips) {
                const employee = await User.findById(payslip.employee);
                if (!employee) continue;

                const dailyHours = await getApprovedHours(employee._id, period.startDate, period.endDate);
                const paidLeaveHours = await getPaidLeaveHours(employee._id, period.startDate, period.endDate);
                const overtimeEligible = employee.employeeMeta?.overtimeEligible !== false;
                const { regularHours, overtimeHours } = calcWeeklyOvertime(dailyHours, overtimeEligible);

                const ytdGross = await getYtdGross(employee._id, period.startDate);
                const calc = calculatePayslip(
                    employee,
                    { regularHours, overtimeHours, paidLeaveHours },
                    period.frequency,
                    ytdGross
                );

                Object.assign(payslip, calc);
                await payslip.save();
            }

            // Generate payslips for matching employees who don't have one yet
            const allEmployees = await User.find({
                status: "active",
                "employeeMeta.payFrequency": period.frequency,
            });
            const newPayslips = [];
            for (const emp of allEmployees) {
                if (existingEmployeeIds.has(emp._id.toString())) continue;

                const dailyHours = await getApprovedHours(emp._id, period.startDate, period.endDate);
                const paidLeaveHours = await getPaidLeaveHours(emp._id, period.startDate, period.endDate);
                const overtimeEligible = emp.employeeMeta?.overtimeEligible !== false;
                const { regularHours, overtimeHours } = calcWeeklyOvertime(dailyHours, overtimeEligible);
                const ytdGross = await getYtdGross(emp._id, period.startDate);
                const calc = calculatePayslip(
                    emp,
                    { regularHours, overtimeHours, paidLeaveHours },
                    period.frequency,
                    ytdGross
                );
                newPayslips.push({ employee: emp._id, payPeriod: period._id, ...calc });
            }
            if (newPayslips.length > 0) {
                await Payslip.insertMany(newPayslips);
            }

            return res.json({ message: "Payslips recalculated", count: payslips.length + newPayslips.length });
        } catch (err) {
            next(err);
        }
    }
);

export default router;
