const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {

    if (!req.user || !req.user.role) {
      console.log("AUTHORIZE DEBUG: NO USER OR ROLE", {
        user: req.user,
      });

      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    const userRole = String(req.user.role).toLowerCase();

    const normalizedAllowedRoles =
      allowedRoles.map(role =>
        String(role).toLowerCase()
      );

    console.log("AUTHORIZE DEBUG:", {
      method: req.method,
      url: req.originalUrl,
      uid: req.user.uid,
      email: req.user.email,
      role: userRole,
      allowedRoles: normalizedAllowedRoles,
    });

    if (!normalizedAllowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    next();

  };
};

module.exports = authorizeRoles;