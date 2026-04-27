const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../../config/db");
const { successResponse, errorResponse } = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");
const { ensureAuthBootstrap } = require("../auth/auth.service");
const { sendMail, isMailConfigured } = require("../../utils/mailer");
const ROLES = require("../../constants/roles");

const router = express.Router();

const UI_TO_DB_ROLE = {
	admin: ROLES.SUPER_ADMIN,
	school: ROLES.SCHOOL,
	teacher: ROLES.FACULTY,
};

const DB_TO_UI_ROLE = {
	[ROLES.SUPER_ADMIN]: "admin",
	[ROLES.SCHOOL]: "school",
	[ROLES.FACULTY]: "teacher",
};

const AUDIT_ENTITY = "account";

const normalize = (value) => String(value || "").trim();

const makeSyntheticEmail = (username) => {
	const cleanUsername = normalize(username).toLowerCase();
	if (!cleanUsername) return "";
	if (cleanUsername.includes("@")) return cleanUsername;
	return `${cleanUsername}@portal.gbu.local`;
};

const toSafeInt = (value, fallback) => {
	const parsed = Number.parseInt(String(value || ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const mapAccount = (row) => ({
	id: row.id,
	name: row.name,
	username: row.username || row.email,
	password: "",
	role: DB_TO_UI_ROLE[row.role] || "teacher",
	status: row.is_active ? "active" : "inactive",
	linkedFacultyId: row.linked_faculty_id || "",
	linkedSchool: row.linked_school || "",
	linkedDepartment: row.linked_department || "",
});

const mapAuditLog = (row) => ({
	id: row.id,
	action: row.action,
	entityType: row.entity_type,
	entityId: row.entity_id,
	summary: row.summary,
	metadata: row.metadata || {},
	actor: {
		id: row.actor_user_id,
		name: row.actor_name || row.actor_email || "System",
		email: row.actor_email || "",
		role: row.actor_role || "",
	},
	createdAt: row.created_at,
});

const ensureUsersAuditInfrastructure = async () => {
	await query(`
		CREATE TABLE IF NOT EXISTS admin_audit_logs (
			id BIGSERIAL PRIMARY KEY,
			actor_user_id INT,
			actor_email VARCHAR(255),
			actor_role VARCHAR(30),
			action VARCHAR(80) NOT NULL,
			entity_type VARCHAR(50) NOT NULL,
			entity_id VARCHAR(120) NOT NULL,
			summary TEXT NOT NULL,
			metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMP NOT NULL DEFAULT NOW()
		);
	`);

	await query(
		`CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at DESC);`,
	);
	await query(
		`CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_entity ON admin_audit_logs(entity_type, entity_id);`,
	);
};

const logAdminAction = async ({ req, action, entityId, summary, metadata = {} }) => {
	await query(
		`
		INSERT INTO admin_audit_logs (
			actor_user_id,
			actor_email,
			actor_role,
			action,
			entity_type,
			entity_id,
			summary,
			metadata
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
		`,
		[
			Number(req.user?.sub) || null,
			normalize(req.user?.email) || null,
			normalize(req.user?.role) || null,
			action,
			AUDIT_ENTITY,
			String(entityId || ""),
			summary,
			JSON.stringify(metadata || {}),
		],
	);
};

const buildFilters = ({ queryText, role, status }) => {
	const clauses = ["role IN ($1, $2, $3)"];
	const params = [ROLES.SUPER_ADMIN, ROLES.SCHOOL, ROLES.FACULTY];

	if (queryText) {
		params.push(`%${queryText.toLowerCase()}%`);
		const idx = params.length;
		clauses.push(`(
			LOWER(name) LIKE $${idx}
			OR LOWER(COALESCE(username, '')) LIKE $${idx}
			OR LOWER(COALESCE(linked_faculty_id, '')) LIKE $${idx}
			OR LOWER(COALESCE(linked_school, '')) LIKE $${idx}
			OR LOWER(COALESCE(linked_department, '')) LIKE $${idx}
		)`);
	}

	if (role && UI_TO_DB_ROLE[role]) {
		params.push(UI_TO_DB_ROLE[role]);
		clauses.push(`role = $${params.length}`);
	}

	if (status === "active" || status === "inactive") {
		params.push(status === "active");
		clauses.push(`is_active = $${params.length}`);
	}

	return { clauses, params };
};

const buildCredentialMailContent = ({ facultyName, username, password, linkedFacultyId }) => {
	const safeFacultyName = normalize(facultyName) || "Faculty Member";
	const safeUsername = normalize(username) || "";
	const safePassword = String(password || "").trim();
	const safeLinkedFacultyId = normalize(linkedFacultyId) || "N/A";

	const text = [
		`Dear ${safeFacultyName},`,
		"",
		"Your GBU Faculty Portal credentials are generated.",
		`Username: ${safeUsername}`,
		`Password: ${safePassword}`,
		`Linked Faculty ID: ${safeLinkedFacultyId}`,
		"",
		"Please change your password after first login.",
	].join("\n");

	const html = `
		<p>Dear ${safeFacultyName},</p>
		<p>Your GBU Faculty Portal credentials are generated.</p>
		<ul>
			<li><strong>Username:</strong> ${safeUsername}</li>
			<li><strong>Password:</strong> ${safePassword}</li>
			<li><strong>Linked Faculty ID:</strong> ${safeLinkedFacultyId}</li>
		</ul>
		<p>Please change your password after first login.</p>
	`;

	return { text, html };
};

const validateRoleLinks = async ({
	role,
	linkedFacultyId,
	linkedSchool,
	linkedDepartment,
	accountId,
}) => {
	const roleErrors = [];
	const excludedAccountId = Number.isInteger(accountId) ? accountId : null;

	if (role === "school") {
		if (!linkedSchool) {
			roleErrors.push({
				field: "linkedSchool",
				message: "School account must have a linked school",
			});
			return { errors: roleErrors };
		}

		const schoolExistsResult = await query(
			`
			SELECT id
			FROM schools
			WHERE LOWER(COALESCE(code, '')) = LOWER($1)
				OR LOWER(COALESCE(name, '')) = LOWER($1)
				OR LOWER(COALESCE(slug, '')) = LOWER($1)
			LIMIT 1
			`,
			[linkedSchool],
		);

		if (!schoolExistsResult.rows.length) {
			roleErrors.push({
				field: "linkedSchool",
				message: "Linked school does not exist",
			});
			return { errors: roleErrors };
		}

		const duplicateSchoolResult = await query(
			`
			SELECT id
			FROM users
			WHERE role = $1
				AND LOWER(TRIM(COALESCE(linked_school, ''))) = LOWER(TRIM($2))
				AND ($3::INT IS NULL OR id <> $3::INT)
			LIMIT 1
			`,
			[ROLES.SCHOOL, linkedSchool, excludedAccountId],
		);

		if (duplicateSchoolResult.rows.length) {
			roleErrors.push({
				field: "linkedSchool",
				message: "This school already has a login account",
			});
		}

		return { errors: roleErrors };
	}

	if (role === "teacher") {
		if (!linkedFacultyId) {
			roleErrors.push({
				field: "linkedFacultyId",
				message: "Faculty account must have a linked faculty id",
			});
		}

		if (!linkedSchool) {
			roleErrors.push({
				field: "linkedSchool",
				message: "Faculty account must be linked to a school",
			});
		}

		if (!linkedDepartment) {
			roleErrors.push({
				field: "linkedDepartment",
				message: "Faculty account must be linked to a department",
			});
		}

		if (roleErrors.length) {
			return { errors: roleErrors };
		}

		const duplicateFacultyResult = await query(
			`
			SELECT id
			FROM users
			WHERE role = $1
				AND LOWER(TRIM(COALESCE(linked_faculty_id, ''))) = LOWER(TRIM($2))
				AND ($3::INT IS NULL OR id <> $3::INT)
			LIMIT 1
			`,
			[ROLES.FACULTY, linkedFacultyId, excludedAccountId],
		);

		if (duplicateFacultyResult.rows.length) {
			roleErrors.push({
				field: "linkedFacultyId",
				message: "This faculty already has a login account",
			});
		}

		const schoolResult = await query(
			`
			SELECT id, code, name
			FROM schools
			WHERE LOWER(COALESCE(code, '')) = LOWER($1)
				OR LOWER(COALESCE(name, '')) = LOWER($1)
				OR LOWER(COALESCE(slug, '')) = LOWER($1)
			LIMIT 1
			`,
			[linkedSchool],
		);

		if (!schoolResult.rows.length) {
			roleErrors.push({
				field: "linkedSchool",
				message: "Linked school does not exist",
			});
			return { errors: roleErrors };
		}

		const school = schoolResult.rows[0];
		const departmentResult = await query(
			`
			SELECT id
			FROM departments
			WHERE school_id = $1
				AND (
					LOWER(COALESCE(code, '')) = LOWER($2)
					OR LOWER(COALESCE(name, '')) = LOWER($2)
					OR LOWER(COALESCE(slug, '')) = LOWER($2)
					OR CAST(id AS TEXT) = $2
				)
			LIMIT 1
			`,
			[school.id, linkedDepartment],
		);

		if (!departmentResult.rows.length) {
			roleErrors.push({
				field: "linkedDepartment",
				message: "Linked department does not belong to the selected school",
			});
		}

		return { errors: roleErrors };
	}

	return { errors: roleErrors };
};

const adminAuth = [authenticate, authorize(ROLES.SUPER_ADMIN)];

router.get("/admin/accounts", adminAuth, async (req, res) => {
	try {
		await ensureAuthBootstrap();
		await ensureUsersAuditInfrastructure();

		const queryText = normalize(req.query?.query).toLowerCase();
		const role = normalize(req.query?.role).toLowerCase();
		const status = normalize(req.query?.status).toLowerCase();
		const page = toSafeInt(req.query?.page, 1);
		const limit = clamp(toSafeInt(req.query?.limit, 10), 1, 50);
		const offset = (page - 1) * limit;
		const { clauses, params } = buildFilters({ queryText, role, status });
		const whereClause = clauses.join(" AND ");

		const countResult = await query(
			`
			SELECT COUNT(*)::INT AS total
			FROM users
			WHERE ${whereClause}
			`,
			params,
		);

		const total = Number(countResult.rows[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit));

		const resultParams = [...params, limit, offset];

		const result = await query(
			`
			SELECT id, name, email, username, role, is_active, linked_faculty_id, linked_school, linked_department
			FROM users
			WHERE ${whereClause}
			ORDER BY id DESC
			LIMIT $${resultParams.length - 1}
			OFFSET $${resultParams.length}
			`,
			resultParams,
		);

		return successResponse(res, "Accounts fetched successfully", {
			items: result.rows.map(mapAccount),
			pagination: {
				page,
				limit,
				total,
				totalPages,
			},
		});
	} catch (error) {
		return errorResponse(
			res,
			"Failed to fetch accounts",
			[{ field: "accounts", message: error.message }],
			500,
		);
	}
});

router.post("/admin/accounts", adminAuth, async (req, res) => {
	try {
		await ensureAuthBootstrap();
		await ensureUsersAuditInfrastructure();

		const name = normalize(req.body?.name);
		const username = normalize(req.body?.username).toLowerCase();
		const password = String(req.body?.password || "");
		const role = normalize(req.body?.role).toLowerCase();
		const status = normalize(req.body?.status).toLowerCase();
		const linkedFacultyId = normalize(req.body?.linkedFacultyId);
		const linkedSchool = normalize(req.body?.linkedSchool);
		const linkedDepartment = normalize(req.body?.linkedDepartment);

		if (!username || !password || !UI_TO_DB_ROLE[role]) {
			return errorResponse(
				res,
				"Validation failed",
				[
					{ field: "username", message: "Username is required" },
					{ field: "password", message: "Password is required" },
					{ field: "role", message: "Role must be admin, school, or teacher" },
				],
				400,
			);
		}

		const roleValidation = await validateRoleLinks({
			role,
			linkedFacultyId,
			linkedSchool,
			linkedDepartment,
		});

		if (roleValidation.errors.length) {
			return errorResponse(res, "Validation failed", roleValidation.errors, 400);
		}

		const passwordHash = await bcrypt.hash(password, 12);
		const result = await query(
			`
			INSERT INTO users (
				name,
				email,
				username,
				role,
				password_hash,
				is_active,
				linked_faculty_id,
				linked_school,
				linked_department,
				email_verified,
				password_updated_at,
				updated_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, NOW(), NOW())
			RETURNING id, name, email, username, role, is_active, linked_faculty_id, linked_school, linked_department
			`,
			[
				name || username,
				makeSyntheticEmail(username),
				username,
				UI_TO_DB_ROLE[role],
				passwordHash,
				status !== "inactive",
				linkedFacultyId,
				linkedSchool,
				linkedDepartment,
			],
		);

		const created = result.rows[0];
		await logAdminAction({
			req,
			action: "create-account",
			entityId: created.id,
			summary: `Created ${username} (${role}) account`,
			metadata: {
				username,
				role,
				status: status === "inactive" ? "inactive" : "active",
				linkedFacultyId,
				linkedSchool,
				linkedDepartment,
			},
		});

		return successResponse(res, "Account created successfully", mapAccount(created), 201);
	} catch (error) {
		if (error.code === "23505") {
			return errorResponse(
				res,
				"Duplicate account",
				[{ field: "username", message: "Username already exists" }],
				409,
			);
		}

		return errorResponse(
			res,
			"Failed to create account",
			[{ field: "accounts", message: error.message }],
			500,
		);
	}
});

router.put("/admin/accounts/:id", adminAuth, async (req, res) => {
	try {
		await ensureAuthBootstrap();
		await ensureUsersAuditInfrastructure();

		const accountId = Number(req.params.id);
		if (!Number.isInteger(accountId) || accountId <= 0) {
			return errorResponse(
				res,
				"Validation failed",
				[{ field: "id", message: "Valid account id is required" }],
				400,
			);
		}

		const existingResult = await query(
			`
			SELECT id, username, role
			FROM users
			WHERE id = $1
			LIMIT 1
			`,
			[accountId],
		);

		const existing = existingResult.rows[0];
		if (!existing) {
			return errorResponse(
				res,
				"Account not found",
				[{ field: "id", message: "Account does not exist" }],
				404,
			);
		}

		const name = normalize(req.body?.name);
		const username = normalize(req.body?.username).toLowerCase() || existing.username;
		const password = String(req.body?.password || "");
		const role = normalize(req.body?.role).toLowerCase();
		const status = normalize(req.body?.status).toLowerCase();
		const linkedFacultyId = normalize(req.body?.linkedFacultyId);
		const linkedSchool = normalize(req.body?.linkedSchool);
		const linkedDepartment = normalize(req.body?.linkedDepartment);

		if (!username || (role && !UI_TO_DB_ROLE[role])) {
			return errorResponse(
				res,
				"Validation failed",
				[
					{ field: "username", message: "Username is required" },
					{ field: "role", message: "Role must be admin, school, or teacher" },
				],
				400,
			);
		}

		const effectiveRole = role || DB_TO_UI_ROLE[existing.role] || "teacher";
		const roleValidation = await validateRoleLinks({
			role: effectiveRole,
			linkedFacultyId,
			linkedSchool,
			linkedDepartment,
			accountId,
		});

		if (roleValidation.errors.length) {
			return errorResponse(res, "Validation failed", roleValidation.errors, 400);
		}

		let sql = `
			UPDATE users
			SET name = $1,
					username = $2,
					email = $3,
					role = $4,
					is_active = $5,
					linked_faculty_id = $6,
					linked_school = $7,
					linked_department = $8,
					updated_at = NOW()`;

		const params = [
			name || username,
			username,
			makeSyntheticEmail(username),
			UI_TO_DB_ROLE[role] || existing.role,
			status === "inactive" ? false : true,
			linkedFacultyId,
			linkedSchool,
			linkedDepartment,
		];

		if (password) {
			const passwordHash = await bcrypt.hash(password, 12);
			sql += `, password_hash = $9, password_updated_at = NOW()`;
			params.push(passwordHash);
		}

		params.push(accountId);
		sql += ` WHERE id = $${params.length}
			RETURNING id, name, email, username, role, is_active, linked_faculty_id, linked_school, linked_department`;

		const result = await query(sql, params);
		const updated = result.rows[0];

		await logAdminAction({
			req,
			action: "update-account",
			entityId: accountId,
			summary: `Updated ${updated.username} account`,
			metadata: {
				username: updated.username,
				role: DB_TO_UI_ROLE[updated.role] || updated.role,
				status: updated.is_active ? "active" : "inactive",
				passwordReset: Boolean(password),
				linkedFacultyId: updated.linked_faculty_id || "",
				linkedSchool: updated.linked_school || "",
				linkedDepartment: updated.linked_department || "",
			},
		});

		return successResponse(res, "Account updated successfully", mapAccount(updated));
	} catch (error) {
		if (error.code === "23505") {
			return errorResponse(
				res,
				"Duplicate account",
				[{ field: "username", message: "Username already exists" }],
				409,
			);
		}

		return errorResponse(
			res,
			"Failed to update account",
			[{ field: "accounts", message: error.message }],
			500,
		);
	}
});

router.delete("/admin/accounts/:id", adminAuth, async (req, res) => {
	try {
		await ensureAuthBootstrap();
		await ensureUsersAuditInfrastructure();

		const accountId = Number(req.params.id);
		if (!Number.isInteger(accountId) || accountId <= 0) {
			return errorResponse(
				res,
				"Validation failed",
				[{ field: "id", message: "Valid account id is required" }],
				400,
			);
		}

		if (Number(req.user?.sub) === accountId) {
			return errorResponse(
				res,
				"Forbidden",
				[{ field: "id", message: "You cannot delete your own admin account" }],
				403,
			);
		}

		const existingResult = await query(
			`
			SELECT id, username, role
			FROM users
			WHERE id = $1
			LIMIT 1
			`,
			[accountId],
		);

		const existing = existingResult.rows[0];
		if (!existing) {
			return errorResponse(
				res,
				"Account not found",
				[{ field: "id", message: "Account does not exist" }],
				404,
			);
		}

		const result = await query(
			`
			DELETE FROM users
			WHERE id = $1
			RETURNING id
			`,
			[accountId],
		);

		await logAdminAction({
			req,
			action: "delete-account",
			entityId: accountId,
			summary: `Deleted ${existing.username} account`,
			metadata: {
				username: existing.username,
				role: DB_TO_UI_ROLE[existing.role] || existing.role,
			},
		});

		return successResponse(res, "Account deleted successfully", { id: result.rows[0].id });
	} catch (error) {
		return errorResponse(
			res,
			"Failed to delete account",
			[{ field: "accounts", message: error.message }],
			500,
		);
	}
});

router.get("/admin/accounts/audit-logs", adminAuth, async (req, res) => {
	try {
		await ensureAuthBootstrap();
		await ensureUsersAuditInfrastructure();

		const queryText = normalize(req.query?.query).toLowerCase();
		const action = normalize(req.query?.action).toLowerCase();
		const page = toSafeInt(req.query?.page, 1);
		const limit = clamp(toSafeInt(req.query?.limit, 10), 1, 50);
		const offset = (page - 1) * limit;

		const clauses = ["entity_type = $1"];
		const params = [AUDIT_ENTITY];

		if (action) {
			params.push(action);
			clauses.push(`LOWER(action) = $${params.length}`);
		}

		if (queryText) {
			params.push(`%${queryText}%`);
			const idx = params.length;
			clauses.push(`(
				LOWER(summary) LIKE $${idx}
				OR LOWER(COALESCE(actor_email, '')) LIKE $${idx}
				OR LOWER(COALESCE(entity_id, '')) LIKE $${idx}
			)`);
		}

		const whereClause = clauses.join(" AND ");

		const countResult = await query(
			`
			SELECT COUNT(*)::INT AS total
			FROM admin_audit_logs
			WHERE ${whereClause}
			`,
			params,
		);

		const total = Number(countResult.rows[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit));
		const resultParams = [...params, limit, offset];

		const result = await query(
			`
			SELECT
				logs.id,
				logs.actor_user_id,
				logs.actor_email,
				logs.actor_role,
				logs.action,
				logs.entity_type,
				logs.entity_id,
				logs.summary,
				logs.metadata,
				logs.created_at,
				users.name AS actor_name
			FROM admin_audit_logs logs
			LEFT JOIN users ON users.id = logs.actor_user_id
			WHERE ${whereClause}
			ORDER BY logs.created_at DESC, logs.id DESC
			LIMIT $${resultParams.length - 1}
			OFFSET $${resultParams.length}
			`,
			resultParams,
		);

		return successResponse(res, "Account audit logs fetched successfully", {
			items: result.rows.map(mapAuditLog),
			pagination: {
				page,
				limit,
				total,
				totalPages,
			},
		});
	} catch (error) {
		return errorResponse(
			res,
			"Failed to fetch account audit logs",
			[{ field: "auditLogs", message: error.message }],
			500,
		);
	}
});

router.post("/admin/accounts/dispatch-credential-emails", adminAuth, async (req, res) => {
	try {
		await ensureAuthBootstrap();

		const items = Array.isArray(req.body?.items) ? req.body.items : [];
		if (!items.length) {
			return errorResponse(
				res,
				"Validation failed",
				[{ field: "items", message: "At least one queue item is required" }],
				400,
			);
		}

		if (items.length > 100) {
			return errorResponse(
				res,
				"Validation failed",
				[{ field: "items", message: "Maximum 100 queue items allowed per request" }],
				400,
			);
		}

		const dispatchResults = [];
		for (const item of items) {
			const queueId = normalize(item?.id) || `queue-${Date.now()}`;
			const to = normalize(item?.to);
			const subject = normalize(item?.subject) || "GBU Faculty Portal Credentials";
			const payload = item?.payload && typeof item.payload === "object" ? item.payload : {};

			if (!to || !to.includes("@")) {
				dispatchResults.push({
					id: queueId,
					to,
					status: "failed",
					error: "Valid recipient email is required",
				});
				continue;
			}

			const { text, html } = buildCredentialMailContent(payload);

			try {
				const result = await sendMail({ to, subject, text, html });
				dispatchResults.push({
					id: queueId,
					to,
					status: result?.queued ? "sent" : "not-configured",
					messageId: result?.messageId || "",
				});
			} catch (error) {
				dispatchResults.push({
					id: queueId,
					to,
					status: "failed",
					error: error.message || "Email send failed",
				});
			}
		}

		const summary = dispatchResults.reduce(
			(acc, item) => {
				acc.total += 1;
				if (item.status === "sent") acc.sent += 1;
				if (item.status === "failed") acc.failed += 1;
				if (item.status === "not-configured") acc.notConfigured += 1;
				return acc;
			},
			{ total: 0, sent: 0, failed: 0, notConfigured: 0 },
		);

		await logAdminAction({
			req,
			action: "dispatch-credential-emails",
			entityId: "mail-queue",
			summary: `Dispatched credential emails: sent ${summary.sent}, failed ${summary.failed}, not configured ${summary.notConfigured}`,
			metadata: {
				total: summary.total,
				sent: summary.sent,
				failed: summary.failed,
				notConfigured: summary.notConfigured,
				mailConfigured: isMailConfigured(),
			},
		});

		return successResponse(res, "Credential email queue processed", {
			items: dispatchResults,
			summary: {
				...summary,
				mailConfigured: isMailConfigured(),
			},
		});
	} catch (error) {
		return errorResponse(
			res,
			"Failed to dispatch credential emails",
			[{ field: "mailQueue", message: error.message }],
			500,
		);
	}
});

module.exports = router;
