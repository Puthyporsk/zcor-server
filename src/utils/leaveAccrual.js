/**
 * Leave accrual engine.
 *
 * Per-pay-period accrual with tenure tiers, caps, waiting periods,
 * carryover limits, and termination payout calculations.
 */

import LeaveAccrualPolicy from "../models/LeaveAccrualPolicy.js";
import LeaveBalance from "../models/LeaveBalance.js";
import Payslip from "../models/Payslip.js";
import User from "../models/User.js";

const PERIODS_PER_YEAR = { biweekly: 26, monthly: 12 };
const LEAVE_TYPES = ["vacation", "sick", "personal"];

const round = (n) => Math.round(n * 100) / 100;

// ─── Pure calculation helpers ────────────────────────────────────────────────

/**
 * Calculate employee tenure in full years from startDate to a reference date.
 */
export function getTenureYears(startDate, referenceDate) {
    if (!startDate) return 0;
    const s = new Date(startDate);
    const r = new Date(referenceDate);
    let years = r.getFullYear() - s.getFullYear();
    const mDiff = r.getMonth() - s.getMonth();
    if (mDiff < 0 || (mDiff === 0 && r.getDate() < s.getDate())) {
        years--;
    }
    return Math.max(0, years);
}

/**
 * Determine the annual allocation for an employee based on tenure tiers.
 * Per-employee overrides take priority.
 */
export function getAnnualAllocation(employee, policy, referenceDate) {
    const tenure = getTenureYears(employee.employeeMeta?.startDate, referenceDate);
    const overrides = employee.accrualOverrides || {};

    // Sort tiers descending by minYears and find first match
    const tiers = [...(policy.tenureTiers || [])].sort((a, b) => b.minYears - a.minYears);
    const tier = tiers.find((t) => tenure >= t.minYears) || tiers[tiers.length - 1] || {
        vacationHours: 80, sickHours: 40, personalHours: 0,
    };

    return {
        vacation:  overrides.vacationHoursOverride  ?? tier.vacationHours,
        sick:      overrides.sickHoursOverride      ?? tier.sickHours,
        personal:  overrides.personalHoursOverride   ?? tier.personalHours,
    };
}

/**
 * Get the per-period accrual amount.
 */
export function getPerPeriodAccrual(annualAllocation, frequency) {
    const periods = PERIODS_PER_YEAR[frequency] || 26;
    return {
        vacation:  round(annualAllocation.vacation / periods),
        sick:      round(annualAllocation.sick / periods),
        personal:  round(annualAllocation.personal / periods),
    };
}

/**
 * Check if employee is still in the waiting period.
 */
export function isInWaitingPeriod(employee, referenceDate, policy) {
    const startDate = employee.employeeMeta?.startDate;
    if (!startDate) return true; // no start date → can't accrue
    const overrideDays = employee.accrualOverrides?.waitingPeriodDaysOverride;
    const waitDays = overrideDays ?? policy.waitingPeriodDays ?? 90;
    if (waitDays === 0) return false;
    const diffMs = new Date(referenceDate) - new Date(startDate);
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays < waitDays;
}

/**
 * Get the accrual cap for a leave type.
 */
export function getAccrualCap(annualAmount, type, employee, policy) {
    const overrideMult = employee.accrualOverrides?.accrualCapMultiplier?.[type];
    const policyMult = policy.accrualCapMultiplier?.[type] ?? 1.5;
    const mult = overrideMult ?? policyMult;
    return round(annualAmount * mult);
}

/**
 * Calculate accrual for a single employee for one pay period.
 * Returns per-type: { hours, note, capped }
 */
export function calculateAccrualForEmployee(employee, frequency, currentBalances, policy, referenceDate) {
    const annual = getAnnualAllocation(employee, policy, referenceDate);
    const perPeriod = getPerPeriodAccrual(annual, frequency);
    const waiting = isInWaitingPeriod(employee, referenceDate, policy);

    const result = {};

    for (const type of LEAVE_TYPES) {
        if (waiting) {
            result[type] = { hours: 0, note: "Waiting period", capped: false };
            continue;
        }

        const bal = currentBalances[type] || { allocated: 0, used: 0 };
        const remaining = bal.allocated - bal.used;
        const cap = getAccrualCap(annual[type], type, employee, policy);
        let accrual = perPeriod[type];

        if (annual[type] === 0) {
            result[type] = { hours: 0, note: "No allocation", capped: false };
            continue;
        }

        if (remaining + accrual > cap) {
            accrual = Math.max(0, round(cap - remaining));
            result[type] = { hours: accrual, note: accrual === 0 ? "Cap reached" : "Capped", capped: true };
        } else {
            result[type] = { hours: accrual, note: null, capped: false };
        }
    }

    return result;
}

/**
 * Calculate year-end carryover for an employee.
 * Returns per-type: { carriedOver, forfeited }
 */
export function calculateCarryover(balances, employee, policy) {
    const overrides = employee.accrualOverrides?.carryoverLimit || {};
    const result = {};

    for (const type of LEAVE_TYPES) {
        const bal = balances[type];
        if (!bal) {
            result[type] = { carriedOver: 0, forfeited: 0 };
            continue;
        }
        const unused = Math.max(0, bal.allocated - bal.used);
        const limit = overrides[type] ?? policy.carryoverLimits?.[type] ?? 0;
        const carryover = Math.min(unused, limit);
        result[type] = {
            carriedOver: round(carryover),
            forfeited: round(unused - carryover),
        };
    }

    return result;
}

/**
 * Calculate termination payout (typically only vacation is paid out).
 */
export function calculateTerminationPayout(employee, balances) {
    const hourlyRate = employee.employeeMeta?.hourlyRate || 0;
    const payType = employee.employeeMeta?.payType || "hourly";
    const salaryRate = employee.employeeMeta?.salaryRate || 0;

    // For salaried employees, derive an hourly equivalent
    const effectiveRate = payType === "hourly" ? hourlyRate : round(salaryRate / 2080);

    const vacBal = balances.vacation || { allocated: 0, used: 0 };
    const unusedVacation = Math.max(0, vacBal.allocated - vacBal.used);
    const payoutAmount = round(unusedVacation * effectiveRate);

    return {
        unusedVacationHours: round(unusedVacation),
        effectiveHourlyRate: effectiveRate,
        payoutAmount,
    };
}

// ─── Side-effect functions (DB operations) ───────────────────────────────────

/**
 * Process leave accrual for all employees when a pay period is marked "paid".
 * Called from the payroll route.
 */
export async function accrueLeaveForPayPeriod(period) {
    const policy = await LeaveAccrualPolicy.findOne({});
    if (!policy || !policy.accrualEnabled) return { accrued: 0, skipped: 0 };

    const employees = await User.find({
        status: "active",
        "employeeMeta.payFrequency": period.frequency,
    });

    let accrued = 0;
    let skipped = 0;
    const referenceDate = period.endDate;
    const year = new Date(referenceDate).getFullYear();

    // Load payslips for this period to check who actually worked
    const payslips = await Payslip.find({ payPeriod: period._id });
    const workedEmployees = new Set(
        payslips
            .filter((ps) => ps.totalHours > 0)
            .map((ps) => ps.employee.toString())
    );

    for (const emp of employees) {
        // Only accrue if employee had hours in this pay period
        if (!workedEmployees.has(emp._id.toString())) {
            skipped++;
            continue;
        }

        // Load current balances for this year
        const balDocs = await LeaveBalance.find({ employee: emp._id, year });
        const currentBalances = {};
        for (const b of balDocs) {
            // Idempotency: skip if already accrued for this pay period
            if (b.accrualLog?.some((l) => l.payPeriod?.toString() === period._id.toString())) {
                skipped++;
                currentBalances[b.type] = null; // mark as already processed
                continue;
            }
            currentBalances[b.type] = { allocated: b.allocated, used: b.used };
        }

        // If all 3 types were already processed, skip this employee
        const alreadyDone = LEAVE_TYPES.every((t) => currentBalances[t] === null);
        if (alreadyDone) continue;

        const accrualResult = calculateAccrualForEmployee(
            emp, period.frequency, currentBalances, policy, referenceDate
        );

        for (const type of LEAVE_TYPES) {
            if (currentBalances[type] === null) continue; // already accrued
            const { hours, note } = accrualResult[type];
            if (hours === 0 && !note) continue;

            const bal = await LeaveBalance.findOneAndUpdate(
                { employee: emp._id, type, year },
                {
                    $inc: { allocated: hours },
                    $push: {
                        accrualLog: {
                            payPeriod: period._id,
                            hoursAccrued: hours,
                            accrualDate: new Date(),
                            note: note || undefined,
                        },
                    },
                },
                { upsert: true, new: true }
            );

            // Fill in runningAllocated on the last log entry
            const lastLog = bal.accrualLog[bal.accrualLog.length - 1];
            if (lastLog) {
                lastLog.runningAllocated = bal.allocated;
                await bal.save();
            }
        }

        accrued++;
    }

    return { accrued, skipped };
}

/**
 * Process year-end carryover for all employees.
 * Creates new-year balance records with carriedOver amounts.
 */
export async function processYearEndCarryover(fromYear) {
    const policy = await LeaveAccrualPolicy.findOne({});
    if (!policy) return { processed: 0, results: [] };

    const employees = await User.find({ status: "active" });
    const toYear = fromYear + 1;
    const results = [];

    for (const emp of employees) {
        const balDocs = await LeaveBalance.find({ employee: emp._id, year: fromYear });
        const balMap = {};
        for (const b of balDocs) balMap[b.type] = { allocated: b.allocated, used: b.used };

        const carryover = calculateCarryover(balMap, emp, policy);

        const empResult = { employee: emp._id, name: `${emp.firstName} ${emp.lastName}`, types: {} };

        for (const type of LEAVE_TYPES) {
            const { carriedOver, forfeited } = carryover[type];
            empResult.types[type] = { carriedOver, forfeited };

            if (carriedOver > 0) {
                // Upsert the new year balance with carryover
                await LeaveBalance.findOneAndUpdate(
                    { employee: emp._id, type, year: toYear },
                    {
                        $inc: { allocated: carriedOver },
                        $set: { carriedOver },
                    },
                    { upsert: true }
                );
            }
        }

        results.push(empResult);
    }

    return { processed: results.length, results };
}
