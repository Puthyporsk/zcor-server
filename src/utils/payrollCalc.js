/**
 * Payroll calculation engine.
 *
 * Pulls approved time entries and approved paid leave for a date range,
 * computes gross pay, deductions (taxes + benefits), and net pay.
 */

// --- Federal tax brackets 2024 (simplified) ---
const FEDERAL_BRACKETS = {
    single: [
        { min: 0,      max: 11600,  rate: 0.10 },
        { min: 11600,  max: 47150,  rate: 0.12 },
        { min: 47150,  max: 100525, rate: 0.22 },
        { min: 100525, max: 191950, rate: 0.24 },
        { min: 191950, max: 243725, rate: 0.32 },
        { min: 243725, max: 609350, rate: 0.35 },
        { min: 609350, max: Infinity, rate: 0.37 },
    ],
    married: [
        { min: 0,      max: 23200,  rate: 0.10 },
        { min: 23200,  max: 94300,  rate: 0.12 },
        { min: 94300,  max: 201050, rate: 0.22 },
        { min: 201050, max: 383900, rate: 0.24 },
        { min: 383900, max: 487450, rate: 0.32 },
        { min: 487450, max: 731200, rate: 0.35 },
        { min: 731200, max: Infinity, rate: 0.37 },
    ],
    head_of_household: [
        { min: 0,      max: 16550,  rate: 0.10 },
        { min: 16550,  max: 63100,  rate: 0.12 },
        { min: 63100,  max: 100500, rate: 0.22 },
        { min: 100500, max: 191950, rate: 0.24 },
        { min: 191950, max: 243700, rate: 0.32 },
        { min: 243700, max: 609350, rate: 0.35 },
        { min: 609350, max: Infinity, rate: 0.37 },
    ],
};

// FICA constants
const SS_RATE = 0.062;
const SS_WAGE_CAP = 168600;
const MEDICARE_RATE = 0.0145;
const MEDICARE_ADDITIONAL_RATE = 0.009;
const MEDICARE_ADDITIONAL_THRESHOLD = 200000;

// Employer-side
const FUTA_RATE = 0.006;
const FUTA_WAGE_CAP = 7000;
const SUTA_RATE = 0.027; // default state rate (varies by state)
const SUTA_WAGE_CAP = 7000;

// Pay periods per year
const PERIODS_PER_YEAR = { biweekly: 26, monthly: 12 };

// 2024 standard deductions
const STANDARD_DEDUCTION = {
    single: 14600,
    married: 29200,
    head_of_household: 21900,
};

const OT_WEEKLY_THRESHOLD = 40;
const OT_MULTIPLIER = 1.5;

/**
 * Calculate weekly hours breakdown from daily hours array.
 * Each entry: { date: Date, hours: Number }
 * Returns { regularHours, overtimeHours }
 */
export function calcWeeklyOvertime(dailyEntries, overtimeEligible) {
    if (!overtimeEligible) {
        const total = dailyEntries.reduce((sum, e) => sum + e.hours, 0);
        return { regularHours: total, overtimeHours: 0 };
    }

    // Group by ISO week
    const weeks = {};
    for (const entry of dailyEntries) {
        const d = new Date(entry.date);
        // Get Monday-based week key
        const day = d.getDay();
        const monday = new Date(d);
        monday.setDate(d.getDate() - ((day + 6) % 7));
        const weekKey = monday.toISOString().slice(0, 10);
        if (!weeks[weekKey]) weeks[weekKey] = 0;
        weeks[weekKey] += entry.hours;
    }

    let regularHours = 0;
    let overtimeHours = 0;
    for (const weekHours of Object.values(weeks)) {
        if (weekHours > OT_WEEKLY_THRESHOLD) {
            regularHours += OT_WEEKLY_THRESHOLD;
            overtimeHours += weekHours - OT_WEEKLY_THRESHOLD;
        } else {
            regularHours += weekHours;
        }
    }

    return { regularHours, overtimeHours };
}

/**
 * Estimate annualized income from period gross for tax bracket lookup.
 */
function annualize(periodGross, frequency) {
    return periodGross * PERIODS_PER_YEAR[frequency];
}

/**
 * Calculate federal income tax for a pay period using progressive brackets.
 */
export function calcFederalTax(periodGross, frequency, filingStatus, preTaxDeductions = 0) {
    const taxablePerPeriod = Math.max(0, periodGross - preTaxDeductions);
    const status = filingStatus || "single";
    const annualTaxable = Math.max(0, annualize(taxablePerPeriod, frequency) - (STANDARD_DEDUCTION[status] || STANDARD_DEDUCTION.single));
    const brackets = FEDERAL_BRACKETS[status] || FEDERAL_BRACKETS.single;

    let annualTax = 0;
    for (const bracket of brackets) {
        if (annualTaxable <= bracket.min) break;
        const taxableInBracket = Math.min(annualTaxable, bracket.max) - bracket.min;
        annualTax += taxableInBracket * bracket.rate;
    }

    return annualTax / PERIODS_PER_YEAR[frequency];
}

/**
 * Calculate state income tax (flat rate).
 */
export function calcStateTax(periodGross, stateRate, preTaxDeductions = 0) {
    const taxable = Math.max(0, periodGross - preTaxDeductions);
    return taxable * (stateRate / 100);
}

/**
 * Calculate FICA (Social Security + Medicare) for employee side.
 * ytdGross: year-to-date gross earnings BEFORE this period.
 */
export function calcFICA(periodGross, ytdGross = 0) {
    // Social Security
    let ssTaxable = 0;
    if (ytdGross < SS_WAGE_CAP) {
        ssTaxable = Math.min(periodGross, SS_WAGE_CAP - ytdGross);
    }
    const socialSecurity = ssTaxable * SS_RATE;

    // Medicare
    let medicare = periodGross * MEDICARE_RATE;
    // Additional Medicare tax
    const totalEarnings = ytdGross + periodGross;
    if (totalEarnings > MEDICARE_ADDITIONAL_THRESHOLD) {
        const additionalBase = Math.max(0, totalEarnings - Math.max(ytdGross, MEDICARE_ADDITIONAL_THRESHOLD));
        medicare += additionalBase * MEDICARE_ADDITIONAL_RATE;
    }

    return { socialSecurity, medicare };
}

/**
 * Calculate employer-side costs.
 */
export function calcEmployerCosts(periodGross, ytdGross = 0) {
    const costs = [];

    // Employer SS match
    let ssTaxable = 0;
    if (ytdGross < SS_WAGE_CAP) {
        ssTaxable = Math.min(periodGross, SS_WAGE_CAP - ytdGross);
    }
    costs.push({ name: "Employer Social Security", amount: round(ssTaxable * SS_RATE) });

    // Employer Medicare match
    costs.push({ name: "Employer Medicare", amount: round(periodGross * MEDICARE_RATE) });

    // FUTA
    let futaTaxable = 0;
    if (ytdGross < FUTA_WAGE_CAP) {
        futaTaxable = Math.min(periodGross, FUTA_WAGE_CAP - ytdGross);
    }
    costs.push({ name: "FUTA", amount: round(futaTaxable * FUTA_RATE) });

    // SUTA
    let sutaTaxable = 0;
    if (ytdGross < SUTA_WAGE_CAP) {
        sutaTaxable = Math.min(periodGross, SUTA_WAGE_CAP - ytdGross);
    }
    costs.push({ name: "SUTA", amount: round(sutaTaxable * SUTA_RATE) });

    return costs;
}

/**
 * Calculate benefit/retirement deductions from user config.
 */
export function calcBenefitDeductions(grossPay, userDeductions = []) {
    return userDeductions.map((d) => {
        const amount = d.calcMethod === "percentage"
            ? grossPay * (d.value / 100)
            : d.value;
        return {
            name: d.name,
            type: d.type,
            calcMethod: d.calcMethod,
            rate: d.calcMethod === "percentage" ? d.value : undefined,
            amount: round(amount),
            preTax: d.preTax,
        };
    });
}

/**
 * Full payslip calculation for one employee in a pay period.
 *
 * @param {Object} employee - User document (with employeeMeta, taxInfo, payrollDeductions)
 * @param {Object} hoursData - { regularHours, overtimeHours, paidLeaveHours }
 * @param {String} frequency - "biweekly" or "monthly"
 * @param {Number} ytdGross - year-to-date gross before this period
 */
export function calculatePayslip(employee, hoursData, frequency, ytdGross = 0) {
    const meta = employee.employeeMeta || {};
    const taxInfo = employee.taxInfo || {};
    const payType = meta.payType || "hourly";

    let payRate, regularPay, overtimePay, otRate;

    if (payType === "hourly") {
        payRate = meta.hourlyRate || 0;
        otRate = payRate * OT_MULTIPLIER;
        regularPay = (hoursData.regularHours + hoursData.paidLeaveHours) * payRate;
        overtimePay = hoursData.overtimeHours * otRate;
    } else {
        // Salary: annual / periods per year
        const annualSalary = meta.salaryRate || 0;
        payRate = annualSalary / PERIODS_PER_YEAR[frequency];
        otRate = 0;
        regularPay = payRate;
        overtimePay = 0;
    }

    const grossPay = round(regularPay + overtimePay);

    // Benefit deductions
    const benefitDeductions = calcBenefitDeductions(grossPay, employee.payrollDeductions || []);
    const preTaxDeductions = benefitDeductions
        .filter((d) => d.preTax)
        .reduce((sum, d) => sum + d.amount, 0);

    // Tax deductions
    const federalTax = round(calcFederalTax(grossPay, frequency, taxInfo.federalFilingStatus, preTaxDeductions));
    const stateTax = round(calcStateTax(grossPay, taxInfo.stateWithholdingRate || 0, preTaxDeductions));
    const { socialSecurity, medicare } = calcFICA(grossPay, ytdGross);
    const additionalWithholding = taxInfo.additionalWithholding || 0;

    const taxDeductions = [
        { name: "Federal Income Tax", type: "tax", calcMethod: "percentage", amount: federalTax, preTax: false },
        { name: "State Income Tax", type: "tax", calcMethod: "percentage", rate: taxInfo.stateWithholdingRate || 0, amount: stateTax, preTax: false },
        { name: "Social Security", type: "tax", calcMethod: "percentage", rate: SS_RATE * 100, amount: round(socialSecurity), preTax: false },
        { name: "Medicare", type: "tax", calcMethod: "percentage", rate: MEDICARE_RATE * 100, amount: round(medicare), preTax: false },
    ];

    if (additionalWithholding > 0) {
        taxDeductions.push({
            name: "Additional Withholding",
            type: "tax",
            calcMethod: "flat",
            amount: additionalWithholding,
            preTax: false,
        });
    }

    const allDeductions = [...taxDeductions, ...benefitDeductions];
    const totalDeductions = round(allDeductions.reduce((sum, d) => sum + d.amount, 0));
    const netPay = round(grossPay - totalDeductions);

    // Employer costs
    const employerCosts = calcEmployerCosts(grossPay, ytdGross);
    const totalEmployerCosts = round(employerCosts.reduce((sum, c) => sum + c.amount, 0));

    return {
        payType,
        payRate: round(payRate),
        otRate: otRate ? round(otRate) : 0,
        regularHours: hoursData.regularHours,
        overtimeHours: hoursData.overtimeHours,
        paidLeaveHours: hoursData.paidLeaveHours,
        totalHours: round(hoursData.regularHours + hoursData.overtimeHours + hoursData.paidLeaveHours),
        regularPay: round(regularPay),
        overtimePay: round(overtimePay),
        grossPay,
        deductions: allDeductions,
        totalDeductions,
        netPay,
        employerCosts,
        totalEmployerCosts,
    };
}

function round(n) {
    return Math.round(n * 100) / 100;
}
