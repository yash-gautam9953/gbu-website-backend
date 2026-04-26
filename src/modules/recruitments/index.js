const express = require("express");
const { query, getDbPool } = require("../../config/db");
const { successResponse, errorResponse } = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");
const ROLES = require("../../constants/roles");

const router = express.Router();
const CACHE_TTL_MS = Number.parseInt(
  process.env.API_CACHE_TTL_MS || "60000",
  10,
);
const RESPONSE_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=120";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const recruitmentsCacheByKey = new Map();

const hasOwn = (payload, key) =>
  Object.prototype.hasOwnProperty.call(payload || {}, key);

const clearRecruitmentsCache = () => {
  recruitmentsCacheByKey.clear();
};

const parsePositiveId = (value) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
};

const parseBoolean = (value, fallback) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no"].includes(normalized)) {
      return false;
    }
  }

  return fallback;
};

const getRecruitmentById = async (executor, id) => {
  const result = await executor.query(
    `
    SELECT
      r.id,
      r.title,
      r.description,
      r.reference_no,
      r.category,
      r.tab_id,
      r.published_date,
      r.closing_date,
      EXTRACT(YEAR FROM COALESCE(r.closing_date, r.published_date))::int AS year,
      (r.closing_date IS NOT NULL AND r.closing_date < CURRENT_DATE) AS is_archived,
      CASE
        WHEN r.closing_date IS NOT NULL AND r.closing_date < CURRENT_DATE THEN 'archived'
        ELSE 'current'
      END AS status,
      r.created_at,
      r.updated_at,
      COALESCE(
        json_agg(
          json_build_object(
            'id', d.id,
            'name', d.name,
            'documentType', d.document_type,
            'url', d.file_url,
            'description', d.description,
            'sortOrder', d.sort_order
          )
          ORDER BY d.sort_order ASC, d.id ASC
        ) FILTER (WHERE d.id IS NOT NULL),
        '[]'::json
      ) AS documents
    FROM recruitments r
    LEFT JOIN recruitment_documents d
      ON d.recruitment_id = r.id
      AND d.is_active = TRUE
    WHERE r.id = $1
    GROUP BY r.id
    LIMIT 1
    `,
    [id],
  );

  return result.rows[0] || null;
};

const normalizeDocuments = (rawDocuments) => {
  if (rawDocuments === undefined) {
    return { hasValue: false, value: [] };
  }

  if (!Array.isArray(rawDocuments)) {
    return {
      hasValue: true,
      error: {
        field: "documents",
        message: "documents must be an array",
      },
      value: [],
    };
  }

  const normalized = [];
  const errors = [];

  rawDocuments.forEach((item, index) => {
    const name = String(item?.name || "").trim();
    const documentType = String(item?.documentType || "").trim();
    const url = String(item?.url || "").trim();

    if (!name) {
      errors.push({
        field: `documents[${index}].name`,
        message: "name is required",
      });
    }
    if (!documentType) {
      errors.push({
        field: `documents[${index}].documentType`,
        message: "documentType is required",
      });
    }
    if (!url) {
      errors.push({
        field: `documents[${index}].url`,
        message: "url is required",
      });
    }

    const parsedSortOrder = Number.parseInt(item?.sortOrder, 10);
    const sortOrder =
      Number.isFinite(parsedSortOrder) && parsedSortOrder > 0
        ? parsedSortOrder
        : index + 1;

    normalized.push({
      name,
      documentType,
      url,
      description: item?.description || null,
      sortOrder,
      isActive: parseBoolean(item?.isActive, true),
    });
  });

  if (errors.length) {
    return { hasValue: true, errors, value: [] };
  }

  return { hasValue: true, value: normalized };
};

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toBool = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes")
    return true;
  if (normalized === "false" || normalized === "0" || normalized === "no")
    return false;
  return fallback;
};

const toDateOnlyString = (value) => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
};

const mapRecruitmentRow = (row) => {
  const closingDate = toDateOnlyString(row.closing_date);
  const publishedDate = toDateOnlyString(row.published_date);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    referenceNo: row.reference_no,
    category: row.category,
    tabId: row.tab_id,
    publishedDate,
    closingDate,
    year: row.year,
    isArchived: row.is_archived,
    status: row.status,
    documents: Array.isArray(row.documents) ? row.documents : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const groupItemsByCategory = (items) => {
  return items.reduce((accumulator, item) => {
    const key = item.category || "others";
    if (!accumulator[key]) {
      accumulator[key] = [];
    }
    accumulator[key].push(item);
    return accumulator;
  }, {});
};

const groupItemsByYear = (items) => {
  return items.reduce((accumulator, item) => {
    const key = String(item.year || "unknown");
    if (!accumulator[key]) {
      accumulator[key] = [];
    }
    accumulator[key].push(item);
    return accumulator;
  }, {});
};

const listRecruitments = async (req, res) => {
  try {
    const page = toPositiveInt(req.query.page, 1);
    const limit = Math.min(
      toPositiveInt(req.query.limit, DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    const offset = (page - 1) * limit;
    const status = String(req.query.status || "all")
      .trim()
      .toLowerCase();
    const includeGrouped = toBool(req.query.grouped, false);

    const statusFilterSql =
      status === "current"
        ? "AND (r.closing_date IS NULL OR r.closing_date >= CURRENT_DATE)"
        : status === "archived"
          ? "AND (r.closing_date IS NOT NULL AND r.closing_date < CURRENT_DATE)"
          : "";

    const cacheKey = JSON.stringify({ page, limit, status, includeGrouped });
    const cached = recruitmentsCacheByKey.get(cacheKey);

    if (cached && Date.now() < cached.expiresAt) {
      res.set("Cache-Control", RESPONSE_CACHE_CONTROL);
      return successResponse(
        res,
        "Recruitments fetched successfully",
        cached.payload,
      );
    }

    const totalCountResult = await query(
      `
      SELECT COUNT(*)::int AS total
      FROM recruitments r
      WHERE r.is_active = TRUE
      ${statusFilterSql}
      `,
    );

    const total = totalCountResult.rows[0]?.total || 0;
    const pages = total === 0 ? 1 : Math.ceil(total / limit);
    const safePage = Math.min(page, pages);
    const safeOffset = (safePage - 1) * limit;

    const result = await query(
      `
			SELECT
				r.id,
				r.title,
				r.description,
				r.reference_no,
				r.category,
				r.tab_id,
				r.published_date,
				r.closing_date,
        EXTRACT(YEAR FROM COALESCE(r.closing_date, r.published_date))::int AS year,
        (r.closing_date IS NOT NULL AND r.closing_date < CURRENT_DATE) AS is_archived,
        CASE
          WHEN r.closing_date IS NOT NULL AND r.closing_date < CURRENT_DATE THEN 'archived'
          ELSE 'current'
        END AS status,
				r.created_at,
				r.updated_at,
				COALESCE(
					json_agg(
						json_build_object(
							'id', d.id,
							'name', d.name,
							'documentType', d.document_type,
							'url', d.file_url,
							'description', d.description,
							'sortOrder', d.sort_order
						)
						ORDER BY d.sort_order ASC, d.id ASC
					) FILTER (WHERE d.id IS NOT NULL),
					'[]'::json
				) AS documents
			FROM recruitments r
			LEFT JOIN recruitment_documents d
				ON d.recruitment_id = r.id
				AND d.is_active = TRUE
      WHERE r.is_active = TRUE
			${statusFilterSql}
			GROUP BY r.id
			ORDER BY r.closing_date DESC NULLS LAST, r.published_date DESC NULLS LAST, r.id DESC
			LIMIT $1 OFFSET $2
			`,
      [limit, safeOffset],
    );

    const items = result.rows.map(mapRecruitmentRow);

    const payload = {
      items,
      meta: {
        page: safePage,
        limit,
        total,
        pages,
        offset: safeOffset,
      },
    };

    if (includeGrouped) {
      const current = items.filter((item) => item.status === "current");
      const archived = items.filter((item) => item.status === "archived");

      payload.current = current;
      payload.archived = archived;
      payload.currentByCategory = groupItemsByCategory(current);
      payload.archivedByYear = groupItemsByYear(archived);
      payload.meta.currentCount = current.length;
      payload.meta.archivedCount = archived.length;
    }

    recruitmentsCacheByKey.set(cacheKey, {
      payload,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    res.set("Cache-Control", RESPONSE_CACHE_CONTROL);

    return successResponse(res, "Recruitments fetched successfully", payload);
  } catch (error) {
    if (error.code === "42P01") {
      return successResponse(res, "Recruitments fetched successfully", {
        items: [],
        current: [],
        archived: [],
        currentByCategory: {},
        archivedByYear: {},
        meta: {
          total: 0,
          currentCount: 0,
          archivedCount: 0,
        },
      });
    }

    return errorResponse(
      res,
      "Failed to fetch recruitments",
      [{ field: "recruitments", message: error.message }],
      500,
    );
  }
};

router.post(
  "/recruitments",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const {
      title,
      description,
      referenceNo,
      category,
      tabId,
      publishedDate,
      closingDate,
      isActive,
      documents,
    } = req.body;

    const validationErrors = [];

    if (!String(title || "").trim()) {
      validationErrors.push({ field: "title", message: "title is required" });
    }
    if (!String(referenceNo || "").trim()) {
      validationErrors.push({
        field: "referenceNo",
        message: "referenceNo is required",
      });
    }
    if (!String(category || "").trim()) {
      validationErrors.push({
        field: "category",
        message: "category is required",
      });
    }
    if (!String(tabId || "").trim()) {
      validationErrors.push({ field: "tabId", message: "tabId is required" });
    }
    if (!String(closingDate || "").trim()) {
      validationErrors.push({
        field: "closingDate",
        message: "closingDate is required",
      });
    }

    const parsedClosingDate = toDateOnlyString(closingDate);
    if (String(closingDate || "").trim() && !parsedClosingDate) {
      validationErrors.push({
        field: "closingDate",
        message: "closingDate must be a valid date",
      });
    }

    const parsedPublishedDate = publishedDate
      ? toDateOnlyString(publishedDate)
      : toDateOnlyString(new Date());
    if (publishedDate && !parsedPublishedDate) {
      validationErrors.push({
        field: "publishedDate",
        message: "publishedDate must be a valid date",
      });
    }

    const normalizedDocuments = normalizeDocuments(documents);
    if (normalizedDocuments.error) {
      validationErrors.push(normalizedDocuments.error);
    }
    if (normalizedDocuments.errors?.length) {
      validationErrors.push(...normalizedDocuments.errors);
    }

    if (validationErrors.length) {
      return errorResponse(res, "Validation failed", validationErrors, 400);
    }

    const client = await getDbPool().connect();

    try {
      await client.query("BEGIN");

      const insertResult = await client.query(
        `
        INSERT INTO recruitments (
          title,
          description,
          reference_no,
          category,
          tab_id,
          published_date,
          closing_date,
          is_active
        ) VALUES (
          $1, $2, $3, $4, $5, $6::date, $7::date, $8
        )
        RETURNING id
        `,
        [
          String(title).trim(),
          description || null,
          String(referenceNo).trim(),
          String(category).trim(),
          String(tabId).trim(),
          parsedPublishedDate,
          parsedClosingDate,
          parseBoolean(isActive, true),
        ],
      );

      const recruitmentId = insertResult.rows[0]?.id;

      if (normalizedDocuments.hasValue && normalizedDocuments.value.length) {
        for (const item of normalizedDocuments.value) {
          await client.query(
            `
            INSERT INTO recruitment_documents (
              recruitment_id,
              name,
              document_type,
              file_url,
              description,
              sort_order,
              is_active
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            `,
            [
              recruitmentId,
              item.name,
              item.documentType,
              item.url,
              item.description,
              item.sortOrder,
              item.isActive,
            ],
          );
        }
      }

      const createdRow = await getRecruitmentById(client, recruitmentId);

      await client.query("COMMIT");
      clearRecruitmentsCache();

      return successResponse(
        res,
        "Recruitment created successfully",
        mapRecruitmentRow(createdRow),
        201,
      );
    } catch (error) {
      await client.query("ROLLBACK");

      if (error.code === "23505") {
        return errorResponse(
          res,
          "Recruitment already exists",
          [
            {
              field: "referenceNo",
              message: "referenceNo must be unique",
            },
          ],
          409,
        );
      }

      return errorResponse(
        res,
        "Failed to create recruitment",
        [{ field: "recruitment", message: error.message }],
        500,
      );
    } finally {
      client.release();
    }
  },
);

router.put(
  "/recruitments/:id",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const recruitmentId = parsePositiveId(req.params.id);

    if (!recruitmentId) {
      return errorResponse(
        res,
        "Validation failed",
        [{ field: "id", message: "Recruitment id must be a valid integer" }],
        400,
      );
    }

    const validationErrors = [];
    const updates = [];
    const values = [];

    if (hasOwn(req.body, "title")) {
      const title = String(req.body.title || "").trim();
      if (!title) {
        validationErrors.push({
          field: "title",
          message: "title cannot be empty",
        });
      } else {
        updates.push(`title = $${values.length + 1}`);
        values.push(title);
      }
    }

    if (hasOwn(req.body, "description")) {
      updates.push(`description = $${values.length + 1}`);
      values.push(req.body.description || null);
    }

    if (hasOwn(req.body, "referenceNo")) {
      const referenceNo = String(req.body.referenceNo || "").trim();
      if (!referenceNo) {
        validationErrors.push({
          field: "referenceNo",
          message: "referenceNo cannot be empty",
        });
      } else {
        updates.push(`reference_no = $${values.length + 1}`);
        values.push(referenceNo);
      }
    }

    if (hasOwn(req.body, "category")) {
      const category = String(req.body.category || "").trim();
      if (!category) {
        validationErrors.push({
          field: "category",
          message: "category cannot be empty",
        });
      } else {
        updates.push(`category = $${values.length + 1}`);
        values.push(category);
      }
    }

    if (hasOwn(req.body, "tabId")) {
      const tabId = String(req.body.tabId || "").trim();
      if (!tabId) {
        validationErrors.push({
          field: "tabId",
          message: "tabId cannot be empty",
        });
      } else {
        updates.push(`tab_id = $${values.length + 1}`);
        values.push(tabId);
      }
    }

    if (hasOwn(req.body, "publishedDate")) {
      const parsedPublishedDate = toDateOnlyString(req.body.publishedDate);
      if (!parsedPublishedDate) {
        validationErrors.push({
          field: "publishedDate",
          message: "publishedDate must be a valid date",
        });
      } else {
        updates.push(`published_date = $${values.length + 1}::date`);
        values.push(parsedPublishedDate);
      }
    }

    if (hasOwn(req.body, "closingDate")) {
      const parsedClosingDate = toDateOnlyString(req.body.closingDate);
      if (!parsedClosingDate) {
        validationErrors.push({
          field: "closingDate",
          message: "closingDate must be a valid date",
        });
      } else {
        updates.push(`closing_date = $${values.length + 1}::date`);
        values.push(parsedClosingDate);
      }
    }

    if (hasOwn(req.body, "isActive")) {
      updates.push(`is_active = $${values.length + 1}`);
      values.push(parseBoolean(req.body.isActive, true));
    }

    const normalizedDocuments = normalizeDocuments(req.body.documents);
    if (normalizedDocuments.error) {
      validationErrors.push(normalizedDocuments.error);
    }
    if (normalizedDocuments.errors?.length) {
      validationErrors.push(...normalizedDocuments.errors);
    }

    const hasDocumentUpdates = normalizedDocuments.hasValue;

    if (validationErrors.length) {
      return errorResponse(res, "Validation failed", validationErrors, 400);
    }

    if (!updates.length && !hasDocumentUpdates) {
      return errorResponse(
        res,
        "Validation failed",
        [
          {
            field: "payload",
            message: "At least one updatable field is required",
          },
        ],
        400,
      );
    }

    const client = await getDbPool().connect();

    try {
      await client.query("BEGIN");

      const existingResult = await client.query(
        `
        SELECT id
        FROM recruitments
        WHERE id = $1
        LIMIT 1
        `,
        [recruitmentId],
      );

      if (!existingResult.rows.length) {
        await client.query("ROLLBACK");
        return errorResponse(
          res,
          "Recruitment not found",
          [{ field: "id", message: "No recruitment found for this id" }],
          404,
        );
      }

      if (updates.length) {
        updates.push("updated_at = NOW()");
        values.push(recruitmentId);

        await client.query(
          `
          UPDATE recruitments
          SET ${updates.join(", ")}
          WHERE id = $${values.length}
          `,
          values,
        );
      }

      if (hasDocumentUpdates) {
        await client.query(
          `
          DELETE FROM recruitment_documents
          WHERE recruitment_id = $1
          `,
          [recruitmentId],
        );

        for (const item of normalizedDocuments.value) {
          await client.query(
            `
            INSERT INTO recruitment_documents (
              recruitment_id,
              name,
              document_type,
              file_url,
              description,
              sort_order,
              is_active
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            `,
            [
              recruitmentId,
              item.name,
              item.documentType,
              item.url,
              item.description,
              item.sortOrder,
              item.isActive,
            ],
          );
        }
      }

      const updatedRow = await getRecruitmentById(client, recruitmentId);

      await client.query("COMMIT");
      clearRecruitmentsCache();

      return successResponse(
        res,
        "Recruitment updated successfully",
        mapRecruitmentRow(updatedRow),
      );
    } catch (error) {
      await client.query("ROLLBACK");

      if (error.code === "23505") {
        return errorResponse(
          res,
          "Recruitment already exists",
          [
            {
              field: "referenceNo",
              message: "referenceNo must be unique",
            },
          ],
          409,
        );
      }

      return errorResponse(
        res,
        "Failed to update recruitment",
        [{ field: "recruitment", message: error.message }],
        500,
      );
    } finally {
      client.release();
    }
  },
);

router.get("/recruitments", listRecruitments);

module.exports = router;
