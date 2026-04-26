# Create and Update Endpoints (Frontend Integration Guide)

This file is the practical contract for frontend devs.

Status: schema-validated against [src/db/schema.sql](src/db/schema.sql).

## Base Rules

- Base URL prefix for most endpoints: `/api`
- Versioned content endpoints: `/api/v1/...`
- Recruitments write endpoints are mounted at root: `/recruitments`
- Success response shape:

```json
{
  "success": true,
  "message": "Human readable message",
  "data": {}
}
```

## Auth Rules

Write endpoints below are protected unless explicitly marked public.

- Header: `Authorization: Bearer <accessToken>`
- Role: `super_admin`

Public booking create endpoint remains public:

- `POST /api/bookings`

## 1) Communications Endpoints (`/api/v1`)

### 1.1 Notices

- `POST /api/v1/notices`
- `PUT /api/v1/notices/:id` (partial update)

Required create fields:

- `title`
- `content`

Optional fields:

- `publishedDate` (YYYY-MM-DD)
- `type`
- `priority`
- `views`
- `isNew`
- `pdfUrl`

Example create payload:

```json
{
  "title": "Exam Form Last Date Extended",
  "content": "Form submit date extended till 30 April.",
  "publishedDate": "2026-04-22",
  "type": "Exam",
  "priority": "high",
  "views": 0,
  "isNew": true,
  "pdfUrl": "https://example.com/notice.pdf"
}
```

### 1.2 News

- `POST /api/v1/news`
- `PUT /api/v1/news/:id` (partial update)

Required create fields:

- `title`
- `content`

Optional fields:

- `summary` or `excerpt`
- `author`
- `department`
- `category`
- `publishedDate` (YYYY-MM-DD)
- `priority`
- `views`
- `likes`
- `featured` or `isFeatured`
- `status`
- `coverImageUrl` or `imageUrl`
- `tags` (array or comma separated)

Example create payload:

```json
{
  "title": "GBU Ranked in Top Innovation List",
  "content": "GBU has been listed among top innovation campuses.",
  "summary": "GBU enters innovation ranking.",
  "author": "Admin",
  "department": "Research",
  "category": "Campus",
  "publishedDate": "2026-04-22",
  "priority": "high",
  "views": 10,
  "likes": 2,
  "featured": true,
  "status": "published",
  "coverImageUrl": "https://example.com/news.jpg",
  "tags": ["innovation", "ranking"]
}
```

### 1.3 Media Gallery

- `POST /api/v1/media-gallery`
- `PUT /api/v1/media-gallery/:id` (partial update)

Required create fields:

- `title`
- `category`
- `year`
- `publishedDate` (YYYY-MM-DD)
- `images` (non-empty array)

Example create payload:

```json
{
  "title": "Convocation 2026 Highlights",
  "category": "Convocation",
  "year": "2026",
  "publishedDate": "2026-04-22",
  "images": [
    "https://example.com/convocation-1.jpg",
    "https://example.com/convocation-2.jpg"
  ]
}
```

### 1.4 Events

- `POST /api/v1/events`
- `PUT /api/v1/events/:id` (partial update)

Create minimum:

- `title`
- Either `startsAt` (datetime) OR (`date` + optional `time`)

Update supports any subset of:

- Basic: `title`, `description`, `organizer`, `venue`, `location`, `type`, `category`, `mode`, `status`, `price`, `attendees`
- Date/time: `startsAt`/`starts_at`, `endsAt`/`ends_at`, or `date` + `time`
- Media/meta: `coverImageUrl`, `cover_image`, `image`, `registrationUrl`, `registration_url`, `year`, `timeString`, `time_string`
- Arrays: `tags`, `gallery`, `agenda`, `speakers`

Example update payload:

```json
{
  "title": "Annual Tech Fest 2026",
  "date": "2026-05-01",
  "time": "11:00",
  "venue": "Main Auditorium",
  "status": "upcoming",
  "attendees": 500,
  "tags": ["techfest", "innovation"]
}
```

### 1.5 Newsletters

- `POST /api/v1/newsletters`
- `PUT /api/v1/newsletters/:id` (partial update)

Create minimum:

- `title`
- `issueDate` or `publishedDate`

Optional fields:

- `issueNo` or `issueNumber`
- `summary` or `excerpt`
- `contentHtml`
- `pdfUrl`
- `coverImageUrl`
- `views`
- `category`

Example update payload:

```json
{
  "title": "Monthly Bulletin - May 2026",
  "issueNumber": "MAY-2026",
  "publishedDate": "2026-05-02",
  "summary": "Major events and achievements",
  "pdfUrl": "https://example.com/newsletter-may.pdf",
  "coverImageUrl": "https://example.com/newsletter-cover.jpg"
}
```

## 2) Tenders Endpoints (`/api/v1`)

- `POST /api/v1/tenders`
- `PUT /api/v1/tenders/:id` (partial update)

Required create fields:

- `title`
- `referenceNo`
- `closingDate`
- `documentUrl`

Optional fields:

- `description`
- `category`
- `tenderType`
- `publishedDate`
- `isActive`

Example create payload:

```json
{
  "title": "Procurement of Lab Equipment",
  "description": "Supply and installation of lab hardware",
  "referenceNo": "GBU/TDR/2026/09",
  "category": "procurement",
  "tenderType": "RFP",
  "publishedDate": "2026-04-22",
  "closingDate": "2026-05-15",
  "documentUrl": "https://example.com/tender-09.pdf",
  "isActive": true
}
```

## 3) Recruitments Endpoints (Root Mounted)

- `POST /recruitments`
- `PUT /recruitments/:id` (partial update)

Required create fields:

- `title`
- `referenceNo`
- `category`
- `tabId`
- `closingDate`

Optional fields:

- `description`
- `publishedDate`
- `isActive`
- `documents` (array)

`documents[]` item fields when provided:

- Required: `name`, `documentType`, `url`
- Optional: `description`, `sortOrder`, `isActive`

Important update behavior:

- If `documents` is included in PUT payload, previous documents for that recruitment are replaced.

Example create payload:

```json
{
  "title": "Assistant Professor - CSE",
  "description": "Applications invited for CSE",
  "referenceNo": "GBU/REC/2026/10",
  "category": "teaching",
  "tabId": "assistant-professor",
  "publishedDate": "2026-04-22",
  "closingDate": "2026-05-25",
  "isActive": true,
  "documents": [
    {
      "name": "Detailed Advertisement",
      "documentType": "advertisement",
      "url": "https://example.com/recruitment-ad.pdf",
      "description": "Official job notification",
      "sortOrder": 1,
      "isActive": true
    }
  ]
}
```

## 4) Booking Endpoints (`/api`)

- Public create: `POST /api/bookings`
- Protected update: `PUT /api/bookings/:id`

Create required fields:

- `startTime`
- `endTime`
- `purpose`
- `organizingDept`

Optional fields:

- `contactEmail`
- `contactMobile`

Update supports partial fields from the same set.

Example update payload:

```json
{
  "startTime": "2026-04-25 11:00:00",
  "endTime": "2026-04-25 12:00:00",
  "purpose": "Updated booking purpose",
  "organizingDept": "IT",
  "contactEmail": "updated@gbu.ac.in",
  "contactMobile": "9999999991"
}
```

## Common Error Cases

- `400`: validation failed (missing required fields, invalid date/id)
- `401`: bearer token missing/invalid
- `403`: authenticated user is not super_admin
- `404`: target record not found for provided `:id`
- `409`: unique conflict (example: duplicate `referenceNo`)

## Schema Coverage (Validated)

These write endpoints map to actual tables in [src/db/schema.sql](src/db/schema.sql):

- `notices`
- `news`
- `media_gallery`
- `events`
- `newsletters`
- `tenders`
- `recruitments`
- `recruitment_documents`
- `booking_requests`
- `audit_logs` (used for event/newsletter audit trail)
