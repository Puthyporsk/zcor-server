// app.js
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, ".env") });

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import authenticate from "./src/middleware/authenticate.js";
import authRouter from "./src/routes/auth.js";
import usersRouter from "./src/routes/users.js";
import timeEntriesRouter from "./src/routes/timeEntries.js";
import tasksRouter from "./src/routes/tasks.js";
import shiftsRouter from "./src/routes/shifts.js";
import projectsRouter from "./src/routes/projects.js";
import inventoryRouter from "./src/routes/inventory.js";
import inventoryOrdersRouter from "./src/routes/inventoryOrders.js";
import leaveRouter from "./src/routes/leave.js";
import payrollRouter from "./src/routes/payroll.js";
import leavePolicyRouter from "./src/routes/leavePolicy.js";

const app = express();
app.set("view engine", "ejs");

app.use(helmet());
app.use(express.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(
  cors({
    origin: ["http://localhost:3000", "https://zcor.org", "https://www.zcor.org"],
    credentials: true,
  }),
);
app.options("*", cors());
app.use(express.json());
app.use(cookieParser());

// Rate limiting on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // 15 attempts per window
  message: { message: "Too many attempts. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// sets req.user (if Bearer token present)
app.use(authenticate);

app.get("/", (_req, res) => res.send("Hello World!"));

// mount routes
app.use("/api/auth", authLimiter, authRouter);
app.use("/api/user", usersRouter);
app.use("/api/time-entries", timeEntriesRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/shifts", shiftsRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/inventory-orders", inventoryOrdersRouter);
app.use("/api/leave", leaveRouter);
app.use("/api/payroll", payrollRouter);
app.use("/api/leave-policy", leavePolicyRouter);

// error handler AFTER routes
app.use((err, _req, res, _next) => {
  const status = err?.statusCode || 500;
  res.status(status).json({
    message: err?.message || "Internal Server Error",
    details: err?.details,
  });
});

mongoose
  .connect(process.env.MONGO_URL)
  .then(() => {
    console.log("MongoDB Connection State:", mongoose.connection.readyState);
    const port = process.env.PORT || "5000";
    app.listen(port, (err) => {
      if (err) throw err;
      console.log("Server listening on port", port);
    });
  })
  .catch((err) => {
    console.error("\nMongoDB connection error occurred!");
    console.error("Error name:", err.name);
    console.error("Error message:", err.message);
    console.error("Error code:", err.code);
    console.error("Full error stack:", err.stack);
    process.exit(1);
  });

export default app;
