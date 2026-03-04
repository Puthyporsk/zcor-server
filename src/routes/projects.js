import { Router } from "express";
import mongoose from "mongoose";
import Project from "../models/Project.js";
import requireAuth from "../middleware/requireAuth.js";
import requireRole from "../middleware/requireRole.js";
import { badRequest, notFound } from "../utils/httpError.js";

const router = Router();

function projectResponse(project) {
    return {
        id:          project._id,
        name:        project.name,
        description: project.description || "",
        isActive:    project.isActive,
        createdBy:   project.createdBy,
        createdAt:   project.createdAt,
        updatedAt:   project.updatedAt,
    };
}

/**
 * GET /api/projects
 * List all active projects. All authenticated users.
 */
router.get("/", requireAuth, async (req, res, next) => {
    try {
        const projects = await Project.find({ isActive: true }).sort({ name: 1 });
        return res.json(projects.map(projectResponse));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/projects
 * Create a new project. Managers/owners only.
 * Body: { name, description? }
 */
router.post("/", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        const { name, description } = req.body || {};
        if (!name) throw badRequest("name is required");

        const project = await Project.create({
            name:        String(name).trim(),
            description: description ? String(description).trim() : undefined,
            createdBy:   req.user._id,
        });

        return res.status(201).json(projectResponse(project));
    } catch (err) {
        if (err.code === 11000) return next(badRequest("A project with that name already exists"));
        next(err);
    }
});

/**
 * PATCH /api/projects/:id
 * Update a project. Managers/owners only.
 * Body: { name?, description? }
 */
router.patch("/:id", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Project not found");

        const project = await Project.findById(req.params.id);
        if (!project) throw notFound("Project not found");

        const { name, description } = req.body || {};
        if (name        !== undefined) project.name        = String(name).trim();
        if (description !== undefined) project.description = String(description).trim();

        await project.save();
        return res.json(projectResponse(project));
    } catch (err) {
        if (err.code === 11000) return next(badRequest("A project with that name already exists"));
        next(err);
    }
});

/**
 * DELETE /api/projects/:id
 * Soft-delete a project (sets isActive: false). Managers/owners only.
 */
router.delete("/:id", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw notFound("Project not found");

        const project = await Project.findById(req.params.id);
        if (!project) throw notFound("Project not found");

        project.isActive = false;
        await project.save();

        return res.json({ message: "Project deactivated" });
    } catch (err) {
        next(err);
    }
});

export default router;
