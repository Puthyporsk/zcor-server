// middleware/requireRole.js
import { forbidden } from "../utils/httpError.js";

export default function requireRole(...allowedRoles) {
  return (req, _res, next) => {
    const role = req.user?.role;
    if (!role || !allowedRoles.includes(role)) {
      return next(forbidden("You do not have permission to perform this action"));
    }
    next();
  };
}
