const express = require("express");
const { query } = require("../../config/db");
const { successResponse, errorResponse } = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");
const ROLES = require("../../constants/roles");

const router = express.Router();

const hasOwn = (payload, key) =>
  Object.prototype.hasOwnProperty.call(payload || {}, key);

const parsePositiveId = (value) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
};

router.get("/", async (req, res) => {
  try {
    const bookingsResult = await query(
      `
      SELECT
        id,
        start_time AS "startTime",
        end_time AS "endTime",
        purpose,
        organizing_dept AS "organizingDept",
        contact_email AS "contactEmail",
        contact_mobile AS "contactMobile"
      FROM booking_requests
      ORDER BY id DESC
      `,
    );

    return successResponse(
      res,
      "Bookings fetched successfully",
      bookingsResult.rows,
    );
  } catch (error) {
    if (error.code === "42P01") {
      return successResponse(res, "Bookings fetched successfully", []);
    }

    return errorResponse(
      res,
      "Failed to fetch bookings",
      [{ field: "booking", message: error.message }],
      500,
    );
  }
});

router.get("/test", (req, res) => {
  res.send("Booking route working");
});

router.post("/", async (req, res) => {
  const {
    startTime,
    endTime,
    purpose,
    organizingDept,
    contactEmail,
    contactMobile,
  } = req.body;

  if (!startTime || !endTime || !purpose || !organizingDept) {
    return errorResponse(
      res,
      "Validation failed",
      [
        { field: "startTime", message: "startTime is required" },
        { field: "endTime", message: "endTime is required" },
        { field: "purpose", message: "purpose is required" },
        { field: "organizingDept", message: "organizingDept is required" },
      ],
      400,
    );
  }

  try {
    const result = await query(
      `
      INSERT INTO booking_requests (
        start_time,
        end_time,
        purpose,
        organizing_dept,
        contact_email,
        contact_mobile
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
      `,
      [
        startTime,
        endTime,
        String(purpose).trim(),
        String(organizingDept).trim(),
        contactEmail || null,
        contactMobile || null,
      ],
    );

    return successResponse(res, "Booking request submitted successfully", {
      id: result.rows[0]?.id || null,
    });
  } catch (error) {
    if (error.code === "42P01") {
      // Keep endpoint non-breaking in environments where booking tables are pending migration.
      return successResponse(res, "Booking request received", {
        id: null,
        saved: false,
        reason: "booking_requests table is not available in current schema",
      });
    }

    return errorResponse(
      res,
      "Failed to submit booking request",
      [{ field: "booking", message: error.message }],
      500,
    );
  }
});

router.put(
  "/:id",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const bookingId = parsePositiveId(req.params.id);

    if (!bookingId) {
      return errorResponse(
        res,
        "Validation failed",
        [{ field: "id", message: "Booking id must be a valid integer" }],
        400,
      );
    }

    const updates = [];
    const values = [];
    const validationErrors = [];

    if (hasOwn(req.body, "startTime")) {
      if (!String(req.body.startTime || "").trim()) {
        validationErrors.push({
          field: "startTime",
          message: "startTime cannot be empty",
        });
      } else {
        updates.push(`start_time = $${values.length + 1}`);
        values.push(req.body.startTime);
      }
    }

    if (hasOwn(req.body, "endTime")) {
      if (!String(req.body.endTime || "").trim()) {
        validationErrors.push({
          field: "endTime",
          message: "endTime cannot be empty",
        });
      } else {
        updates.push(`end_time = $${values.length + 1}`);
        values.push(req.body.endTime);
      }
    }

    if (hasOwn(req.body, "purpose")) {
      const purpose = String(req.body.purpose || "").trim();
      if (!purpose) {
        validationErrors.push({
          field: "purpose",
          message: "purpose cannot be empty",
        });
      } else {
        updates.push(`purpose = $${values.length + 1}`);
        values.push(purpose);
      }
    }

    if (hasOwn(req.body, "organizingDept")) {
      const organizingDept = String(req.body.organizingDept || "").trim();
      if (!organizingDept) {
        validationErrors.push({
          field: "organizingDept",
          message: "organizingDept cannot be empty",
        });
      } else {
        updates.push(`organizing_dept = $${values.length + 1}`);
        values.push(organizingDept);
      }
    }

    if (hasOwn(req.body, "contactEmail")) {
      updates.push(`contact_email = $${values.length + 1}`);
      values.push(req.body.contactEmail || null);
    }

    if (hasOwn(req.body, "contactMobile")) {
      updates.push(`contact_mobile = $${values.length + 1}`);
      values.push(req.body.contactMobile || null);
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

    values.push(bookingId);

    try {
      const updateResult = await query(
        `
        UPDATE booking_requests
        SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING
          id,
          start_time AS "startTime",
          end_time AS "endTime",
          purpose,
          organizing_dept AS "organizingDept",
          contact_email AS "contactEmail",
          contact_mobile AS "contactMobile"
        `,
        values,
      );

      if (!updateResult.rows.length) {
        return errorResponse(
          res,
          "Booking not found",
          [{ field: "id", message: "No booking found for this id" }],
          404,
        );
      }

      return successResponse(
        res,
        "Booking updated successfully",
        updateResult.rows[0],
      );
    } catch (error) {
      if (error.code === "42P01") {
        return successResponse(res, "Booking update received", {
          id: bookingId,
          saved: false,
          reason: "booking_requests table is not available in current schema",
        });
      }

      return errorResponse(
        res,
        "Failed to update booking",
        [{ field: "booking", message: error.message }],
        500,
      );
    }
  },
);

module.exports = router;
