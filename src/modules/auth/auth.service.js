const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../../config/env");
const ROLES = require("../../constants/roles");
const { query, getDbPool } = require("../../config/db");
const { sendMail } = require("../../utils/mailer");

const portalRoleMap = {
  teacher: [ROLES.FACULTY],
  faculty: [ROLES.FACULTY],
  school: [ROLES.SCHOOL],
  admin: [ROLES.SUPER_ADMIN],
  super_admin: [ROLES.SUPER_ADMIN],
};

// const demoUsers = [
//   {
//     name: "Super Admin",
//     email: "admin@gbu.ac.in",
//     username: "admin",
//     role: ROLES.SUPER_ADMIN,
//     password: "Admin@123",
//   },
//   {
//     name: "School User",
//     email: "school@gbu.ac.in",
//     username: "school",
//     role: ROLES.SCHOOL,
//     password: "School@123",
//   },
//   {
//     name: "Faculty User",
//     email: "faculty@gbu.ac.in",
//     username: "faculty",
//     role: ROLES.FACULTY,
//     password: "Faculty@123",
//   },
// ];

let authBootstrapped = false;

const normalizeEmail = (email) =>
  String(email || "")
    .trim()
    .toLowerCase();

const hashValue = (value) => {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
};

const hashOtp = (otpCode) => hashValue(`${String(otpCode)}:${env.otpPepper}`);

const generateOtpCode = () => {
  const otp = crypto.randomInt(0, 1000000);
  return String(otp).padStart(6, "0");
};

const getExpiresAtFromToken = (token) => {
  const decoded = jwt.decode(token);
  if (!decoded?.exp) {
    return new Date(Date.now() + 60 * 60 * 1000);
  }
  return new Date(decoded.exp * 1000);
};

const signAccessToken = (user) => {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      schoolCode: user.linked_school_code,
    },
    env.jwtAccessSecret,
    { expiresIn: env.jwtAccessExpiresIn },
  );
};

const signRefreshToken = (user) => {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      type: "refresh",
    },
    env.jwtRefreshSecret,
    { expiresIn: env.jwtRefreshExpiresIn },
  );
};

const assertStrongPassword = (password) => {
  const value = String(password || "");
  if (value.length < 8) return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(value))
    return "Password must include at least one uppercase letter";
  if (!/[a-z]/.test(value))
    return "Password must include at least one lowercase letter";
  if (!/[0-9]/.test(value)) return "Password must include at least one digit";
  if (!/[^A-Za-z0-9]/.test(value))
    return "Password must include at least one special character";
  return null;
};

const isIgnorableBootstrapIndexError = (error) => {
  if (!error) {
    return false;
  }

  const message = String(error.message || "").toLowerCase();

  // Index DDL and ALTER TABLE are optional for runtime auth behavior; ignore if current DB user is not owner.
  return (
    error.code === "42501" &&
    (message.includes("must be owner of table") ||
      message.includes("permission denied for table") ||
      message.includes("permission denied for relation"))
  );
};

const createIndexIfAllowed = async (sql) => {
  try {
    await query(sql);
  } catch (error) {
    if (isIgnorableBootstrapIndexError(error)) {
      return;
    }
    throw error;
  }
};

const ensureAuthBootstrap = async () => {
  if (authBootstrapped) {
    return;
  }

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      username VARCHAR(80),
      role VARCHAR(30) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      email_verified BOOLEAN NOT NULL DEFAULT TRUE,
      linked_faculty_id VARCHAR(120) NOT NULL DEFAULT '',
      linked_school VARCHAR(80) NOT NULL DEFAULT '',
      linked_department VARCHAR(120) NOT NULL DEFAULT '',
      password_updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await createIndexIfAllowed(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(80);`,
  );
  await createIndexIfAllowed(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_faculty_id VARCHAR(120) NOT NULL DEFAULT '';`,
  );
  await createIndexIfAllowed(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_school VARCHAR(80) NOT NULL DEFAULT '';`,
  );
  await createIndexIfAllowed(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_department VARCHAR(120) NOT NULL DEFAULT '';`,
  );

  await query(`
    CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(128) NOT NULL UNIQUE,
      user_agent TEXT,
      ip_address VARCHAR(100),
      expires_at TIMESTAMP NOT NULL,
      revoked_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS password_reset_otps (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      otp_hash VARCHAR(128) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      consumed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await createIndexIfAllowed(
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users((LOWER(email)));`,
  );
  await createIndexIfAllowed(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users((LOWER(username))) WHERE username IS NOT NULL;`,
  );
  await createIndexIfAllowed(
    `CREATE INDEX IF NOT EXISTS idx_users_role_linked_school ON users(role, (LOWER(linked_school)));`,
  );
  await createIndexIfAllowed(
    `CREATE INDEX IF NOT EXISTS idx_users_role_linked_faculty_id ON users(role, (LOWER(linked_faculty_id)));`,
  );
  await createIndexIfAllowed(
    `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active ON auth_refresh_tokens(user_id, revoked_at, expires_at);`,
  );
  await createIndexIfAllowed(
    `CREATE INDEX IF NOT EXISTS idx_password_reset_otps_user_active ON password_reset_otps(user_id, consumed_at, expires_at, created_at DESC);`,
  );

  // Note: Demo users are inserted manually via DB scripts or admin panel
  // Auth is pure DB-backed - no hardcoded credentials in code

  authBootstrapped = true;
};

const login = async (email, password, portalRole, requestMeta = {}) => {
  await ensureAuthBootstrap();
  const normalizedLoginId = normalizeEmail(email);

  const userResult = await query(
    `
    SELECT id, name, email, username, role, password_hash, is_active, force_password_reset, linked_school_code
    FROM users
    WHERE LOWER(email) = $1
    LIMIT 1
    `,
    [normalizedLoginId],
  );

  const user = userResult.rows[0];
  if (!user || !user.is_active) {
    return null;
  }

  const isPasswordMatch = await bcrypt.compare(
    String(password || ""),
    user.password_hash,
  );

  if (!isPasswordMatch) {
    return null;
  }

  if (portalRole) {
    const roleKey = String(portalRole).toLowerCase();
    const allowedRoles = portalRoleMap[roleKey];

    if (!allowedRoles || !allowedRoles.includes(user.role)) {
      return null;
    }
  }

  // Generate OTP for login
  const otpCode = generateOtpCode();
  const expiresAt = new Date(Date.now() + env.otpExpiresMinutes * 60 * 1000);

  await query(
    `
    UPDATE password_reset_otps
    SET consumed_at = NOW()
    WHERE user_id = $1
      AND consumed_at IS NULL
      AND expires_at > NOW()
    `,
    [user.id],
  );

  await query(
    `
    INSERT INTO password_reset_otps (user_id, otp_hash, expires_at)
    VALUES ($1, $2, $3)
    `,
    [user.id, hashOtp(otpCode), expiresAt],
  );

  const subject = "GBU Login Verification OTP";
  const html = `
    <p>Dear ${user.name},</p>
    <p>Your OTP for login is:</p>
    <h2 style="letter-spacing: 4px;">${otpCode}</h2>
    <p>This OTP is valid for ${env.otpExpiresMinutes} minutes.</p>
  `;
  await sendMail({ to: user.email, subject, text: `Your OTP is ${otpCode}`, html });

  return {
    requiresOtp: true,
    email: user.email,
    forcePasswordReset: user.force_password_reset
  };
};

const verifyLoginOtp = async (email, otp, newPassword, requestMeta = {}) => {
  await ensureAuthBootstrap();
  const normalizedEmail = normalizeEmail(email);

  const userResult = await query(
    `
    SELECT id, name, email, username, role, password_hash, is_active, force_password_reset, linked_school_code
    FROM users
    WHERE LOWER(email) = $1
    LIMIT 1
    `,
    [normalizedEmail],
  );

  const user = userResult.rows[0];
  if (!user || !user.is_active) return { success: false, message: "Invalid user" };

  const otpResult = await query(
    `
    SELECT id, otp_hash, attempts
    FROM password_reset_otps
    WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
    ORDER BY created_at DESC LIMIT 1
    `,
    [user.id],
  );

  const activeOtp = otpResult.rows[0];
  if (!activeOtp) return { success: false, message: "OTP expired. Please login again." };

  if (hashOtp(otp) !== activeOtp.otp_hash) {
    const nextAttempts = Number(activeOtp.attempts || 0) + 1;
    await query(
      `UPDATE password_reset_otps SET attempts = $2, consumed_at = CASE WHEN $2 >= $3 THEN NOW() ELSE consumed_at END WHERE id = $1`,
      [activeOtp.id, nextAttempts, env.otpMaxAttempts]
    );
    return { success: false, message: "Invalid OTP" };
  }

  if (user.force_password_reset) {
     if (!newPassword) return { success: false, message: "New password is required for first time login" };
     const passwordError = assertStrongPassword(newPassword);
     if (passwordError) return { success: false, message: passwordError };
     const newPasswordHash = await bcrypt.hash(newPassword, 12);
     await query(`UPDATE users SET password_hash = $2, force_password_reset = FALSE WHERE id = $1`, [newPasswordHash, user.id]);
  }

  await query(`UPDATE password_reset_otps SET consumed_at = NOW() WHERE id = $1`, [activeOtp.id]);

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  await query(
    `
    INSERT INTO auth_refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    `,
    [user.id, hashValue(refreshToken), requestMeta.userAgent || null, requestMeta.ipAddress || null, getExpiresAtFromToken(refreshToken)]
  );

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    accessToken,
    refreshToken,
  };
};

const refresh = async (token) => {
  await ensureAuthBootstrap();

  if (!token) {
    return null;
  }

  try {
    const payload = jwt.verify(token, env.jwtRefreshSecret);
    if (payload?.type !== "refresh") {
      return null;
    }

    const refreshTokenResult = await query(
      `
      SELECT id, user_id
      FROM auth_refresh_tokens
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
      LIMIT 1
      `,
      [hashValue(token)],
    );

    const activeToken = refreshTokenResult.rows[0];
    if (!activeToken || Number(activeToken.user_id) !== Number(payload.sub)) {
      return null;
    }

    const userResult = await query(
      `
      SELECT id, name, email, role, is_active, linked_school_code
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [payload.sub],
    );

    const user = userResult.rows[0];
    if (!user || !user.is_active) {
      return null;
    }

    const accessToken = signAccessToken(user);
    return { accessToken };
  } catch (_error) {
    return null;
  }
};

const logout = async (token) => {
  await ensureAuthBootstrap();

  if (!token) {
    return false;
  }

  const result = await query(
    `
    UPDATE auth_refresh_tokens
    SET revoked_at = NOW()
    WHERE token_hash = $1
      AND revoked_at IS NULL
    `,
    [hashValue(token)],
  );

  return result.rowCount > 0;
};

const requestPasswordResetOtp = async (email) => {
  await ensureAuthBootstrap();
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return { accepted: true };
  }

  const userResult = await query(
    `
    SELECT id, name, email, role, is_active
    FROM users
    WHERE LOWER(email) = $1
    LIMIT 1
    `,
    [normalizedEmail],
  );

  const user = userResult.rows[0];
  if (!user || !user.is_active) {
    return { accepted: true };
  }

  const otpCode = generateOtpCode();
  const expiresAt = new Date(Date.now() + env.otpExpiresMinutes * 60 * 1000);

  await query(
    `
    UPDATE password_reset_otps
    SET consumed_at = NOW()
    WHERE user_id = $1
      AND consumed_at IS NULL
      AND expires_at > NOW()
    `,
    [user.id],
  );

  await query(
    `
    INSERT INTO password_reset_otps (user_id, otp_hash, expires_at)
    VALUES ($1, $2, $3)
    `,
    [user.id, hashOtp(otpCode), expiresAt],
  );

  const subject = "GBU Password Reset OTP";
  const text = `Your OTP for password reset is ${otpCode}. It is valid for ${env.otpExpiresMinutes} minutes.`;
  const html = `
    <p>Dear ${user.name},</p>
    <p>Your OTP for password reset is:</p>
    <h2 style="letter-spacing: 4px;">${otpCode}</h2>
    <p>This OTP is valid for ${env.otpExpiresMinutes} minutes.</p>
    <p>If you did not request this, please ignore this email.</p>
  `;

  await sendMail({ to: user.email, subject, text, html });

  return { accepted: true };
};

const verifyOtpAndResetPassword = async ({ email, otp, newPassword }) => {
  await ensureAuthBootstrap();
  const normalizedEmail = normalizeEmail(email);

  const passwordError = assertStrongPassword(newPassword);
  if (passwordError) {
    return { success: false, code: "WEAK_PASSWORD", message: passwordError };
  }

  const userResult = await query(
    `
    SELECT id, email, is_active
    FROM users
    WHERE LOWER(email) = $1
    LIMIT 1
    `,
    [normalizedEmail],
  );

  const user = userResult.rows[0];
  if (!user || !user.is_active) {
    return {
      success: false,
      code: "INVALID_REQUEST",
      message: "Invalid email or OTP",
    };
  }

  const otpResult = await query(
    `
    SELECT id, otp_hash, attempts
    FROM password_reset_otps
    WHERE user_id = $1
      AND consumed_at IS NULL
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [user.id],
  );

  const activeOtp = otpResult.rows[0];
  if (!activeOtp) {
    return {
      success: false,
      code: "OTP_EXPIRED",
      message: "OTP expired. Please request a new OTP",
    };
  }

  const incomingOtpHash = hashOtp(otp);
  if (incomingOtpHash !== activeOtp.otp_hash) {
    const nextAttempts = Number(activeOtp.attempts || 0) + 1;
    await query(
      `
      UPDATE password_reset_otps
      SET attempts = $2,
          consumed_at = CASE WHEN $2 >= $3 THEN NOW() ELSE consumed_at END
      WHERE id = $1
      `,
      [activeOtp.id, nextAttempts, env.otpMaxAttempts],
    );
    return { success: false, code: "INVALID_OTP", message: "OTP is invalid" };
  }

  const newPasswordHash = await bcrypt.hash(newPassword, 12);

  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `
      UPDATE users
      SET password_hash = $2,
          email_verified = TRUE,
          password_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [user.id, newPasswordHash],
    );

    await client.query(
      `
      UPDATE password_reset_otps
      SET consumed_at = NOW()
      WHERE user_id = $1
        AND consumed_at IS NULL
      `,
      [user.id],
    );

    await client.query(
      `
      UPDATE auth_refresh_tokens
      SET revoked_at = NOW()
      WHERE user_id = $1
        AND revoked_at IS NULL
      `,
      [user.id],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { success: true };
};

module.exports = {
  ensureAuthBootstrap,
  login,
  verifyLoginOtp,
  refresh,
  logout,
  requestPasswordResetOtp,
  verifyOtpAndResetPassword,
};
