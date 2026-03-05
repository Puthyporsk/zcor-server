import { Router } from "express";
import mongoose from "mongoose";
import InventoryItem from "../models/InventoryItem.js";
import requireAuth from "../middleware/requireAuth.js";
import requireRole from "../middleware/requireRole.js";
import { badRequest, notFound } from "../utils/httpError.js";

const router = Router();

function itemResponse(item) {
    return {
        id:               item._id,
        name:             item.name,
        type:             item.type,
        category:         item.category || "",
        description:      item.description || "",
        isActive:         item.isActive,
        // equipment
        serialNumber:     item.serialNumber || "",
        condition:        item.condition || "good",
        assignedTo:       item.assignedTo || null,
        assignedAt:       item.assignedAt || null,
        purchaseDate:     item.purchaseDate || null,
        purchaseCost:     item.purchaseCost ?? null,
        // supply
        quantity:          item.quantity ?? 0,
        unit:             item.unit || "units",
        lowStockThreshold: item.lowStockThreshold ?? 0,
        createdBy:        item.createdBy,
        createdAt:        item.createdAt,
        updatedAt:        item.updatedAt,
    };
}

/**
 * GET /api/inventory
 * List active items. Query: ?type=, ?category=
 */
router.get("/", requireAuth, async (req, res, next) => {
    try {
        const { type, category } = req.query;
        const filter = { isActive: true };

        if (type) {
            if (!["equipment", "supply"].includes(type)) throw badRequest("Invalid type filter");
            filter.type = type;
        }
        if (category) {
            filter.category = category;
        }

        const items = await InventoryItem.find(filter)
            .populate("assignedTo", "firstName lastName userId")
            .populate("createdBy", "firstName lastName")
            .sort({ type: 1, name: 1 });

        return res.json(items.map(itemResponse));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/inventory
 * Create item. Managers/owners only.
 */
router.post("/", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        const { name, type, category, description,
                serialNumber, condition, purchaseDate, purchaseCost,
                quantity, unit, lowStockThreshold } = req.body || {};

        if (!name || !String(name).trim()) throw badRequest("name is required");
        if (!type) throw badRequest("type is required");
        if (!["equipment", "supply"].includes(type)) throw badRequest("type must be 'equipment' or 'supply'");

        const item = await InventoryItem.create({
            name: String(name).trim(),
            type,
            category: category ? String(category).trim() : undefined,
            description: description ? String(description).trim() : undefined,
            createdBy: req.user._id,
            // equipment fields
            ...(type === "equipment" && {
                serialNumber: serialNumber ? String(serialNumber).trim() : undefined,
                condition: condition || "good",
                purchaseDate: purchaseDate || undefined,
                purchaseCost: purchaseCost != null ? Number(purchaseCost) : undefined,
            }),
            // supply fields
            ...(type === "supply" && {
                quantity: quantity != null ? Number(quantity) : 0,
                unit: unit ? String(unit).trim() : "units",
                lowStockThreshold: lowStockThreshold != null ? Number(lowStockThreshold) : 0,
            }),
        });

        await item.populate("createdBy", "firstName lastName");

        return res.status(201).json(itemResponse(item));
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/inventory/:id
 * Update item fields. Managers/owners only.
 */
router.patch("/:id", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Item not found");

        const item = await InventoryItem.findById(req.params.id);
        if (!item || !item.isActive) throw notFound("Item not found");

        const { name, category, description,
                serialNumber, condition, purchaseDate, purchaseCost,
                quantity, unit, lowStockThreshold } = req.body || {};

        if (name !== undefined) item.name = String(name).trim();
        if (category !== undefined) item.category = String(category).trim();
        if (description !== undefined) item.description = String(description).trim();

        if (item.type === "equipment") {
            if (serialNumber !== undefined) item.serialNumber = String(serialNumber).trim();
            if (condition !== undefined) item.condition = condition;
            if (purchaseDate !== undefined) item.purchaseDate = purchaseDate || null;
            if (purchaseCost !== undefined) item.purchaseCost = purchaseCost != null ? Number(purchaseCost) : null;
        }

        if (item.type === "supply") {
            if (quantity !== undefined) item.quantity = Number(quantity);
            if (unit !== undefined) item.unit = String(unit).trim();
            if (lowStockThreshold !== undefined) item.lowStockThreshold = Number(lowStockThreshold);
        }

        await item.save();
        await item.populate("assignedTo", "firstName lastName userId");
        await item.populate("createdBy", "firstName lastName");

        return res.json(itemResponse(item));
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/inventory/:id
 * Soft-delete (isActive=false). Managers/owners only.
 */
router.delete("/:id", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Item not found");

        const item = await InventoryItem.findById(req.params.id);
        if (!item || !item.isActive) throw notFound("Item not found");

        item.isActive = false;
        await item.save();

        return res.json({ message: "Item deleted" });
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/inventory/:id/assign
 * Assign equipment to employee. Body: { userId }
 */
router.patch("/:id/assign", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Item not found");

        const item = await InventoryItem.findById(req.params.id);
        if (!item || !item.isActive) throw notFound("Item not found");
        if (item.type !== "equipment") throw badRequest("Only equipment can be assigned");

        const { userId } = req.body || {};
        if (!userId) throw badRequest("userId is required");
        if (!mongoose.isValidObjectId(userId)) throw badRequest("Invalid userId");

        item.assignedTo = userId;
        item.assignedAt = new Date();
        await item.save();
        await item.populate("assignedTo", "firstName lastName userId");
        await item.populate("createdBy", "firstName lastName");

        return res.json(itemResponse(item));
    } catch (err) {
        next(err);
    }
});

/**
 * PATCH /api/inventory/:id/unassign
 * Unassign equipment.
 */
router.patch("/:id/unassign", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Item not found");

        const item = await InventoryItem.findById(req.params.id);
        if (!item || !item.isActive) throw notFound("Item not found");
        if (item.type !== "equipment") throw badRequest("Only equipment can be unassigned");

        item.assignedTo = null;
        item.assignedAt = null;
        await item.save();
        await item.populate("createdBy", "firstName lastName");

        return res.json(itemResponse(item));
    } catch (err) {
        next(err);
    }
});

export default router;
