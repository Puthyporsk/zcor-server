// app.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import authenticate from "./src/middleware/authenticate.js";
import authRouter from "./src/routes/auth.js";
import usersRouter from "./src/routes/users.js";
// import timeEntriesRouter from "./src/routes/timeEntries.js";

dotenv.config();

const app = express();
app.set("view engine", "ejs");

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  }),
);
app.options("*", cors());
app.use(express.json());
app.use(cookieParser());

// sets req.user (if Bearer token present)
app.use(authenticate);

app.get("/", (_req, res) => res.send("Hello World!"));

// mount routes
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
// app.use("/api/time-entries", timeEntriesRouter);

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
