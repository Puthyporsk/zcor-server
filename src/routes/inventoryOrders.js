import { Router } from "express";
import mongoose from "mongoose";
import InventoryOrder from "../models/InventoryOrder.js";
import InventoryItem from "../models/InventoryItem.js";
import requireAuth from "../middleware/requireAuth.js";
import requireRole from "../middleware/requireRole.js";
import { badRequest, notFound } from "../utils/httpError.js";

const router = Router();

function orderResponse(order) {
    const items = order.items.map((li) => ({
        id:            li._id,
        inventoryItem: li.inventoryItem,
        quantity:      li.quantity,
        unitPrice:     li.unitPrice,
        itemName:      li.itemName || "",
        lineTotal:     li.quantity * li.unitPrice,
    }));
    const total = items.reduce((sum, li) => sum + li.lineTotal, 0);
    return {
        id:          order._id,
        orderType:   order.orderType,
        orderDate:   order.orderDate,
        vendor:      order.vendor || "",
        relatedUser: order.relatedUser || null,
        notes:       order.notes || "",
        createdBy:   order.createdBy,
        createdAt:   order.createdAt,
        items,
        total,
    };
}

/**
 * GET /api/inventory-orders
 * List orders. Query: ?orderType=, ?startDate=, ?endDate=, ?relatedUser=
 */
router.get("/", requireAuth, async (req, res, next) => {
    try {
        const { orderType, startDate, endDate, relatedUser } = req.query;
        const filter = {};

        if (orderType) {
            if (!["purchase", "sale", "usage"].includes(orderType)) throw badRequest("Invalid orderType");
            filter.orderType = orderType;
        }
        if (startDate || endDate) {
            filter.orderDate = {};
            if (startDate) filter.orderDate.$gte = new Date(startDate);
            if (endDate)   filter.orderDate.$lte = new Date(endDate);
        }
        if (relatedUser) {
            if (!mongoose.isValidObjectId(relatedUser)) throw badRequest("Invalid relatedUser");
            filter.relatedUser = relatedUser;
        }

        const orders = await InventoryOrder.find(filter)
            .populate("relatedUser", "firstName lastName userId")
            .populate("createdBy", "firstName lastName")
            .populate("items.inventoryItem", "name unit")
            .sort({ orderDate: -1 });

        return res.json(orders.map(orderResponse));
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/inventory-orders/by-item/:itemId
 * Order history for a specific inventory item.
 */
router.get("/by-item/:itemId", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.itemId)) throw notFound("Item not found");

        const orders = await InventoryOrder.find({ "items.inventoryItem": req.params.itemId })
            .populate("relatedUser", "firstName lastName userId")
            .populate("createdBy", "firstName lastName")
            .populate("items.inventoryItem", "name unit")
            .sort({ orderDate: -1 });

        return res.json(orders.map(orderResponse));
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/inventory-orders/:id
 * Get single order.
 */
router.get("/:id", requireAuth, async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Order not found");

        const order = await InventoryOrder.findById(req.params.id)
            .populate("relatedUser", "firstName lastName userId")
            .populate("createdBy", "firstName lastName")
            .populate("items.inventoryItem", "name unit");

        if (!order) throw notFound("Order not found");
        return res.json(orderResponse(order));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/inventory-orders
 * Create order + adjust inventory quantities. Managers/owners only.
 */
router.post("/", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        const { orderType, orderDate, vendor, relatedUser, items, notes } = req.body || {};

        if (!orderType || !["purchase", "sale", "usage"].includes(orderType)) {
            throw badRequest("orderType must be purchase, sale, or usage");
        }
        if (orderType === "purchase" && (!vendor || !String(vendor).trim())) {
            throw badRequest("vendor is required for purchase orders");
        }
        if (orderType === "sale" && !relatedUser) {
            throw badRequest("relatedUser is required for sale orders");
        }
        if (!Array.isArray(items) || items.length === 0) {
            throw badRequest("At least one item is required");
        }

        // Validate and build line items, snapshot itemName
        const lineItems = [];
        for (const li of items) {
            if (!li.inventoryItem || !mongoose.isValidObjectId(li.inventoryItem)) {
                throw badRequest("Each item must have a valid inventoryItem id");
            }
            const qty = Number(li.quantity);
            if (!qty || qty < 1) throw badRequest("Each item quantity must be >= 1");

            const invItem = await InventoryItem.findById(li.inventoryItem);
            if (!invItem || !invItem.isActive) throw badRequest(`Inventory item not found: ${li.inventoryItem}`);
            if (invItem.type !== "supply") throw badRequest(`Only supply items can be ordered: ${invItem.name}`);

            // For sale/usage, check sufficient stock
            if ((orderType === "sale" || orderType === "usage") && invItem.quantity < qty) {
                throw badRequest(`Insufficient stock for "${invItem.name}": have ${invItem.quantity}, need ${qty}`);
            }

            lineItems.push({
                inventoryItem: invItem._id,
                quantity:      qty,
                unitPrice:     li.unitPrice != null ? Math.max(0, Number(li.unitPrice)) : 0,
                itemName:      invItem.name,
            });
        }

        // Apply quantity adjustments
        for (const li of lineItems) {
            const delta = orderType === "purchase" ? li.quantity : -li.quantity;
            await InventoryItem.findByIdAndUpdate(li.inventoryItem, { $inc: { quantity: delta } });
        }

        // Create order document
        const order = await InventoryOrder.create({
            orderType,
            orderDate:   orderDate ? new Date(orderDate) : new Date(),
            vendor:      vendor ? String(vendor).trim() : undefined,
            relatedUser: relatedUser || null,
            items:       lineItems,
            notes:       notes ? String(notes).trim() : undefined,
            createdBy:   req.user._id,
        });

        await order.populate("relatedUser", "firstName lastName userId");
        await order.populate("createdBy", "firstName lastName");
        await order.populate("items.inventoryItem", "name unit");

        return res.status(201).json(orderResponse(order));
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/inventory-orders/:id
 * Void order + reverse quantity adjustments. Managers/owners only.
 */
router.delete("/:id", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Order not found");

        const order = await InventoryOrder.findById(req.params.id);
        if (!order) throw notFound("Order not found");

        // Reverse adjustments
        for (const li of order.items) {
            const delta = order.orderType === "purchase" ? -li.quantity : li.quantity;

            if (order.orderType === "purchase") {
                // Ensure reversal won't push below 0
                const invItem = await InventoryItem.findById(li.inventoryItem);
                if (invItem && invItem.quantity < li.quantity) {
                    throw badRequest(`Cannot void: "${li.itemName}" current stock (${invItem.quantity}) is less than order quantity (${li.quantity})`);
                }
            }

            await InventoryItem.findByIdAndUpdate(li.inventoryItem, { $inc: { quantity: delta } });
        }

        await InventoryOrder.findByIdAndDelete(req.params.id);
        return res.json({ message: "Order voided" });
    } catch (err) {
        next(err);
    }
});

export default router;
