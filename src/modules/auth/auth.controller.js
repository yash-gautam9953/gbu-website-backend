const { verifyLoginOtp,
  login,
  refresh,
  logout,
  requestPasswordResetOtp,
  verifyOtpAndResetPassword,
} = require("./auth.service");
const { successResponse, errorResponse } = require("../../utils/response");

const validateCredentials = (loginId, password) => {
  if (!loginId || !password) {
    return [
      { field: "loginId", message: "Username or email is required" },
      { field: "password", message: "Password is required" },
    ];
  }

  return null;
};

const createRoleLoginHandler = (portalRole, roleLabel) => {
  return async (req, res) => {
    const loginId = String(req.body?.email || req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    const validationErrors = validateCredentials(loginId, password);

    if (validationErrors) {
      return errorResponse(res, "Validation failed", validationErrors, 400);
    }

    const authResult = await login(loginId, password, portalRole, {
      userAgent: req.get("user-agent"),
      ipAddress: req.ip,
    });

    if (!authResult) {
      return errorResponse(
        res,
        "Invalid credentials",
        [
          {
            field: "credentials",
            message: `Username/email or password is incorrect for ${roleLabel} login`,
          },
        ],
        401,
      );
    }

    return successResponse(
      res,
      `${roleLabel} login successful`,
      authResult,
      200,
    );
  };
};

const teacherLoginHandler = createRoleLoginHandler("teacher", "Teacher");
const schoolLoginHandler = createRoleLoginHandler("school", "School");
const adminLoginHandler = createRoleLoginHandler("admin", "Admin");


const verifyLoginOtpHandler = async (req, res) => {
  const email = String(req.body?.email || "").trim();
  const otp = String(req.body?.otp || "").trim();
  const newPassword = req.body?.newPassword;

  if (!email || !otp) {
    return errorResponse(res, "Validation failed", [{ field: "email", message: "Email and OTP are required" }], 400);
  }

  const result = await verifyLoginOtp(email, otp, newPassword, {
    userAgent: req.get("user-agent"),
    ipAddress: req.ip,
  });

  if (!result.success) {
    return errorResponse(res, "Verification failed", [{ field: "otp", message: result.message }], 400);
  }

  return successResponse(res, "Login verified successfully", result.data, 200);
};

const refreshHandler = async (req, res) => {
  const { refreshToken } = req.body;
  const tokenResult = await refresh(refreshToken);

  if (!tokenResult) {
    return errorResponse(
      res,
      "Invalid refresh token",
      [
        {
          field: "refreshToken",
          message: "Refresh token is invalid or expired",
        },
      ],
      401,
    );
  }

  return successResponse(res, "Access token refreshed", tokenResult, 200);
};

const logoutHandler = async (req, res) => {
  const { refreshToken } = req.body;
  const isRemoved = await logout(refreshToken);

  if (!isRemoved) {
    return errorResponse(
      res,
      "Invalid refresh token",
      [{ field: "refreshToken", message: "Refresh token is invalid" }],
      400,
    );
  }

  return successResponse(res, "Logged out successfully", {}, 200);
};

const forgotPasswordRequestHandler = async (req, res) => {
  const email = String(req.body?.email || "").trim();

  if (!email) {
    return errorResponse(
      res,
      "Validation failed",
      [{ field: "email", message: "Email is required" }],
      400,
    );
  }

  await requestPasswordResetOtp(email);

  return successResponse(
    res,
    "If the email exists, OTP has been sent",
    {},
    200,
  );
};

const forgotPasswordVerifyHandler = async (req, res) => {
  const email = String(req.body?.email || "").trim();
  const otp = String(req.body?.otp || "").trim();
  const newPassword = String(req.body?.newPassword || "").trim();
  const confirmPassword = String(req.body?.confirmPassword || "").trim();

  if (!email || !otp || !newPassword || !confirmPassword) {
    return errorResponse(
      res,
      "Validation failed",
      [
        { field: "email", message: "Email is required" },
        { field: "otp", message: "OTP is required" },
        { field: "newPassword", message: "New password is required" },
        { field: "confirmPassword", message: "Confirm password is required" },
      ],
      400,
    );
  }

  if (newPassword !== confirmPassword) {
    return errorResponse(
      res,
      "Validation failed",
      [{ field: "confirmPassword", message: "Passwords do not match" }],
      400,
    );
  }

  const result = await verifyOtpAndResetPassword({ email, otp, newPassword });

  if (!result.success) {
    const statusCode =
      result.code === "WEAK_PASSWORD" || result.code === "INVALID_OTP"
        ? 400
        : 401;

    return errorResponse(
      res,
      "Password reset failed",
      [{ field: result.code || "reset", message: result.message }],
      statusCode,
    );
  }

  return successResponse(res, "Password reset successful", {}, 200);
};

const meHandler = (req, res) => {
  return successResponse(res, "User profile fetched", {
    id: req.user.sub,
    email: req.user.email,
    role: req.user.role,
    name: req.user.name,
  });
};

module.exports = {
  verifyLoginOtpHandler,
  teacherLoginHandler,
  schoolLoginHandler,
  adminLoginHandler,
  refreshHandler,
  logoutHandler,
  meHandler,
  forgotPasswordRequestHandler,
  forgotPasswordVerifyHandler,
};
