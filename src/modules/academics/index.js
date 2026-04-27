const express = require("express");
const { query } = require("../../config/db");
const { successResponse, errorResponse } = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");
const ROLES = require("../../constants/roles");

const router = express.Router();

const ensureAcademicsInfrastructure = async () => {
	await query(`
		CREATE TABLE IF NOT EXISTS schools (
			id SERIAL PRIMARY KEY,
			code VARCHAR(50) UNIQUE NOT NULL,
			name VARCHAR(255) NOT NULL,
			slug VARCHAR(255) UNIQUE NOT NULL,
			overview TEXT,
			is_active BOOLEAN DEFAULT true,
			content JSONB DEFAULT '{}'::jsonb,
			created_at TIMESTAMP DEFAULT NOW(),
			updated_at TIMESTAMP DEFAULT NOW()
		);
	`);

	await query(`ALTER TABLE schools ADD COLUMN IF NOT EXISTS content JSONB DEFAULT '{}'::jsonb;`);

	await query(`
		CREATE TABLE IF NOT EXISTS departments (
			id SERIAL PRIMARY KEY,
			school_id INT REFERENCES schools(id) ON DELETE CASCADE,
			code VARCHAR(50) NOT NULL,
			name VARCHAR(255) NOT NULL,
			slug VARCHAR(255) NOT NULL,
			about TEXT,
			is_active BOOLEAN DEFAULT true,
			created_at TIMESTAMP DEFAULT NOW(),
			updated_at TIMESTAMP DEFAULT NOW(),
			UNIQUE(school_id, code),
			UNIQUE(school_id, slug)
		);
	`);
};

const mapSchoolRow = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  slug: row.slug,
  overview: row.overview,
  content: row.content || {},
  isActive: row.is_active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  departmentCount: Number(row.department_count || 0),
});

router.get("/schools", async (req, res) => {
  try {
	await ensureAcademicsInfrastructure();
    const schoolsResult = await query(
      `
      SELECT
        s.id,
        s.code,
        s.name,
        s.slug,
        s.overview,
        s.content,
        s.is_active,
        s.created_at,
        s.updated_at,
        COUNT(d.id) AS department_count
      FROM schools s
      LEFT JOIN departments d ON d.school_id = s.id
      GROUP BY s.id
      ORDER BY s.name ASC
      `
    );

    return successResponse(
      res,
      "Schools fetched successfully",
      schoolsResult.rows.map(mapSchoolRow)
    );
  } catch (error) {
    if (error.code === "42P01") {
      return successResponse(res, "Schools fetched successfully", []);
    }

    return errorResponse(
      res,
      "Failed to fetch schools",
      [{ field: "schools", message: error.message }],
      500
    );
  }
});

router.get("/schools/:id", async (req, res) => {
  const { id } = req.params;

  try {
	await ensureAcademicsInfrastructure();
    const schoolResult = await query(
      `
      SELECT
        s.id,
        s.code,
        s.name,
        s.slug,
        s.overview,
        s.content,
        s.is_active,
        s.created_at,
        s.updated_at,
        COUNT(d.id) AS department_count
      FROM schools s
      LEFT JOIN departments d ON d.school_id = s.id
      WHERE s.id = $1
      GROUP BY s.id
      `,
      [id]
    );

    if (!schoolResult.rows.length) {
      return errorResponse(
        res,
        "School not found",
        [{ field: "id", message: "No school found for the provided id" }],
        404
      );
    }

    const departmentsResult = await query(
      `
      SELECT
        id,
        code,
        name,
        slug,
        about,
        is_active
      FROM departments
      WHERE school_id = $1
      ORDER BY name ASC
      `,
      [id]
    );

    return successResponse(res, "School fetched successfully", {
      ...mapSchoolRow(schoolResult.rows[0]),
      departments: departmentsResult.rows.map((department) => ({
        id: department.id,
        code: department.code,
        name: department.name,
        slug: department.slug,
        about: department.about,
        isActive: department.is_active,
      })),
    });
  } catch (error) {
    if (error.code === "42P01") {
      return errorResponse(
        res,
        "School not found",
        [{ field: "id", message: "No school found for the provided id" }],
        404
      );
    }

    return errorResponse(
      res,
      "Failed to fetch school details",
      [{ field: "school", message: error.message }],
      500
    );
  }
});

/* ═══════════════════════════════════════════════════════════════
   ADMIN ENDPOINTS
   ═══════════════════════════════════════════════════════════════ */

router.post("/admin/schools", authenticate, authorize(ROLES.SUPER_ADMIN), async (req, res) => {
	try {
		await ensureAcademicsInfrastructure();
		const { code, name, overview, content, is_active } = req.body;
		if (!code || !name) {
			return errorResponse(res, "Validation failed", [
				{ field: "code", message: "School code is required" },
				{ field: "name", message: "School name is required" },
			], 400);
		}

		const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
		const isActive = is_active !== undefined ? is_active : true;

		const result = await query(
			`
			INSERT INTO schools (code, name, slug, overview, content, is_active)
			VALUES ($1, $2, $3, $4, $5::jsonb, $6)
			RETURNING id, code, name, slug, overview, content, is_active, created_at, updated_at
			`,
			[code, name, slug, overview || null, JSON.stringify(content || {}), isActive]
		);

		return successResponse(res, "School created successfully", mapSchoolRow(result.rows[0]), 201);
	} catch (error) {
		if (error.code === '23505') {
			return errorResponse(res, "Duplicate school", [{ field: "school", message: "School code or slug already exists" }], 409);
		}
		return errorResponse(res, "Failed to create school", [{ field: "school", message: error.message }], 500);
	}
});

router.put("/admin/schools/:id", authenticate, authorize(ROLES.SUPER_ADMIN), async (req, res) => {
	try {
		await ensureAcademicsInfrastructure();
		const schoolId = Number(req.params.id);
		const { code, name, overview, content, is_active } = req.body;

		if (!code || !name) {
			return errorResponse(res, "Validation failed", [
				{ field: "code", message: "School code is required" },
				{ field: "name", message: "School name is required" },
			], 400);
		}

		const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
		const isActive = is_active !== undefined ? is_active : true;

		const result = await query(
			`
			UPDATE schools
			SET code = $1, name = $2, slug = $3, overview = $4, content = $5::jsonb, is_active = $6, updated_at = NOW()
			WHERE id = $7
			RETURNING id, code, name, slug, overview, content, is_active, created_at, updated_at
			`,
			[code, name, slug, overview || null, JSON.stringify(content || {}), isActive, schoolId]
		);

		if (!result.rows.length) {
			return errorResponse(res, "School not found", [], 404);
		}

		return successResponse(res, "School updated successfully", mapSchoolRow(result.rows[0]));
	} catch (error) {
		if (error.code === '23505') {
			return errorResponse(res, "Duplicate school", [{ field: "school", message: "School code or slug already exists" }], 409);
		}
		return errorResponse(res, "Failed to update school", [{ field: "school", message: error.message }], 500);
	}
});

router.delete("/admin/schools/:id", authenticate, authorize(ROLES.SUPER_ADMIN), async (req, res) => {
	try {
		await ensureAcademicsInfrastructure();
		const schoolId = Number(req.params.id);

		const result = await query(`DELETE FROM schools WHERE id = $1 RETURNING id`, [schoolId]);

		if (!result.rows.length) {
			return errorResponse(res, "School not found", [], 404);
		}

		return successResponse(res, "School deleted successfully", { id: schoolId });
	} catch (error) {
		return errorResponse(res, "Failed to delete school", [{ field: "school", message: error.message }], 500);
	}
});

module.exports = router;
