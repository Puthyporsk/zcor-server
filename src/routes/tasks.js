import { Router } from "express";
import mongoose from "mongoose";
import Task from "../models/Task.js";
import requireAuth from "../middleware/requireAuth.js";
import requireRole from "../middleware/requireRole.js";
import { badRequest, notFound } from "../utils/httpError.js";

const router = Router();

function taskResponse(task) {
    return {
        id:          task._id,
        name:        task.name,
        description: task.description || "",
        isActive:    task.isActive,
        createdBy:   task.createdBy,
        createdAt:   task.createdAt,
        updatedAt:   task.updatedAt,
    };
}

/**
 * GET /api/tasks
 * List all active tasks. All authenticated users.
 */
router.get("/", requireAuth, async (req, res, next) => {
    try {
        const tasks = await Task.find({ isActive: true }).sort({ name: 1 });
        return res.json(tasks.map(taskResponse));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/tasks
 * Create a new task. Managers/owners only.
 * Body: { name, description? }
 */
router.post("/", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        const { name, description } = req.body || {};
        if (!name) throw badRequest("name is required");

        const task = await Task.create({
            name:        String(name).trim(),
            description: description ? String(description).trim() : undefined,
            createdBy:   req.user._id,
        });

        return res.status(201).json(taskResponse(task));
    } catch (err) {
        if (err.code === 11000) return next(badRequest("A task with that name already exists"));
        next(err);
    }
});

/**
 * PATCH /api/tasks/:id
 * Update a task name/description. Managers/owners only.
 * Body: { name?, description? }
 */
router.patch("/:id", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Task not found");

        const task = await Task.findById(req.params.id);
        if (!task) throw notFound("Task not found");

        const { name, description } = req.body || {};
        if (name        !== undefined) task.name        = String(name).trim();
        if (description !== undefined) task.description = String(description).trim();

        await task.save();
        return res.json(taskResponse(task));
    } catch (err) {
        if (err.code === 11000) return next(badRequest("A task with that name already exists"));
        next(err);
    }
});

/**
 * DELETE /api/tasks/:id
 * Soft-delete a task (sets isActive: false). Managers/owners only.
 */
router.delete("/:id", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Task not found");

        const task = await Task.findById(req.params.id);
        if (!task) throw notFound("Task not found");

        task.isActive = false;
        await task.save();

        return res.json({ message: "Task deactivated" });
    } catch (err) {
        next(err);
    }
});

export default router;
