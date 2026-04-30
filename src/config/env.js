const dotenv = require("dotenv");

dotenv.config();

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL || "postgresql://gbu-user:12345678@localhost:5432/gbu_backend",
  dbSslEnabled: String(process.env.DB_SSL_ENABLED || "false") === "true",
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || "change-me-access-secret",
  jwtRefreshSecret:
    process.env.JWT_REFRESH_SECRET || "change-me-refresh-secret",
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  otpExpiresMinutes: Number(process.env.OTP_EXPIRES_MINUTES) || 10,
  otpMaxAttempts: Number(process.env.OTP_MAX_ATTEMPTS) || 5,
  otpPepper: process.env.OTP_PEPPER || "change-me-otp-pepper",
  appBaseUrl: process.env.APP_BASE_URL || "",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpSecure: String(process.env.SMTP_SECURE || "false") === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || "no-reply@gbu.ac.in",
  corsOrigin: process.env.CORS_ORIGIN || process.env.APP_BASE_URL || "*",
  apiRateLimitWindowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  apiRateLimitMax:
    Number(process.env.API_RATE_LIMIT_MAX) ||
    (String(process.env.NODE_ENV || "development") === "production" ? 300 : 2000),
  authRateLimitWindowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
};

module.exports = env;
