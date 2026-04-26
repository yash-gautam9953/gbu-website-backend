const express = require("express");
const { query, getDbPool } = require("../../config/db");
const { successResponse, errorResponse } = require("../../utils/response");
const { getPagination } = require("../../utils/pagination");
const { authenticate, authorize } = require("../../middleware/auth");
const ROLES = require("../../constants/roles");

const router = express.Router();

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

const ANNOUNCEMENT_SORT_FIELDS = {
  date: "published_date",
  title: "title",
  category: "type",
  priority: "priority",
  views: "views",
};

const NEWS_SORT_FIELDS = {
  date: "published_date",
  title: "title",
  category: "category",
  priority: "priority",
  views: "views",
  likes: "likes",
};

const NEWSLETTER_SORT_FIELDS = {
  date: "published_date",
  title: "title",
  issueNumber: "issue_number",
  category: "category",
  views: "views",
};

const MEDIA_GALLERY_SORT_FIELDS = {
  date: "published_date",
  title: "title",
  category: "category",
  year: "year",
};

const EVENTS_SORT_FIELDS = {
  date: "e.date",
  title: "e.title",
  category: "e.type",
  attendees: "e.attendees",
  year: "e.year",
};

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
};

const normalizeOrder = (order) => {
  return String(order || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
};

const buildSortClause = ({ sortBy, order, sortFields, fallbackSortBy }) => {
  const selectedColumn = sortFields[sortBy] || sortFields[fallbackSortBy];
  const selectedOrder = normalizeOrder(order);
  if (!selectedColumn) {
    return "id DESC";
  }
  return `${selectedColumn} ${selectedOrder}, id DESC`;
};

const toDateOnlyString = (value) => {
  if (!value) {
    return null;
  }
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }
  return parsedDate.toISOString().slice(0, 10);
};

const parseTimeString = (value) => {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim();
  const isValid = /^([01]\d|2[0-3]):[0-5]\d$/.test(normalized);
  return isValid ? normalized : null;
};

const normalizeTags = (rawTags) => {
  if (rawTags === undefined || rawTags === null || rawTags === "") {
    return [];
  }
  const sourceItems = Array.isArray(rawTags)
    ? rawTags
    : String(rawTags)
        .split(",")
        .map((item) => item.trim());
  return [
    ...new Set(sourceItems.map((item) => item.toLowerCase()).filter(Boolean)),
  ];
};

const parseTagString = (tagText) => {
  if (!tagText) {
    return [];
  }

  if (Array.isArray(tagText)) {
    return tagText
      .map((item) => String(item).trim().toLowerCase())
      .filter(Boolean);
  }

  if (typeof tagText === "string") {
    const normalized = tagText.trim();
    if (!normalized) {
      return [];
    }

    if (normalized.startsWith("[") && normalized.endsWith("]")) {
      try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) {
          return parsed
            .map((item) => String(item).trim().toLowerCase())
            .filter(Boolean);
        }
      } catch (error) {
        // Fallback to comma split below.
      }
    }

    return normalized
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }

  return [];
};

const normalizeJsonArray = (rawValue) => {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return [];
  }

  if (Array.isArray(rawValue)) {
    return rawValue;
  }

  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return [];
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        return [];
      }
    }

    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const formatTimestampForApi = (value) => {
  if (!value) {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 19);
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
    const asIso = normalized.replace(" ", "T");
    return asIso.length === 16 ? `${asIso}:00` : asIso;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 19);
};

const parseTimestampInput = (value) => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 19).replace("T", " ");
};

const parseEventId = (value) => {
  if (!/^\d+$/.test(String(value || ""))) {
    return null;
  }
  return Number.parseInt(value, 10);
};

const hasOwn = (payload, key) =>
  Object.prototype.hasOwnProperty.call(payload || {}, key);

const toNonNegativeInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
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

const buildEventStartIso = (eventDate, eventTime) => {
  if (!eventDate) {
    return null;
  }

  const normalizedDate =
    toDateOnlyString(eventDate) ||
    (/^\d{4}-\d{2}-\d{2}$/.test(String(eventDate || ""))
      ? String(eventDate)
      : null);

  if (!normalizedDate) {
    return null;
  }

  const safeTime = parseTimeString(eventTime) || "00:00";
  return `${normalizedDate}T${safeTime}:00`;
};

const writeAuditLog = async (
  client,
  { actorUserId, action, resourceType, resourceId, requestId, metadata },
) => {
  try {
    await client.query(
      `
      INSERT INTO audit_logs (
        actor_user_id,
        action,
        resource_type,
        resource_id,
        request_id,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        actorUserId || null,
        action,
        resourceType,
        resourceId || null,
        requestId || null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  } catch (error) {
    if (error.code === "42P01") {
      return;
    }
    throw error;
  }
};

const appendCommonClauses = ({
  whereClauses,
  params,
  search,
  category,
  dateFrom,
  dateTo,
  tags,
  searchColumns,
  categoryColumn,
  dateColumn,
  tagsFilter,
}) => {
  if (search) {
    const placeholder = `$${params.length + 1}`;
    params.push(`%${search}%`);
    whereClauses.push(
      `(${searchColumns
        .map((column) => `COALESCE(${column}, '') ILIKE ${placeholder}`)
        .join(" OR ")})`,
    );
  }

  if (category) {
    const placeholder = `$${params.length + 1}`;
    params.push(category.toLowerCase());
    whereClauses.push(`LOWER(${categoryColumn}) = ${placeholder}`);
  }

  if (dateFrom) {
    const placeholder = `$${params.length + 1}`;
    params.push(dateFrom);
    whereClauses.push(`${dateColumn} >= ${placeholder}::date`);
  }

  if (dateTo) {
    const placeholder = `$${params.length + 1}`;
    params.push(dateTo);
    whereClauses.push(`${dateColumn} <= ${placeholder}::date`);
  }

  if (tags.length && tagsFilter) {
    const placeholder = `$${params.length + 1}`;
    params.push(tags);
    whereClauses.push(tagsFilter(placeholder));
  }
};

const mapAnnouncement = (row) => ({
  id: row.id,
  title: row.title,
  slug: `notice-${row.id}`,
  summary: row.content,
  content: row.content,
  category: row.type,
  tags: [
    String(row.type || "").toLowerCase(),
    String(row.priority || "").toLowerCase(),
  ].filter(Boolean),
  coverImageUrl: row.pdf_url,
  publishedAt: row.published_date,
  createdAt: null,
  updatedAt: null,
  priority: row.priority,
  views: row.views,
  isNew: row.is_new,
  pdfUrl: row.pdf_url,
});

const mapNewsItem = (row) => ({
  id: row.id,
  title: row.title,
  slug: `news-${row.id}`,
  summary: row.excerpt,
  content: row.content,
  category: row.category,
  tags: parseTagString(row.tags),
  sourceUrl: null,
  coverImageUrl: row.image_url,
  publishedAt: row.published_date,
  createdAt: null,
  updatedAt: null,
  author: row.author,
  department: row.department,
  priority: row.priority,
  views: row.views,
  likes: row.likes,
  featured: row.is_featured,
  status: row.status,
});

const mapEvent = (row) => {
  const startsAt =
    formatTimestampForApi(row.starts_at) ||
    buildEventStartIso(row.date, row.time);
  const endsAt = formatTimestampForApi(row.ends_at);
  const venue = row.venue || row.location || null;
  const coverImageUrl = row.cover_image || row.image || null;
  const tags = parseTagString(row.tags);
  const timeString = row.time_string || row.time || null;

  return {
    id: row.id,
    title: row.title,
    slug: `event-${row.id}`,
    summary: row.description,
    description: row.description,
    category: row.type,
    venue,
    organizer: row.organizer,
    startsAt,
    endsAt,
    coverImageUrl,
    registrationUrl: row.registration_url || null,
    isFeatured: false,
    isPublished: String(row.status || "").toLowerCase() !== "draft",
    publishedAt: startsAt,
    tags,
    createdAt: null,
    updatedAt: null,
    attendees: row.attendees,
    status: row.status,
    price: row.price,
    year: row.year,
    date: startsAt ? startsAt.slice(0, 10) : null,
    time: timeString,
    location: venue,
    type: row.type,
    mode: row.mode || "Offline",
    gallery: normalizeJsonArray(row.gallery),
    agenda: normalizeJsonArray(row.agenda),
    speakers: normalizeJsonArray(row.speakers),
  };
};

const mapMediaGalleryItem = (row) => {
  const images = normalizeJsonArray(row.images);

  return {
    id: row.id,
    title: row.title,
    category: row.category,
    year: row.year,
    publishedAt: row.published_date,
    images,
    coverImageUrl: images[0] || null,
  };
};

const mapNewsletter = (row) => ({
  id: row.id,
  title: row.title,
  issueNumber: row.issue_number,
  publishedDate: row.published_date,
  coverImageUrl: row.cover_image_url,
  excerpt: row.excerpt,
  pdfUrl: row.pdf_url,
  views: row.views,
  category: row.category,
});

const parseListFilters = (req, res) => {
  const { search, category, dateFrom, dateTo, tags, sortBy, order } = req.query;
  const parsedDateFrom = dateFrom ? toDateOnlyString(dateFrom) : null;
  const parsedDateTo = dateTo ? toDateOnlyString(dateTo) : null;

  if (dateFrom && !parsedDateFrom) {
    errorResponse(
      res,
      "Validation failed",
      [{ field: "dateFrom", message: "dateFrom must be a valid date" }],
      400,
    );
    return null;
  }

  if (dateTo && !parsedDateTo) {
    errorResponse(
      res,
      "Validation failed",
      [{ field: "dateTo", message: "dateTo must be a valid date" }],
      400,
    );
    return null;
  }

  if (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) {
    errorResponse(
      res,
      "Validation failed",
      [{ field: "dateRange", message: "dateFrom cannot be after dateTo" }],
      400,
    );
    return null;
  }

  return {
    search: String(search || "").trim(),
    category: String(category || "").trim(),
    dateFrom: parsedDateFrom,
    dateTo: parsedDateTo,
    tags: normalizeTags(tags),
    sortBy: String(sortBy || "").trim(),
    order: String(order || "").trim(),
    page: toPositiveInt(req.query.page, 1),
    limit: Math.min(toPositiveInt(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT),
  };
};

const handleNoticesList = async (req, res) => {
  const isNoticesRoute = req.path === "/notices";
  const successMessage = isNoticesRoute
    ? "Notices fetched successfully"
    : "Announcements fetched successfully";
  const errorField = isNoticesRoute ? "notices" : "announcements";
  const errorMessage = isNoticesRoute
    ? "Failed to fetch notices"
    : "Failed to fetch announcements";

  try {
    const listResult = await query(
      `
      SELECT id, title, content, published_date, type, priority, views, is_new, pdf_url
      FROM notices
      ORDER BY published_date DESC, id DESC
      `,
    );

    return successResponse(
      res,
      successMessage,
      listResult.rows.map(mapAnnouncement),
    );
  } catch (error) {
    return errorResponse(
      res,
      errorMessage,
      [{ field: errorField, message: error.message }],
      500,
    );
  }
};

router.get("/announcements", handleNoticesList);
router.get("/notices", handleNoticesList);

router.get("/notices/:id", async (req, res) => {
  const id = parseEventId(req.params.id);

  if (!id) {
    return errorResponse(
      res,
      "Validation failed",
      [{ field: "id", message: "Notice id must be a valid integer" }],
      400,
    );
  }

  try {
    const noticeResult = await query(
      `
      SELECT id, title, content, published_date, type, priority, views, is_new, pdf_url
      FROM notices
      WHERE id = $1
      LIMIT 1
      `,
      [id],
    );

    if (!noticeResult.rows.length) {
      return errorResponse(
        res,
        "Notice not found",
        [{ field: "id", message: "No notice found for this id" }],
        404,
      );
    }

    return successResponse(
      res,
      "Notice fetched successfully",
      mapAnnouncement(noticeResult.rows[0]),
    );
  } catch (error) {
    return errorResponse(
      res,
      "Failed to fetch notice",
      [{ field: "notice", message: error.message }],
      500,
    );
  }
});

router.post(
  "/notices",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const {
      title,
      content,
      publishedDate,
      type,
      priority,
      views,
      isNew,
      pdfUrl,
    } = req.body;

    const validationErrors = [];

    if (!String(title || "").trim()) {
      validationErrors.push({ field: "title", message: "title is required" });
    }
    if (!String(content || "").trim()) {
      validationErrors.push({
        field: "content",
        message: "content is required",
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
        INSERT INTO notices (
          title,
          content,
          published_date,
          type,
          priority,
          views,
          is_new,
          pdf_url
        ) VALUES (
          $1, $2, $3::date, $4, $5, $6, $7, $8
        )
        RETURNING id, title, content, published_date, type, priority, views, is_new, pdf_url
        `,
        [
          String(title).trim(),
          String(content).trim(),
          parsedPublishedDate,
          String(type || "General").trim() || "General",
          String(priority || "medium").trim() || "medium",
          toNonNegativeInt(views, 0),
          parseBoolean(isNew, true),
          pdfUrl || null,
        ],
      );

      return successResponse(
        res,
        "Notice created successfully",
        mapAnnouncement(insertResult.rows[0]),
        201,
      );
    } catch (error) {
      return errorResponse(
        res,
        "Failed to create notice",
        [{ field: "notice", message: error.message }],
        500,
      );
    }
  },
);

router.put(
  "/notices/:id",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const id = parseEventId(req.params.id);

    if (!id) {
      return errorResponse(
        res,
        "Validation failed",
        [{ field: "id", message: "Notice id must be a valid integer" }],
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

    if (hasOwn(req.body, "content")) {
      const content = String(req.body.content || "").trim();
      if (!content) {
        validationErrors.push({
          field: "content",
          message: "content cannot be empty",
        });
      } else {
        updates.push(`content = $${values.length + 1}`);
        values.push(content);
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

    if (hasOwn(req.body, "type")) {
      updates.push(`type = $${values.length + 1}`);
      values.push(String(req.body.type || "General").trim() || "General");
    }

    if (hasOwn(req.body, "priority")) {
      updates.push(`priority = $${values.length + 1}`);
      values.push(String(req.body.priority || "medium").trim() || "medium");
    }

    if (hasOwn(req.body, "views")) {
      updates.push(`views = $${values.length + 1}`);
      values.push(toNonNegativeInt(req.body.views, 0));
    }

    if (hasOwn(req.body, "isNew")) {
      updates.push(`is_new = $${values.length + 1}`);
      values.push(parseBoolean(req.body.isNew, false));
    }

    if (hasOwn(req.body, "pdfUrl")) {
      updates.push(`pdf_url = $${values.length + 1}`);
      values.push(req.body.pdfUrl || null);
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

    values.push(id);

    try {
      const updateResult = await query(
        `
        UPDATE notices
        SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING id, title, content, published_date, type, priority, views, is_new, pdf_url
        `,
        values,
      );

      if (!updateResult.rows.length) {
        return errorResponse(
          res,
          "Notice not found",
          [{ field: "id", message: "No notice found for this id" }],
          404,
        );
      }

      return successResponse(
        res,
        "Notice updated successfully",
        mapAnnouncement(updateResult.rows[0]),
      );
    } catch (error) {
      return errorResponse(
        res,
        "Failed to update notice",
        [{ field: "notice", message: error.message }],
        500,
      );
    }
  },
);

router.get("/news", async (req, res) => {
  try {
    const listResult = await query(
      `
      SELECT
        id, title, excerpt, content, published_date, author, department,
        tags, category, priority, views, likes, image_url, is_featured, status
      FROM news
      ORDER BY published_date DESC, id DESC
      `,
    );

    return successResponse(
      res,
      "News fetched successfully",
      listResult.rows.map(mapNewsItem),
    );
  } catch (error) {
    return errorResponse(
      res,
      "Failed to fetch news",
      [{ field: "news", message: error.message }],
      500,
    );
  }
});

router.get("/news/:id", async (req, res) => {
  const id = parseEventId(req.params.id);

  if (!id) {
    return errorResponse(
      res,
      "Validation failed",
      [{ field: "id", message: "News id must be a valid integer" }],
      400,
    );
  }

  try {
    const newsResult = await query(
      `
      SELECT
        id, title, excerpt, content, published_date, author, department,
        tags, category, priority, views, likes, image_url, is_featured, status
      FROM news
      WHERE id = $1
      LIMIT 1
      `,
      [id],
    );

    if (!newsResult.rows.length) {
      return errorResponse(
        res,
        "News not found",
        [{ field: "id", message: "No news found for this id" }],
        404,
      );
    }

    return successResponse(
      res,
      "News fetched successfully",
      mapNewsItem(newsResult.rows[0]),
    );
  } catch (error) {
    return errorResponse(
      res,
      "Failed to fetch news",
      [{ field: "news", message: error.message }],
      500,
    );
  }
});

router.post(
  "/news",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const {
      title,
      summary,
      excerpt,
      content,
      author,
      department,
      category,
      publishedDate,
      priority,
      views,
      likes,
      featured,
      isFeatured,
      status,
      coverImageUrl,
      imageUrl,
      tags,
    } = req.body;

    const validationErrors = [];

    if (!String(title || "").trim()) {
      validationErrors.push({ field: "title", message: "title is required" });
    }
    if (!String(content || "").trim()) {
      validationErrors.push({
        field: "content",
        message: "content is required",
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
        INSERT INTO news (
          title,
          excerpt,
          content,
          author,
          department,
          category,
          published_date,
          priority,
          views,
          likes,
          is_featured,
          status,
          image_url,
          tags
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14::jsonb
        )
        RETURNING
          id, title, excerpt, content, published_date, author, department,
          tags, category, priority, views, likes, image_url, is_featured, status
        `,
        [
          String(title).trim(),
          summary || excerpt || String(content).trim().slice(0, 200),
          String(content).trim(),
          author || null,
          department || null,
          String(category || "General").trim() || "General",
          parsedPublishedDate,
          String(priority || "medium").trim() || "medium",
          toNonNegativeInt(views, 0),
          toNonNegativeInt(likes, 0),
          parseBoolean(isFeatured ?? featured, false),
          String(status || "published").trim() || "published",
          coverImageUrl || imageUrl || null,
          JSON.stringify(normalizeTags(tags)),
        ],
      );

      return successResponse(
        res,
        "News created successfully",
        mapNewsItem(insertResult.rows[0]),
        201,
      );
    } catch (error) {
      return errorResponse(
        res,
        "Failed to create news",
        [{ field: "news", message: error.message }],
        500,
      );
    }
  },
);

router.put(
  "/news/:id",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const id = parseEventId(req.params.id);

    if (!id) {
      return errorResponse(
        res,
        "Validation failed",
        [{ field: "id", message: "News id must be a valid integer" }],
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

    if (hasOwn(req.body, "summary") || hasOwn(req.body, "excerpt")) {
      updates.push(`excerpt = $${values.length + 1}`);
      values.push(req.body.summary || req.body.excerpt || null);
    }

    if (hasOwn(req.body, "content")) {
      const content = String(req.body.content || "").trim();
      if (!content) {
        validationErrors.push({
          field: "content",
          message: "content cannot be empty",
        });
      } else {
        updates.push(`content = $${values.length + 1}`);
        values.push(content);
      }
    }

    if (hasOwn(req.body, "author")) {
      updates.push(`author = $${values.length + 1}`);
      values.push(req.body.author || null);
    }

    if (hasOwn(req.body, "department")) {
      updates.push(`department = $${values.length + 1}`);
      values.push(req.body.department || null);
    }

    if (hasOwn(req.body, "category")) {
      updates.push(`category = $${values.length + 1}`);
      values.push(String(req.body.category || "General").trim() || "General");
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

    if (hasOwn(req.body, "priority")) {
      updates.push(`priority = $${values.length + 1}`);
      values.push(String(req.body.priority || "medium").trim() || "medium");
    }

    if (hasOwn(req.body, "views")) {
      updates.push(`views = $${values.length + 1}`);
      values.push(toNonNegativeInt(req.body.views, 0));
    }

    if (hasOwn(req.body, "likes")) {
      updates.push(`likes = $${values.length + 1}`);
      values.push(toNonNegativeInt(req.body.likes, 0));
    }

    if (hasOwn(req.body, "featured") || hasOwn(req.body, "isFeatured")) {
      updates.push(`is_featured = $${values.length + 1}`);
      values.push(
        parseBoolean(req.body.isFeatured ?? req.body.featured, false),
      );
    }

    if (hasOwn(req.body, "status")) {
      updates.push(`status = $${values.length + 1}`);
      values.push(String(req.body.status || "published").trim() || "published");
    }

    if (hasOwn(req.body, "coverImageUrl") || hasOwn(req.body, "imageUrl")) {
      updates.push(`image_url = $${values.length + 1}`);
      values.push(req.body.coverImageUrl || req.body.imageUrl || null);
    }

    if (hasOwn(req.body, "tags")) {
      updates.push(`tags = $${values.length + 1}::jsonb`);
      values.push(JSON.stringify(normalizeTags(req.body.tags)));
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

    values.push(id);

    try {
      const updateResult = await query(
        `
        UPDATE news
        SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING
          id, title, excerpt, content, published_date, author, department,
          tags, category, priority, views, likes, image_url, is_featured, status
        `,
        values,
      );

      if (!updateResult.rows.length) {
        return errorResponse(
          res,
          "News not found",
          [{ field: "id", message: "No news found for this id" }],
          404,
        );
      }

      return successResponse(
        res,
        "News updated successfully",
        mapNewsItem(updateResult.rows[0]),
      );
    } catch (error) {
      return errorResponse(
        res,
        "Failed to update news",
        [{ field: "news", message: error.message }],
        500,
      );
    }
  },
);

router.get("/media-gallery", async (req, res) => {
  try {
    const listResult = await query(
      `
      SELECT id, title, category, year, published_date, images
      FROM media_gallery
      ORDER BY published_date DESC, id DESC
      `,
    );

    return successResponse(
      res,
      "Media gallery fetched successfully",
      listResult.rows.map(mapMediaGalleryItem),
    );
  } catch (error) {
    return errorResponse(
      res,
      "Failed to fetch media gallery",
      [{ field: "media_gallery", message: error.message }],
      500,
    );
  }
});

router.post(
  "/media-gallery",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const { title, category, year, publishedDate, images } = req.body;

    const validationErrors = [];

    if (!String(title || "").trim()) {
      validationErrors.push({ field: "title", message: "title is required" });
    }
    if (!String(category || "").trim()) {
      validationErrors.push({
        field: "category",
        message: "category is required",
      });
    }
    if (!String(year || "").trim()) {
      validationErrors.push({ field: "year", message: "year is required" });
    }

    const parsedPublishedDate = toDateOnlyString(publishedDate);
    if (!parsedPublishedDate) {
      validationErrors.push({
        field: "publishedDate",
        message: "publishedDate is required and must be a valid date",
      });
    }

    const normalizedImages = normalizeJsonArray(images);
    if (!normalizedImages.length) {
      validationErrors.push({
        field: "images",
        message: "images must contain at least one item",
      });
    }

    if (validationErrors.length) {
      return errorResponse(res, "Validation failed", validationErrors, 400);
    }

    try {
      const insertResult = await query(
        `
        INSERT INTO media_gallery (
          title,
          category,
          year,
          published_date,
          images
        ) VALUES (
          $1, $2, $3, $4::date, $5::jsonb
        )
        RETURNING id, title, category, year, published_date, images
        `,
        [
          String(title).trim(),
          String(category).trim(),
          String(year).trim(),
          parsedPublishedDate,
          JSON.stringify(normalizedImages),
        ],
      );

      return successResponse(
        res,
        "Media gallery item created successfully",
        mapMediaGalleryItem(insertResult.rows[0]),
        201,
      );
    } catch (error) {
      return errorResponse(
        res,
        "Failed to create media gallery item",
        [{ field: "media_gallery", message: error.message }],
        500,
      );
    }
  },
);

router.put(
  "/media-gallery/:id",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const id = parseEventId(req.params.id);

    if (!id) {
      return errorResponse(
        res,
        "Validation failed",
        [
          {
            field: "id",
            message: "Media gallery id must be a valid integer",
          },
        ],
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

    if (hasOwn(req.body, "year")) {
      const year = String(req.body.year || "").trim();
      if (!year) {
        validationErrors.push({
          field: "year",
          message: "year cannot be empty",
        });
      } else {
        updates.push(`year = $${values.length + 1}`);
        values.push(year);
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

    if (hasOwn(req.body, "images")) {
      const normalizedImages = normalizeJsonArray(req.body.images);
      if (!normalizedImages.length) {
        validationErrors.push({
          field: "images",
          message: "images must contain at least one item",
        });
      } else {
        updates.push(`images = $${values.length + 1}::jsonb`);
        values.push(JSON.stringify(normalizedImages));
      }
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

    values.push(id);

    try {
      const updateResult = await query(
        `
        UPDATE media_gallery
        SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING id, title, category, year, published_date, images
        `,
        values,
      );

      if (!updateResult.rows.length) {
        return errorResponse(
          res,
          "Media gallery item not found",
          [{ field: "id", message: "No media gallery item found for this id" }],
          404,
        );
      }

      return successResponse(
        res,
        "Media gallery item updated successfully",
        mapMediaGalleryItem(updateResult.rows[0]),
      );
    } catch (error) {
      return errorResponse(
        res,
        "Failed to update media gallery item",
        [{ field: "media_gallery", message: error.message }],
        500,
      );
    }
  },
);

router.get("/events", async (req, res) => {
  try {
    const listResult = await query(
      `
      SELECT
        id,
        title,
        description,
        starts_at,
        time_string,
        venue,
        organizer,
        type,
        mode,
        status,
        price,
        attendees,
        cover_image,
        tags,
        year
      FROM events
      ORDER BY starts_at ASC, id ASC
      `,
    );

    return res.status(200).json({
      success: true,
      count: listResult.rowCount,
      data: listResult.rows,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server Error" });
  }
});

router.get("/events/:id", async (req, res) => {
  const id = parseEventId(req.params.id);

  if (!id) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid event id" });
  }

  try {
    const eventResult = await query(
      `
      SELECT *
      FROM events
      WHERE id = $1
      LIMIT 1
      `,
      [id],
    );

    if (!eventResult.rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Event not found" });
    }

    return res.status(200).json({
      success: true,
      data: eventResult.rows[0],
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server Error" });
  }
});

router.get("/newsletters", async (req, res) => {
  try {
    const listResult = await query(
      `
      SELECT
        id,
        title,
        issue_number,
        published_date,
        cover_image_url,
        excerpt,
        pdf_url,
        views,
        category
      FROM newsletters
      ORDER BY published_date DESC, id DESC
      `,
    );

    return successResponse(
      res,
      "Newsletters fetched successfully",
      listResult.rows.map(mapNewsletter),
    );
  } catch (error) {
    return errorResponse(
      res,
      "Failed to fetch newsletters",
      [{ field: "newsletters", message: error.message }],
      500,
    );
  }
});

router.post(
  "/events",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const {
      title,
      description,
      organizer,
      venue,
      location,
      type,
      category,
      mode,
      status,
      price,
      attendees = 0,
      startsAt,
      starts_at,
      endsAt,
      ends_at,
      date,
      time,
      timeString,
      time_string,
      year,
      coverImageUrl,
      cover_image,
      image,
      registrationUrl,
      registration_url,
      tags,
      gallery,
      agenda,
      speakers,
    } = req.body;

    if (!title) {
      return errorResponse(
        res,
        "Validation failed",
        [{ field: "title", message: "title is required" }],
        400,
      );
    }

    const startsAtInput = startsAt || starts_at;
    const endsAtInput = endsAt || ends_at;

    const parsedDate = toDateOnlyString(date);
    const parsedTime = parseTimeString(time) || "00:00";
    const normalizedStartsAt =
      parseTimestampInput(startsAtInput) ||
      (parsedDate ? `${parsedDate} ${parsedTime}:00` : null);

    if (!normalizedStartsAt) {
      return errorResponse(
        res,
        "Validation failed",
        [{ field: "startsAt", message: "startsAt or date is required" }],
        400,
      );
    }

    const normalizedEndsAt = parseTimestampInput(endsAtInput);
    const normalizedVenue = String(venue || location || "").trim() || null;
    const normalizedType = String(type || category || "General").trim();
    const normalizedMode = String(mode || "Offline").trim();
    const normalizedStatus = String(status || "upcoming").trim();
    const normalizedPrice = String(price || "Free").trim();

    const parsedAttendees = Number.parseInt(attendees, 10);
    const safeAttendees = Number.isNaN(parsedAttendees) ? 0 : parsedAttendees;

    const normalizedTimeString = String(
      timeString ||
        time_string ||
        parseTimeString(time) ||
        normalizedStartsAt.slice(11, 16),
    ).trim();
    const normalizedYear = String(
      year || normalizedStartsAt.slice(0, 4),
    ).trim();
    const normalizedCoverImage = cover_image || coverImageUrl || image || null;
    const normalizedRegistrationUrl =
      registration_url || registrationUrl || null;

    const normalizedTags = normalizeTags(tags);
    const normalizedGallery = normalizeJsonArray(gallery);
    const normalizedAgenda = normalizeJsonArray(agenda);
    const normalizedSpeakers = normalizeJsonArray(speakers);

    const client = await getDbPool().connect();

    try {
      await client.query("BEGIN");

      const insertResult = await client.query(
        `
        INSERT INTO events (
          title,
          description,
          organizer,
          venue,
          type,
          mode,
          status,
          price,
          attendees,
          starts_at,
          ends_at,
          time_string,
          year,
          cover_image,
          registration_url,
          tags,
          gallery,
          agenda,
          speakers
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::timestamp,
          $11::timestamp,
          $12,
          $13,
          $14,
          $15,
          $16::jsonb,
          $17::jsonb,
          $18::jsonb,
          $19::jsonb
        )
        RETURNING *
        `,
        [
          String(title).trim(),
          description || null,
          organizer || null,
          normalizedVenue,
          normalizedType,
          normalizedMode,
          normalizedStatus,
          normalizedPrice,
          safeAttendees,
          normalizedStartsAt,
          normalizedEndsAt,
          normalizedTimeString,
          normalizedYear,
          normalizedCoverImage,
          normalizedRegistrationUrl,
          JSON.stringify(normalizedTags),
          JSON.stringify(normalizedGallery),
          JSON.stringify(normalizedAgenda),
          JSON.stringify(normalizedSpeakers),
        ],
      );

      const createdEvent = insertResult.rows[0];

      await writeAuditLog(client, {
        actorUserId: req?.user?.sub,
        action: "event.create",
        resourceType: "events",
        resourceId: null,
        requestId: req.requestId,
        metadata: { eventId: createdEvent.id, title: String(title).trim() },
      });

      await client.query("COMMIT");

      return successResponse(
        res,
        "Event created successfully",
        mapEvent(createdEvent),
        201,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      return errorResponse(
        res,
        "Failed to create event",
        [{ field: "event", message: error.message }],
        500,
      );
    } finally {
      client.release();
    }
  },
);

router.put(
  "/events/:id",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const eventId = parseEventId(req.params.id);

    if (!eventId) {
      return errorResponse(
        res,
        "Validation failed",
        [{ field: "id", message: "Event id must be a valid integer" }],
        400,
      );
    }

    const hasDate = hasOwn(req.body, "date");
    const hasTime = hasOwn(req.body, "time");
    const hasStartsAt =
      hasOwn(req.body, "startsAt") || hasOwn(req.body, "starts_at");
    const hasEndsAt = hasOwn(req.body, "endsAt") || hasOwn(req.body, "ends_at");

    const supportedKeys = [
      "title",
      "description",
      "organizer",
      "venue",
      "location",
      "type",
      "category",
      "mode",
      "status",
      "price",
      "attendees",
      "timeString",
      "time_string",
      "year",
      "coverImageUrl",
      "cover_image",
      "image",
      "registrationUrl",
      "registration_url",
      "tags",
      "gallery",
      "agenda",
      "speakers",
      "startsAt",
      "starts_at",
      "endsAt",
      "ends_at",
      "date",
      "time",
    ];

    const hasAnySupportedField = supportedKeys.some((key) =>
      hasOwn(req.body, key),
    );

    if (!hasAnySupportedField) {
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

    if (hasOwn(req.body, "organizer")) {
      updates.push(`organizer = $${values.length + 1}`);
      values.push(req.body.organizer || null);
    }

    if (hasOwn(req.body, "venue") || hasOwn(req.body, "location")) {
      const venue = String(req.body.venue || req.body.location || "").trim();
      updates.push(`venue = $${values.length + 1}`);
      values.push(venue || null);
    }

    if (hasOwn(req.body, "type") || hasOwn(req.body, "category")) {
      updates.push(`type = $${values.length + 1}`);
      values.push(
        String(req.body.type || req.body.category || "General").trim() ||
          "General",
      );
    }

    if (hasOwn(req.body, "mode")) {
      updates.push(`mode = $${values.length + 1}`);
      values.push(String(req.body.mode || "Offline").trim() || "Offline");
    }

    if (hasOwn(req.body, "status")) {
      updates.push(`status = $${values.length + 1}`);
      values.push(String(req.body.status || "upcoming").trim() || "upcoming");
    }

    if (hasOwn(req.body, "price")) {
      updates.push(`price = $${values.length + 1}`);
      values.push(String(req.body.price || "Free").trim() || "Free");
    }

    if (hasOwn(req.body, "attendees")) {
      updates.push(`attendees = $${values.length + 1}`);
      values.push(toNonNegativeInt(req.body.attendees, 0));
    }

    if (hasStartsAt || hasDate || hasTime) {
      const startsAtInput = req.body.startsAt || req.body.starts_at;
      let normalizedStartsAt = null;

      if (startsAtInput) {
        normalizedStartsAt = parseTimestampInput(startsAtInput);
        if (!normalizedStartsAt) {
          validationErrors.push({
            field: "startsAt",
            message: "startsAt must be a valid datetime",
          });
        }
      } else {
        const parsedDate = toDateOnlyString(req.body.date);
        const parsedTime = parseTimeString(req.body.time);

        if (!parsedDate) {
          validationErrors.push({
            field: "date",
            message: "date must be a valid date when updating event time",
          });
        }

        if (hasTime && !parsedTime) {
          validationErrors.push({
            field: "time",
            message: "time must be in HH:mm format",
          });
        }

        if (parsedDate) {
          normalizedStartsAt = `${parsedDate} ${parsedTime || "00:00"}:00`;
        }
      }

      if (normalizedStartsAt) {
        updates.push(`starts_at = $${values.length + 1}::timestamp`);
        values.push(normalizedStartsAt);
      }
    }

    if (hasEndsAt) {
      const endsAtInput = req.body.endsAt || req.body.ends_at;
      const normalizedEndsAt = endsAtInput
        ? parseTimestampInput(endsAtInput)
        : null;

      if (endsAtInput && !normalizedEndsAt) {
        validationErrors.push({
          field: "endsAt",
          message: "endsAt must be a valid datetime",
        });
      } else {
        updates.push(`ends_at = $${values.length + 1}::timestamp`);
        values.push(normalizedEndsAt);
      }
    }

    if (hasOwn(req.body, "timeString") || hasOwn(req.body, "time_string")) {
      const normalizedTimeString = String(
        req.body.timeString || req.body.time_string || "",
      ).trim();

      updates.push(`time_string = $${values.length + 1}`);
      values.push(normalizedTimeString || null);
    }

    if (hasOwn(req.body, "year")) {
      updates.push(`year = $${values.length + 1}`);
      values.push(String(req.body.year || "").trim() || null);
    }

    if (
      hasOwn(req.body, "coverImageUrl") ||
      hasOwn(req.body, "cover_image") ||
      hasOwn(req.body, "image")
    ) {
      updates.push(`cover_image = $${values.length + 1}`);
      values.push(
        req.body.coverImageUrl ||
          req.body.cover_image ||
          req.body.image ||
          null,
      );
    }

    if (
      hasOwn(req.body, "registrationUrl") ||
      hasOwn(req.body, "registration_url")
    ) {
      updates.push(`registration_url = $${values.length + 1}`);
      values.push(
        req.body.registrationUrl || req.body.registration_url || null,
      );
    }

    if (hasOwn(req.body, "tags")) {
      updates.push(`tags = $${values.length + 1}::jsonb`);
      values.push(JSON.stringify(normalizeTags(req.body.tags)));
    }

    if (hasOwn(req.body, "gallery")) {
      updates.push(`gallery = $${values.length + 1}::jsonb`);
      values.push(JSON.stringify(normalizeJsonArray(req.body.gallery)));
    }

    if (hasOwn(req.body, "agenda")) {
      updates.push(`agenda = $${values.length + 1}::jsonb`);
      values.push(JSON.stringify(normalizeJsonArray(req.body.agenda)));
    }

    if (hasOwn(req.body, "speakers")) {
      updates.push(`speakers = $${values.length + 1}::jsonb`);
      values.push(JSON.stringify(normalizeJsonArray(req.body.speakers)));
    }

    if (validationErrors.length) {
      return errorResponse(res, "Validation failed", validationErrors, 400);
    }

    values.push(eventId);

    try {
      const updateResult = await query(
        `
        UPDATE events
        SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING *
        `,
        values,
      );

      if (!updateResult.rows.length) {
        return errorResponse(
          res,
          "Event not found",
          [{ field: "id", message: "No event found for this id" }],
          404,
        );
      }

      return successResponse(
        res,
        "Event updated successfully",
        mapEvent(updateResult.rows[0]),
      );
    } catch (error) {
      return errorResponse(
        res,
        "Failed to update event",
        [{ field: "event", message: error.message }],
        500,
      );
    }
  },
);

router.post(
  "/newsletters",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const {
      title,
      issueNo,
      issueNumber,
      issueDate,
      publishedDate,
      summary,
      contentHtml,
      pdfUrl,
      coverImageUrl,
      views = 0,
      category = "General",
      isPublished = true,
    } = req.body;

    const resolvedIssueDate = issueDate || publishedDate;

    if (!title || !resolvedIssueDate) {
      return errorResponse(
        res,
        "Validation failed",
        [
          { field: "title", message: "title is required" },
          { field: "issueDate", message: "issueDate is required" },
        ],
        400,
      );
    }

    const parsedIssueDate = toDateOnlyString(resolvedIssueDate);
    if (!parsedIssueDate) {
      return errorResponse(
        res,
        "Validation failed",
        [{ field: "issueDate", message: "issueDate must be a valid date" }],
        400,
      );
    }

    const client = await getDbPool().connect();

    try {
      await client.query("BEGIN");
      const normalizedIssueNumber = String(issueNumber || issueNo || "").trim();
      const normalizedViews = Number.isNaN(Number.parseInt(views, 10))
        ? 0
        : Number.parseInt(views, 10);
      const normalizedExcerpt = summary || contentHtml || String(title).trim();

      const insertResult = await client.query(
        `
        INSERT INTO newsletters (
          title,
          issue_number,
          published_date,
          cover_image_url,
          excerpt,
          pdf_url,
          views,
          category
        ) VALUES (
          $1, $2, $3::date, $4, $5, $6, $7, $8
        )
        RETURNING id
        `,
        [
          String(title).trim(),
          normalizedIssueNumber || null,
          parsedIssueDate,
          coverImageUrl || null,
          normalizedExcerpt,
          pdfUrl || null,
          normalizedViews,
          String(category || "General").trim() || "General",
        ],
      );

      const createdNewsletterId = Number(insertResult.rows[0].id);

      await writeAuditLog(client, {
        actorUserId: req?.user?.sub,
        action: "newsletter.create",
        resourceType: "newsletters",
        resourceId: null,
        requestId: req.requestId,
        metadata: {
          newsletterId: createdNewsletterId,
          title: String(title).trim(),
          issueNumber: normalizedIssueNumber || null,
          isPublished: Boolean(isPublished),
        },
      });

      await client.query("COMMIT");

      return successResponse(
        res,
        "Newsletter created successfully",
        {
          id: createdNewsletterId,
          title: String(title).trim(),
          issueNumber: normalizedIssueNumber || null,
          issueDate: parsedIssueDate,
          publishedDate: parsedIssueDate,
          summary: normalizedExcerpt,
          contentHtml: contentHtml || null,
          pdfUrl: pdfUrl || null,
          coverImageUrl: coverImageUrl || null,
          views: normalizedViews,
          category: String(category || "General").trim() || "General",
          isPublished: Boolean(isPublished),
        },
        201,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      return errorResponse(
        res,
        "Failed to create newsletter",
        [{ field: "newsletter", message: error.message }],
        500,
      );
    } finally {
      client.release();
    }
  },
);

router.put(
  "/newsletters/:id",
  authenticate,
  authorize(ROLES.SUPER_ADMIN),
  async (req, res) => {
    const id = parseEventId(req.params.id);

    if (!id) {
      return errorResponse(
        res,
        "Validation failed",
        [{ field: "id", message: "Newsletter id must be a valid integer" }],
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

    if (hasOwn(req.body, "issueNo") || hasOwn(req.body, "issueNumber")) {
      updates.push(`issue_number = $${values.length + 1}`);
      values.push(
        String(req.body.issueNumber || req.body.issueNo || "").trim() || null,
      );
    }

    if (hasOwn(req.body, "issueDate") || hasOwn(req.body, "publishedDate")) {
      const parsedDate = toDateOnlyString(
        req.body.issueDate || req.body.publishedDate,
      );
      if (!parsedDate) {
        validationErrors.push({
          field: "publishedDate",
          message: "issueDate or publishedDate must be a valid date",
        });
      } else {
        updates.push(`published_date = $${values.length + 1}::date`);
        values.push(parsedDate);
      }
    }

    if (hasOwn(req.body, "summary") || hasOwn(req.body, "excerpt")) {
      updates.push(`excerpt = $${values.length + 1}`);
      values.push(req.body.summary || req.body.excerpt || null);
    }

    if (hasOwn(req.body, "pdfUrl")) {
      updates.push(`pdf_url = $${values.length + 1}`);
      values.push(req.body.pdfUrl || null);
    }

    if (hasOwn(req.body, "coverImageUrl")) {
      updates.push(`cover_image_url = $${values.length + 1}`);
      values.push(req.body.coverImageUrl || null);
    }

    if (hasOwn(req.body, "views")) {
      updates.push(`views = $${values.length + 1}`);
      values.push(toNonNegativeInt(req.body.views, 0));
    }

    if (hasOwn(req.body, "category")) {
      updates.push(`category = $${values.length + 1}`);
      values.push(String(req.body.category || "General").trim() || "General");
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

    values.push(id);

    try {
      const updateResult = await query(
        `
        UPDATE newsletters
        SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING id, title, issue_number, published_date, cover_image_url, excerpt, pdf_url, views, category
        `,
        values,
      );

      if (!updateResult.rows.length) {
        return errorResponse(
          res,
          "Newsletter not found",
          [{ field: "id", message: "No newsletter found for this id" }],
          404,
        );
      }

      const row = updateResult.rows[0];
      return successResponse(res, "Newsletter updated successfully", {
        id: row.id,
        title: row.title,
        issueNumber: row.issue_number,
        issueDate: row.published_date,
        publishedDate: row.published_date,
        summary: row.excerpt,
        contentHtml: null,
        pdfUrl: row.pdf_url,
        coverImageUrl: row.cover_image_url,
        views: row.views,
        category: row.category,
        isPublished: true,
      });
    } catch (error) {
      return errorResponse(
        res,
        "Failed to update newsletter",
        [{ field: "newsletter", message: error.message }],
        500,
      );
    }
  },
);

module.exports = router;
