const express = require("express");
const crypto = require("crypto");
const { query } = require("../../config/db");
const { successResponse, errorResponse } = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");
const { ensureAuthBootstrap } = require("../auth/auth.service");
const ROLES = require("../../constants/roles");

const router = express.Router();

const normalize = (value) => String(value || "").trim();

const toSafeInt = (value, fallback) => {
	const parsed = Number.parseInt(String(value || ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const safeJsonParse = (value, fallback) => {
	if (value && typeof value === "object") return value;
	try { return JSON.parse(value) || fallback; } catch { return fallback; }
};

/* ─── Row mappers ─── */

const mapFacultyBasic = (row) => ({
	id: row.id,
	name: row.name,
	designation: row.designation || "",
	department: row.department || "",
	school: row.school || "",
	email: row.email || "",
	phone: row.phone || "",
	isActive: row.is_active,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
});

const mapFacultyFull = (row) => ({
	...mapFacultyBasic(row),
	specialization: row.specialization || "",
	experience_years: Number(row.experience_years) || 0,
	publications: Number(row.publications_count) || 0,
	education: row.education || "",
	shortBio: row.short_bio || "",
	fullBio: row.full_bio || "",
	office: row.office || "",
	image_url: row.image_url || "",
	faculty_url: row.faculty_url || "",
	cv: row.cv_link || "",
	googleScholar: row.google_scholar || "",
	orcid: row.orcid || "",
	tags: safeJsonParse(row.tags, []),
	researchAreas: safeJsonParse(row.research_areas, []),
	tabData: safeJsonParse(row.tab_data, {}),
});

/* ─── Schema bootstrap ─── */

let facultySchemaReady = false;

const ensureFacultyInfrastructure = async () => {
	if (facultySchemaReady) return;

	await query(`
		CREATE TABLE IF NOT EXISTS faculty_profiles (
			id VARCHAR(120) PRIMARY KEY,
			name VARCHAR(180) NOT NULL,
			designation VARCHAR(180) NOT NULL DEFAULT '',
			department VARCHAR(180) NOT NULL DEFAULT '',
			school VARCHAR(180) NOT NULL DEFAULT '',
			email VARCHAR(255) NOT NULL DEFAULT '',
			phone VARCHAR(80) NOT NULL DEFAULT '',
			is_active BOOLEAN NOT NULL DEFAULT TRUE,
			created_by INT,
			updated_by INT,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		);
	`);

	// Extended columns for rich faculty profiles
	const alterCols = [
		"specialization VARCHAR(300) NOT NULL DEFAULT ''",
		"experience_years INT NOT NULL DEFAULT 0",
		"publications_count INT NOT NULL DEFAULT 0",
		"education TEXT NOT NULL DEFAULT ''",
		"short_bio TEXT NOT NULL DEFAULT ''",
		"full_bio TEXT NOT NULL DEFAULT ''",
		"office VARCHAR(300) NOT NULL DEFAULT ''",
		"image_url TEXT NOT NULL DEFAULT ''",
		"faculty_url TEXT NOT NULL DEFAULT ''",
		"cv_link TEXT NOT NULL DEFAULT ''",
		"google_scholar TEXT NOT NULL DEFAULT ''",
		"orcid TEXT NOT NULL DEFAULT ''",
		"tags JSONB NOT NULL DEFAULT '[]'::jsonb",
		"research_areas JSONB NOT NULL DEFAULT '[]'::jsonb",
		"tab_data JSONB NOT NULL DEFAULT '{}'::jsonb",
	];

	for (const col of alterCols) {
		const colName = col.split(" ")[0];
		await query(`ALTER TABLE faculty_profiles ADD COLUMN IF NOT EXISTS ${col};`);
	}

	await query(`CREATE INDEX IF NOT EXISTS idx_faculty_profiles_school ON faculty_profiles((LOWER(school)));`);
	await query(`CREATE INDEX IF NOT EXISTS idx_faculty_profiles_department ON faculty_profiles((LOWER(department)));`);
	await query(`CREATE INDEX IF NOT EXISTS idx_faculty_profiles_name ON faculty_profiles((LOWER(name)));`);
	await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_faculty_profiles_email_unique ON faculty_profiles((LOWER(email))) WHERE TRIM(email) <> '';`);

	facultySchemaReady = true;
};

const ensureFacultyContext = async () => {
	await ensureAuthBootstrap();
	await ensureFacultyInfrastructure();
};

const FULL_SELECT = `id, name, designation, department, school, email, phone, is_active,
	specialization, experience_years, publications_count, education, short_bio, full_bio,
	office, image_url, faculty_url, cv_link, google_scholar, orcid,
	tags, research_areas, tab_data, created_at, updated_at`;

/* ═══════════════════════════════════════════════════════════════
   PUBLIC ENDPOINTS (no auth required)
   ═══════════════════════════════════════════════════════════════ */

// Public: list all active faculty (basic info only)
router.get("/faculty/public", async (req, res) => {
	try {
		await ensureFacultyContext();

		const dept = normalize(req.query?.department).toLowerCase();
		const school = normalize(req.query?.school).toLowerCase();
		const search = normalize(req.query?.query).toLowerCase();
		const page = toSafeInt(req.query?.page, 1);
		const limit = clamp(toSafeInt(req.query?.limit, 50), 1, 100);
		const offset = (page - 1) * limit;

		const clauses = ["is_active = TRUE"];
		const params = [];

		if (search) {
			params.push(`%${search}%`);
			const idx = params.length;
			clauses.push(`(LOWER(name) LIKE $${idx} OR LOWER(COALESCE(designation,'')) LIKE $${idx} OR LOWER(COALESCE(department,'')) LIKE $${idx})`);
		}
		if (dept) { params.push(dept); clauses.push(`LOWER(COALESCE(department,'')) = $${params.length}`); }
		if (school) { params.push(school); clauses.push(`LOWER(COALESCE(school,'')) = $${params.length}`); }

		const where = clauses.join(" AND ");
		const countRes = await query(`SELECT COUNT(*)::INT AS total FROM faculty_profiles WHERE ${where}`, params);
		const total = Number(countRes.rows[0]?.total || 0);

		const rp = [...params, limit, offset];
		const result = await query(
			`SELECT id, name, designation, department, school, email, phone, image_url, specialization, experience_years, publications_count
			 FROM faculty_profiles WHERE ${where} ORDER BY name ASC LIMIT $${rp.length - 1} OFFSET $${rp.length}`, rp
		);

		return successResponse(res, "Faculty listing fetched", {
			items: result.rows.map((r) => ({
				id: r.id, name: r.name, designation: r.designation || "", department: r.department || "",
				school: r.school || "", email: r.email || "", phone: r.phone || "",
				image_url: r.image_url || "", specialization: r.specialization || "",
				experience_years: Number(r.experience_years) || 0, publications: Number(r.publications_count) || 0,
			})),
			pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
		});
	} catch (error) {
		return errorResponse(res, "Failed to fetch faculty listing", [{ field: "faculty", message: error.message }], 500);
	}
});

// Public: get single faculty full profile
router.get("/faculty/:id/public", async (req, res) => {
	try {
		await ensureFacultyContext();
		const id = normalize(req.params?.id);
		if (!id) return errorResponse(res, "Faculty id is required", [], 400);

		const result = await query(`SELECT ${FULL_SELECT} FROM faculty_profiles WHERE id = $1 AND is_active = TRUE LIMIT 1`, [id]);
		if (!result.rows.length) return errorResponse(res, "Faculty not found", [], 404);

		return successResponse(res, "Faculty profile fetched", mapFacultyFull(result.rows[0]));
	} catch (error) {
		return errorResponse(res, "Failed to fetch faculty profile", [{ field: "faculty", message: error.message }], 500);
	}
});

/* ═══════════════════════════════════════════════════════════════
   FACULTY SELF-SERVICE ENDPOINTS (faculty role required)
   ═══════════════════════════════════════════════════════════════ */

// Faculty: get own profile
router.get("/faculty/me/profile", authenticate, authorize(ROLES.FACULTY), async (req, res) => {
	try {
		await ensureFacultyContext();

		// Find linked faculty profile via users table
		const userResult = await query(`SELECT linked_faculty_id FROM users WHERE id = $1 LIMIT 1`, [req.user.sub]);
		const linkedId = normalize(userResult.rows[0]?.linked_faculty_id);
		if (!linkedId) return errorResponse(res, "No faculty profile linked to your account", [{ field: "linkedFacultyId", message: "Contact admin to link your faculty profile" }], 404);

		const result = await query(`SELECT ${FULL_SELECT} FROM faculty_profiles WHERE id = $1 LIMIT 1`, [linkedId]);
		if (!result.rows.length) return errorResponse(res, "Faculty profile not found", [], 404);

		return successResponse(res, "Your faculty profile fetched", mapFacultyFull(result.rows[0]));
	} catch (error) {
		return errorResponse(res, "Failed to fetch your profile", [{ field: "faculty", message: error.message }], 500);
	}
});

// Faculty: update own profile
router.put("/faculty/me/profile", authenticate, authorize(ROLES.FACULTY), async (req, res) => {
	try {
		await ensureFacultyContext();

		const userResult = await query(`SELECT linked_faculty_id FROM users WHERE id = $1 LIMIT 1`, [req.user.sub]);
		const linkedId = normalize(userResult.rows[0]?.linked_faculty_id);
		if (!linkedId) return errorResponse(res, "No faculty profile linked", [], 404);

		const b = req.body || {};
		const result = await query(
			`UPDATE faculty_profiles SET
				name = COALESCE(NULLIF(TRIM($2), ''), name),
				designation = $3, specialization = $4, experience_years = $5,
				publications_count = $6, education = $7, short_bio = $8, full_bio = $9,
				office = $10, image_url = $11, faculty_url = $12, cv_link = $13,
				google_scholar = $14, orcid = $15, phone = $16,
				tags = $17::jsonb, research_areas = $18::jsonb, tab_data = $19::jsonb,
				updated_by = $20, updated_at = NOW()
			WHERE id = $1
			RETURNING ${FULL_SELECT}`,
			[
				linkedId,
				normalize(b.name),
				normalize(b.designation),
				normalize(b.specialization),
				toSafeInt(b.experience_years, 0),
				toSafeInt(b.publications, 0),
				normalize(b.education),
				normalize(b.shortBio),
				normalize(b.fullBio),
				normalize(b.office),
				normalize(b.image_url),
				normalize(b.faculty_url),
				normalize(b.cv),
				normalize(b.googleScholar),
				normalize(b.orcid),
				normalize(b.phone),
				JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
				JSON.stringify(Array.isArray(b.researchAreas) ? b.researchAreas : []),
				JSON.stringify(b.tabData && typeof b.tabData === "object" ? b.tabData : {}),
				Number(req.user?.sub) || null,
			]
		);

		if (!result.rows.length) return errorResponse(res, "Faculty profile not found", [], 404);
		return successResponse(res, "Profile updated successfully", mapFacultyFull(result.rows[0]));
	} catch (error) {
		return errorResponse(res, "Failed to update profile", [{ field: "faculty", message: error.message }], 500);
	}
});

/* ═══════════════════════════════════════════════════════════════
   ADMIN ENDPOINTS (super_admin role required)
   ═══════════════════════════════════════════════════════════════ */

const adminAuth = [authenticate, authorize(ROLES.SUPER_ADMIN, ROLES.SCHOOL)];

// Admin: list faculty
router.get("/admin/faculty", adminAuth, async (req, res) => {
	try {
		await ensureFacultyContext();

		const queryText = normalize(req.query?.query).toLowerCase();
		const department = normalize(req.query?.department).toLowerCase();
		const school = normalize(req.query?.school).toLowerCase();
		const status = normalize(req.query?.status).toLowerCase();
		const page = toSafeInt(req.query?.page, 1);
		const limit = clamp(toSafeInt(req.query?.limit, 20), 1, 100);
		const offset = (page - 1) * limit;

		const clauses = ["1 = 1"];
		const params = [];

		if (req.user?.role === ROLES.SCHOOL) {
			const userSchoolCode = normalize(req.user?.schoolCode).toLowerCase();
			params.push(userSchoolCode);
			clauses.push(`(LOWER(COALESCE(school_code,'')) = $${params.length} OR LOWER(COALESCE(school,'')) = $${params.length})`);
		} else {
			const school = normalize(req.query?.school).toLowerCase();
			if (school) { 
				params.push(school); 
				clauses.push(`(LOWER(COALESCE(school_code,'')) = $${params.length} OR LOWER(COALESCE(school,'')) = $${params.length})`); 
			}
		}

		if (queryText) {
			params.push(`%${queryText}%`);
			const idx = params.length;
			clauses.push(`(LOWER(name) LIKE $${idx} OR LOWER(COALESCE(designation,'')) LIKE $${idx} OR LOWER(COALESCE(department,'')) LIKE $${idx} OR LOWER(COALESCE(school,'')) LIKE $${idx} OR LOWER(COALESCE(email,'')) LIKE $${idx} OR LOWER(COALESCE(phone,'')) LIKE $${idx} OR LOWER(id) LIKE $${idx})`);
		}
		if (department) { params.push(department); clauses.push(`LOWER(COALESCE(department,'')) = $${params.length}`); }
		if (status === "active" || status === "inactive") { params.push(status === "active"); clauses.push(`is_active = $${params.length}`); }

		const whereClause = clauses.join(" AND ");
		const countResult = await query(`SELECT COUNT(*)::INT AS total FROM faculty_profiles WHERE ${whereClause}`, params);
		const total = Number(countResult.rows[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit));
		const resultParams = [...params, limit, offset];

		const result = await query(
			`SELECT id, name, designation, department, school, email, phone, is_active, created_at, updated_at
			FROM faculty_profiles WHERE ${whereClause} ORDER BY created_at DESC, id DESC
			LIMIT $${resultParams.length - 1} OFFSET $${resultParams.length}`, resultParams
		);

		return successResponse(res, "Faculty profiles fetched successfully", {
			items: result.rows.map(mapFacultyBasic),
			pagination: { page, limit, total, totalPages },
		});
	} catch (error) {
		return errorResponse(res, "Failed to fetch faculty profiles", [{ field: "faculty", message: error.message }], 500);
	}
});

// Admin: get single faculty full profile
router.get("/admin/faculty/:id", adminAuth, async (req, res) => {
	try {
		await ensureFacultyContext();
		const id = normalize(req.params?.id);
		if (!id) return errorResponse(res, "Faculty id required", [], 400);

		const result = await query(`SELECT ${FULL_SELECT} FROM faculty_profiles WHERE id = $1 LIMIT 1`, [id]);
		if (!result.rows.length) return errorResponse(res, "Faculty not found", [], 404);

		if (req.user?.role === ROLES.SCHOOL) {
			const userSchoolCode = normalize(req.user?.schoolCode).toLowerCase();
			const facSchoolCode = normalize(result.rows[0].school_code).toLowerCase();
			const facSchoolName = normalize(result.rows[0].school).toLowerCase();
			if (userSchoolCode && facSchoolCode !== userSchoolCode && facSchoolName !== userSchoolCode) {
				return errorResponse(res, "Forbidden", [{ field: "school", message: "You do not have permission for this faculty" }], 403);
			}
		}

		return successResponse(res, "Faculty profile fetched", mapFacultyFull(result.rows[0]));
	} catch (error) {
		return errorResponse(res, "Failed to fetch faculty", [{ field: "faculty", message: error.message }], 500);
	}
});

// Admin: create faculty
router.post("/admin/faculty", adminAuth, async (req, res) => {
	try {
		await ensureFacultyContext();

		const id = normalize(req.body?.id) || `faculty-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
		const name = normalize(req.body?.name);
		if (!name) return errorResponse(res, "Validation failed", [{ field: "name", message: "Faculty name is required" }], 400);

		const b = req.body || {};
		if (req.user?.role === ROLES.SCHOOL) {
			b.school = normalize(req.user?.schoolCode) || b.school;
		}
		
		const targetSchool = normalize(b.school);
		const targetSchoolCode = targetSchool.toLowerCase() === 'soict' || targetSchool.toLowerCase().includes('information') ? 'soict' : targetSchool;

		const result = await query(
			`INSERT INTO faculty_profiles (
				id, name, designation, department, school, school_code, email, phone, is_active,
				specialization, experience_years, publications_count, education,
				short_bio, full_bio, office, image_url, faculty_url, cv_link,
				google_scholar, orcid, tags, research_areas, tab_data,
				created_by, updated_by, updated_at
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23::jsonb,$24,$24,NOW())
			RETURNING ${FULL_SELECT}`,
			[
				id, name, normalize(b.designation), normalize(b.department), targetSchool, targetSchoolCode,
				normalize(b.email).toLowerCase(), normalize(b.phone), b.isActive !== false,
				normalize(b.specialization), toSafeInt(b.experience_years, 0), toSafeInt(b.publications, 0),
				normalize(b.education), normalize(b.shortBio), normalize(b.fullBio),
				normalize(b.office), normalize(b.image_url), normalize(b.faculty_url),
				normalize(b.cv), normalize(b.googleScholar), normalize(b.orcid),
				JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
				JSON.stringify(Array.isArray(b.researchAreas) ? b.researchAreas : []),
				JSON.stringify(b.tabData && typeof b.tabData === "object" ? b.tabData : {}),
				Number(req.user?.sub) || null,
			]
		);

		return successResponse(res, "Faculty profile created successfully", mapFacultyFull(result.rows[0]), 201);
	} catch (error) {
		if (error.code === "23505") {
			const field = String(error.constraint || "").includes("email") ? "email" : "id";
			return errorResponse(res, "Duplicate faculty profile", [{ field, message: `${field} already exists` }], 409);
		}
		return errorResponse(res, "Failed to create faculty profile", [{ field: "faculty", message: error.message }], 500);
	}
});

// Admin: update faculty
router.put("/admin/faculty/:id", adminAuth, async (req, res) => {
	try {
		await ensureFacultyContext();

		const id = normalize(req.params?.id);
		const name = normalize(req.body?.name);
		if (!id || !name) return errorResponse(res, "Validation failed", [{ field: "id", message: "Faculty id is required" }, { field: "name", message: "Faculty name is required" }], 400);

		const checkRes = await query(`SELECT school_code, school FROM faculty_profiles WHERE id = $1 LIMIT 1`, [id]);
		if (!checkRes.rows.length) return errorResponse(res, "Faculty not found", [], 404);
		
		if (req.user?.role === ROLES.SCHOOL) {
			const userSchoolCode = normalize(req.user?.schoolCode).toLowerCase();
			const facSchoolCode = normalize(checkRes.rows[0].school_code).toLowerCase();
			const facSchoolName = normalize(checkRes.rows[0].school).toLowerCase();
			if (userSchoolCode && facSchoolCode !== userSchoolCode && facSchoolName !== userSchoolCode) {
				return errorResponse(res, "Forbidden", [{ field: "school", message: "You do not have permission for this faculty" }], 403);
			}
		}

		const b = req.body || {};
		if (req.user?.role === ROLES.SCHOOL) {
			b.school = normalize(req.user?.schoolCode) || b.school;
		}

		const targetSchool = normalize(b.school);
		const targetSchoolCode = targetSchool.toLowerCase() === 'soict' || targetSchool.toLowerCase().includes('information') ? 'soict' : targetSchool;

		const result = await query(
			`UPDATE faculty_profiles SET
				name=$2, designation=$3, department=$4, school=$5, school_code=$6, email=$7, phone=$8, is_active=$9,
				specialization=$10, experience_years=$11, publications_count=$12, education=$13,
				short_bio=$14, full_bio=$15, office=$16, image_url=$17, faculty_url=$18, cv_link=$19,
				google_scholar=$20, orcid=$21, tags=$22::jsonb, research_areas=$23::jsonb, tab_data=$24::jsonb,
				updated_by=$25, updated_at=NOW()
			WHERE id=$1 RETURNING ${FULL_SELECT}`,
			[
				id, name, normalize(b.designation), normalize(b.department), targetSchool, targetSchoolCode,
				normalize(b.email).toLowerCase(), normalize(b.phone), b.isActive !== false,
				normalize(b.specialization), toSafeInt(b.experience_years, 0), toSafeInt(b.publications, 0),
				normalize(b.education), normalize(b.shortBio), normalize(b.fullBio),
				normalize(b.office), normalize(b.image_url), normalize(b.faculty_url),
				normalize(b.cv), normalize(b.googleScholar), normalize(b.orcid),
				JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
				JSON.stringify(Array.isArray(b.researchAreas) ? b.researchAreas : []),
				JSON.stringify(b.tabData && typeof b.tabData === "object" ? b.tabData : {}),
				Number(req.user?.sub) || null,
			]
		);

		if (!result.rows.length) return errorResponse(res, "Faculty not found", [{ field: "id", message: "Faculty profile does not exist" }], 404);
		return successResponse(res, "Faculty profile updated successfully", mapFacultyFull(result.rows[0]));
	} catch (error) {
		if (error.code === "23505") return errorResponse(res, "Duplicate", [{ field: "email", message: "email already exists" }], 409);
		return errorResponse(res, "Failed to update faculty", [{ field: "faculty", message: error.message }], 500);
	}
});

// Admin: delete faculty
router.delete("/admin/faculty/:id", adminAuth, async (req, res) => {
	try {
		await ensureFacultyContext();
		const id = normalize(req.params?.id);
		if (!id) return errorResponse(res, "Validation failed", [{ field: "id", message: "Faculty id is required" }], 400);

		const checkRes = await query(`SELECT school_code, school FROM faculty_profiles WHERE id = $1 LIMIT 1`, [id]);
		if (!checkRes.rows.length) return errorResponse(res, "Faculty not found", [], 404);
		
		if (req.user?.role === ROLES.SCHOOL) {
			const userSchoolCode = normalize(req.user?.schoolCode).toLowerCase();
			const facSchoolCode = normalize(checkRes.rows[0].school_code).toLowerCase();
			const facSchoolName = normalize(checkRes.rows[0].school).toLowerCase();
			if (userSchoolCode && facSchoolCode !== userSchoolCode && facSchoolName !== userSchoolCode) {
				return errorResponse(res, "Forbidden", [{ field: "school", message: "You do not have permission for this faculty" }], 403);
			}
		}

		const linkedResult = await query(
			`SELECT id FROM users WHERE role = $1 AND LOWER(COALESCE(linked_faculty_id,'')) = LOWER($2) LIMIT 1`,
			[ROLES.FACULTY, id]
		);
		if (linkedResult.rows.length) return errorResponse(res, "Cannot delete faculty profile", [{ field: "linkedFacultyId", message: "Delete linked faculty login account first" }], 409);

		const result = await query(`DELETE FROM faculty_profiles WHERE id = $1 RETURNING id`, [id]);
		if (!result.rows.length) return errorResponse(res, "Faculty not found", [{ field: "id", message: "Faculty profile does not exist" }], 404);

		return successResponse(res, "Faculty profile deleted successfully", { id: result.rows[0].id });
	} catch (error) {
		return errorResponse(res, "Failed to delete faculty", [{ field: "faculty", message: error.message }], 500);
	}
});

// Admin/School: Generate password for faculty
router.post("/admin/faculty/:id/generate-password", authenticate, authorize(ROLES.SUPER_ADMIN, ROLES.SCHOOL), async (req, res) => {
	try {
		await ensureFacultyContext();
		const id = normalize(req.params?.id);
		if (!id) return errorResponse(res, "Faculty id is required", [], 400);

		const facultyRes = await query(`SELECT * FROM faculty_profiles WHERE id = $1 LIMIT 1`, [id]);
		if (!facultyRes.rows.length) return errorResponse(res, "Faculty not found", [], 404);
		const faculty = facultyRes.rows[0];

		if (req.user?.role === ROLES.SCHOOL) {
			const userSchoolCode = normalize(req.user?.schoolCode).toLowerCase();
			const facSchoolCode = normalize(faculty.school_code).toLowerCase();
			const facSchoolName = normalize(faculty.school).toLowerCase();
			if (userSchoolCode && facSchoolCode !== userSchoolCode && facSchoolName !== userSchoolCode) {
				return errorResponse(res, "Forbidden", [{ field: "school", message: "You do not have permission for this faculty" }], 403);
			}
		}

		const userRes = await query(`SELECT id FROM users WHERE linked_faculty_id = $1 LIMIT 1`, [id]);
		if (userRes.rows.length) {
			return errorResponse(res, "Account already generated", [{ field: "password", message: "Password has already been generated" }], 400);
		}

		const bcrypt = require('bcryptjs');
		const firstName = faculty.name.split(' ')[0];
		const currentYear = new Date().getFullYear();
		const plainPassword = `${firstName}${currentYear}`;
		const passwordHash = await bcrypt.hash(plainPassword, 10);

		const username = faculty.email.split('@')[0];
		await query(
			`INSERT INTO users (username, email, name, role, password_hash, linked_faculty_id, linked_school_code, force_password_reset) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE) RETURNING id`,
			[username, faculty.email, faculty.name, ROLES.FACULTY, passwordHash, id, faculty.school_code]
		);

		return successResponse(res, "Password generated successfully", { password: plainPassword });
	} catch (error) {
		return errorResponse(res, "Failed to generate password", [{ field: "faculty", message: error.message }], 500);
	}
});

module.exports = router;
