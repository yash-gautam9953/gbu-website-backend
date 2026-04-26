const express = require("express");
const { query } = require("../../config/db");
const { successResponse, errorResponse } = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");
const ROLES = require("../../constants/roles");

const router = express.Router();
const CACHE_TTL_MS = Number.parseInt(
  process.env.API_CACHE_TTL_MS || "60000",
  10,
);
const RESPONSE_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=120";

let tendersCache = {
  payload: null,
  expiresAt: 0,
};

const hasOwn = (payload, key) =>
  Object.prototype.hasOwnProperty.call(payload || {}, key);

const clearTendersCache = () => {
  tendersCache = {
    payload: null,
    expiresAt: 0,
  };
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

const buildDerivedTenderState = (row) => {
  const closingDate = toDateOnlyString(row.closing_date);
  const today = toDateOnlyString(new Date());
  const computedArchived = Boolean(closingDate && today && closingDate < today);
  const isArchived =
    typeof row.is_archived === "boolean" ? row.is_archived : computedArchived;

  return {
    isArchived,
    status: row.status || (isArchived ? "archived" : "current"),
  };
};

const getTenderById = async (id) => {
  const result = await query(
    `
    SELECT
      id,
      title,
      description,
      reference_no,
      category,
      tender_type,
      published_date,
      closing_date,
      document_url,
      is_active,
      (closing_date IS NOT NULL AND closing_date < CURRENT_DATE) AS is_archived,
      CASE
        WHEN closing_date IS NOT NULL AND closing_date < CURRENT_DATE THEN 'archived'
        ELSE 'current'
      END AS status,
      created_at,
      updated_at
    FROM tenders
    WHERE id = $1
    LIMIT 1
    `,
    [id],
  );

  return result.rows[0] || null;
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

const mapTenderRow = (row) => {
  const closingDate = toDateOnlyString(row.closing_date);
  const derived = buildDerivedTenderState(row);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    referenceNo: row.reference_no,
    category: row.category,
    tenderType: row.tender_type,
    publishedDate: toDateOnlyString(row.published_date),
    closingDate,
    documentUrl: row.document_url,
    isArchived: derived.isArchived,
    status: derived.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

router.post(
  "/tenders",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const {
      title,
      description,
      referenceNo,
      category,
      tenderType,
      publishedDate,
      closingDate,
      documentUrl,
      isActive,
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
    if (!String(closingDate || "").trim()) {
      validationErrors.push({
        field: "closingDate",
        message: "closingDate is required",
      });
    }
    if (!String(documentUrl || "").trim()) {
      validationErrors.push({
        field: "documentUrl",
        message: "documentUrl is required",
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

    if (validationErrors.length) {
      return errorResponse(res, "Validation failed", validationErrors, 400);
    }

    try {
      const insertResult = await query(
        `
        INSERT INTO tenders (
          title,
          description,
          reference_no,
          category,
          tender_type,
          published_date,
          closing_date,
          document_url,
          is_active
        ) VALUES (
          $1, $2, $3, $4, $5, $6::date, $7::date, $8, $9
        )
        RETURNING id
        `,
        [
          String(title).trim(),
          description || null,
          String(referenceNo).trim(),
          String(category || "General").trim() || "General",
          String(tenderType || "RFP").trim() || "RFP",
          parsedPublishedDate,
          parsedClosingDate,
          String(documentUrl).trim(),
          parseBoolean(isActive, true),
        ],
      );

      const createdId = insertResult.rows[0]?.id;
      const createdRow = await getTenderById(createdId);
      clearTendersCache();

      return successResponse(
        res,
        "Tender created successfully",
        mapTenderRow(createdRow),
        201,
      );
    } catch (error) {
      if (error.code === "23505") {
        return errorResponse(
          res,
          "Tender already exists",
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
        "Failed to create tender",
        [{ field: "tender", message: error.message }],
        500,
      );
    }
  },
);

router.put(
  "/tenders/:id",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const tenderId = parsePositiveId(req.params.id);

    if (!tenderId) {
      return errorResponse(
        res,
        "Validation failed",
        [{ field: "id", message: "Tender id must be a valid integer" }],
        400,
      );
    }

    const updates = [];
    const values = [];
    const validationErrors = [];

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
      updates.push(`category = $${values.length + 1}`);
      values.push(String(req.body.category || "General").trim() || "General");
    }

    if (hasOwn(req.body, "tenderType")) {
      const tenderType = String(req.body.tenderType || "").trim();
      if (!tenderType) {
        validationErrors.push({
          field: "tenderType",
          message: "tenderType cannot be empty",
        });
      } else {
        updates.push(`tender_type = $${values.length + 1}`);
        values.push(tenderType);
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

    if (hasOwn(req.body, "documentUrl")) {
      const documentUrl = String(req.body.documentUrl || "").trim();
      if (!documentUrl) {
        validationErrors.push({
          field: "documentUrl",
          message: "documentUrl cannot be empty",
        });
      } else {
        updates.push(`document_url = $${values.length + 1}`);
        values.push(documentUrl);
      }
    }

    if (hasOwn(req.body, "isActive")) {
      updates.push(`is_active = $${values.length + 1}`);
      values.push(parseBoolean(req.body.isActive, true));
    }

    if (validationErrors.length) {
      return errorResponse(res, "Validation failed", validationErrors, 400);
    }

    if (!updates.length) {
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

    updates.push("updated_at = NOW()");
    values.push(tenderId);

    try {
      const updateResult = await query(
        `
        UPDATE tenders
        SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING id
        `,
        values,
      );

      if (!updateResult.rows.length) {
        return errorResponse(
          res,
          "Tender not found",
          [{ field: "id", message: "No tender found for this id" }],
          404,
        );
      }

      const updatedRow = await getTenderById(tenderId);
      clearTendersCache();

      return successResponse(
        res,
        "Tender updated successfully",
        mapTenderRow(updatedRow),
      );
    } catch (error) {
      if (error.code === "23505") {
        return errorResponse(
          res,
          "Tender already exists",
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
        "Failed to update tender",
        [{ field: "tender", message: error.message }],
        500,
      );
    }
  },
);

router.get("/tenders", async (req, res) => {
  try {
    if (tendersCache.payload && Date.now() < tendersCache.expiresAt) {
      res.set("Cache-Control", RESPONSE_CACHE_CONTROL);
      return successResponse(
        res,
        "Tenders fetched successfully",
        tendersCache.payload,
      );
    }

    const result = await query(
      `
			SELECT
				id,
				title,
				description,
				reference_no,
				category,
				tender_type,
				published_date,
				closing_date,
				document_url,
        (closing_date IS NOT NULL AND closing_date < CURRENT_DATE) AS is_archived,
        CASE
          WHEN closing_date IS NOT NULL AND closing_date < CURRENT_DATE THEN 'archived'
          ELSE 'current'
        END AS status,
				created_at,
				updated_at
			FROM tenders
      WHERE is_active = TRUE
			ORDER BY closing_date ASC NULLS LAST, id DESC
			`,
    );

    const items = result.rows.map(mapTenderRow);
    const current = items.filter((item) => item.status === "current");
    const archived = items.filter((item) => item.status === "archived");

    const payload = {
      items,
      current,
      archived,
      meta: {
        total: items.length,
        currentCount: current.length,
        archivedCount: archived.length,
      },
    };

    tendersCache = {
      payload,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };

    res.set("Cache-Control", RESPONSE_CACHE_CONTROL);

    return successResponse(res, "Tenders fetched successfully", payload);
  } catch (error) {
    if (error.code === "42P01") {
      return successResponse(res, "Tenders fetched successfully", {
        items: [],
        current: [],
        archived: [],
        meta: {
          total: 0,
          currentCount: 0,
          archivedCount: 0,
        },
      });
    }

    return errorResponse(
      res,
      "Failed to fetch tenders",
      [{ field: "tenders", message: error.message }],
      500,
    );
  }
});

module.exports = router;
