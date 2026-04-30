-- =====================================
-- CREATE DATABASE
-- =====================================
-- Run once manually from postgres DB in pgAdmin/psql:
-- CREATE DATABASE gbu;
-- Then connect to gbu database and run this file.

BEGIN;

  -- =====================================
  -- DROP ALL EXISTING TABLES (DESTRUCTIVE)
  -- =====================================
  DO $$
  DECLARE
  r RECORD;
BEGIN
  FOR r IN
  SELECT tablename
  FROM pg_tables
  WHERE schemaname = 'public'
  LOOP
  EXECUTE format
  ('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
END LOOP;
END $$;

-- =====================================
-- TABLES
-- =====================================
CREATE TABLE notices
(
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  published_date DATE,
  type VARCHAR(100),
  priority VARCHAR(50) DEFAULT 'medium',
  views INT DEFAULT 0,
  is_new BOOLEAN DEFAULT true,
  pdf_url TEXT
);

CREATE TABLE news
(
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  excerpt TEXT,
  content TEXT NOT NULL,
  author VARCHAR(100),
  department VARCHAR(100),
  category VARCHAR(100),
  published_date DATE,
  priority VARCHAR(50) DEFAULT 'medium',
  views INT DEFAULT 0,
  likes INT DEFAULT 0,
  is_featured BOOLEAN DEFAULT false,
  status VARCHAR(50) DEFAULT 'published',
  image_url TEXT,
  tags JSONB DEFAULT '[]'
  ::jsonb
);

  CREATE TABLE newsletters
  (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    issue_number VARCHAR(100),
    published_date DATE,
    cover_image_url TEXT,
    excerpt TEXT,
    pdf_url TEXT,
    views INT DEFAULT 0,
    category VARCHAR(100)
  );

  CREATE TABLE events
  (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    organizer VARCHAR(255),
    venue VARCHAR(255),
    type VARCHAR(100),
    mode VARCHAR(50) DEFAULT 'Offline',
    status VARCHAR(20),
    price VARCHAR(50) DEFAULT 'Free',
    attendees INT DEFAULT 0,
    starts_at TIMESTAMP NOT NULL,
    ends_at TIMESTAMP,
    time_string VARCHAR(50),
    year VARCHAR(10),
    cover_image TEXT,
    registration_url TEXT,
    tags JSONB DEFAULT '[]'
    ::jsonb,
  gallery JSONB DEFAULT '[]'::jsonb,
  agenda JSONB DEFAULT '[]'::jsonb,
  speakers JSONB DEFAULT '[]'::jsonb
);

    CREATE TABLE media_gallery
    (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL,
      year VARCHAR(10) NOT NULL,
      published_date DATE NOT NULL,
      images JSONB DEFAULT '[]'
      ::jsonb
);

      CREATE TABLE tenders
      (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        reference_no VARCHAR(100) UNIQUE,
        category VARCHAR(100),
        tender_type VARCHAR(20) NOT NULL DEFAULT 'RFP',
        published_date DATE,
        closing_date DATE NOT NULL,
        document_url TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE recruitments
      (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        reference_no VARCHAR(100) UNIQUE NOT NULL,
        category VARCHAR(50) NOT NULL,
        tab_id VARCHAR(50) NOT NULL,
        published_date DATE,
        closing_date DATE NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE recruitment_documents
      (
        id SERIAL PRIMARY KEY,
        recruitment_id INT NOT NULL REFERENCES recruitments(id) ON DELETE CASCADE,
        name VARCHAR(150) NOT NULL,
        document_type VARCHAR(50) NOT NULL,
        file_url TEXT NOT NULL,
        description TEXT,
        sort_order INT NOT NULL DEFAULT 1,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE users
      (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        role VARCHAR(30) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        email_verified BOOLEAN NOT NULL DEFAULT TRUE,
        password_updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE auth_refresh_tokens
      (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(128) NOT NULL UNIQUE,
        user_agent TEXT,
        ip_address VARCHAR(100),
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE password_reset_otps
      (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        otp_hash VARCHAR(128) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        consumed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      -- =====================================
      -- PERFORMANCE INDEXES
      -- =====================================
      CREATE INDEX IF NOT EXISTS idx_tenders_active_closing_date
      ON tenders(is_active, closing_date DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_recruitments_active_closing_published
      ON recruitments(is_active, closing_date DESC, published_date DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_recruitment_documents_recruitment_active_sort
      ON recruitment_documents(recruitment_id, is_active, sort_order, id);

      CREATE INDEX IF NOT EXISTS idx_users_email
      ON users((LOWER(email)));

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
      ON auth_refresh_tokens(user_id, revoked_at, expires_at);

      CREATE INDEX IF NOT EXISTS idx_password_reset_otps_user_active
      ON password_reset_otps(user_id, consumed_at, expires_at, created_at DESC);

      -- =====================================
      -- INSERT ONLY 1 RECORD PER CORE TABLE
      -- =====================================
      INSERT INTO notices
        (title, content, published_date, type, priority, views, is_new, pdf_url)
      VALUES
        (
          'End Semester Examination Schedule - June 2025',
          'The final schedule for End Semester Examinations (June 2025) is now available. Students are advised to download the PDF and prepare accordingly.',
          '2025-05-25',
          'Exam',
          'high',
          1245,
          TRUE,
          'https://gbu.ac.in/notices/exam-schedule-june-2025.pdf'
);

      INSERT INTO news
        (title, excerpt, content, author, department, category, published_date, priority, views, likes, is_featured, status, image_url, tags)
      VALUES
        (
          'GBU Inaugurates Centre for Artificial Intelligence and Machine Learning',
          'GBU launched a state-of-the-art Centre for AI and ML research.',
          'The new centre will focus on machine learning, natural language processing, computer vision, and robotics.',
          'Dr. Rajesh Kumar',
          'Research Cell',
          'Research',
          '2024-06-20',
          'high',
          2847,
          156,
          TRUE,
          'published',
          'https://gburif.org/images/intro-carousel/gautam-buddha-university-3.jpg',
          '["AI", "Research", "Innovation", "Technology"]'
      ::jsonb
);

      INSERT INTO newsletters
        (
        id,
        title,
        issue_number,
        published_date,
        cover_image_url,
        excerpt,
        pdf_url,
        views,
        category
        )
      VALUES
        (
          1,
          'GBU Spring Fest 2025',
          'Vol. 15, Issue 1',
          '2025-03-15',
          'https://cdn.thedecorjournalindia.com/wp-content/uploads/2022/11/9_Modern-day-marvel-Gautam-Buddha-University-by-CP-Kukreja-architects-transpires-fresh-vibe-and-ancient-wisdom.jpg?lossy=1&resize=1920%2C1357&ssl=1&strip=all',
          'Highlights of GBU''s Spring Fest - cultural nights, competitions, and student showcases.',
          '/newsletters/spring-fest-2025.pdf',
          1245,
          'Events'
);

      INSERT INTO events
        (
        id,
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
        )
      VALUES
        (
          1,
          'GBU Tech Symposium 2024',
          'A state-level symposium with talks and presentations on cutting-edge technologies by students and industry experts.',
          'School of Engineering, GBU',
          'Main Auditorium, GBU Campus',
          'Seminar',
          'Offline',
          'past',
          'Free',
          300,
          '2024-07-10 09:00:00',
          '2024-07-10 17:00:00',
          '09:00 AM',
          '2024',
          'https://www.ux4g.gov.in/assets/img/awareness-workshop/gbu-19-11-24/900x18.webp',
          'https://forms.gle/gbu-tech-symposium-2024',
          '["Tech", "Symposium", "Engineering"]'
      ::jsonb,
  '["https://img1.com", "https://img2.com"]'::jsonb,
  '[{"time": "09:00 AM", "activity": "Registration"}, {"time": "10:00 AM", "activity": "Keynote"}]'::jsonb,
  '[{"name": "Dr. Rajesh", "designation": "HOD", "topic": "AI Trends"}]'::jsonb
);

      -- =====================================
      -- INSERT MEDIA GALLERY DATA
      -- =====================================
      INSERT INTO media_gallery
        (id, title, category, year, published_date, images)
      VALUES
        (1, '15th Annual Convocation Ceremony', 'Convocation', '2025', '2025-05-12', '["https://www.ic3ecsbhi.com/Gallery/20231224_134240.jpg", "https://www.ic3ecsbhi.com/Events/IMG-20231224-WA0082.jpg", "https://hostels.gbu.ac.in/uploads/eventsfiles/photos/65a98a5384fb0_GBU-Convocation.jpeg"]'
      ::jsonb),
      (2, 'National Sports Meet 2025', 'Sports', '2025', '2025-02-18', '["https://www.gbu.ac.in/Content/img/sports/banner2.jpg", "https://www.gbu.ac.in/Content/img/sports/banner1.jpg"]'::jsonb),
      (3, 'Annual Cultural Fest - Rhythms 2025', 'Cultural', '2025', '2025-03-10', '["https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=600&q=80", "https://www.gbu.ac.in/Content/img/cc/Artboard%201abhivyanjana7.jpg"]'::jsonb),
      (4, 'International Research Symposium', 'Academic', '2025', '2025-04-08', '["https://images.unsplash.com/photo-1560472354-b33ff0c44a43?auto=format&fit=crop&w=600&q=80"]'::jsonb),
      (5, 'Campus Life - Spring Moments', 'Campus Life', '2025', '2025-03-25', '["https://cdn.thedecorjournalindia.com/wp-content/uploads/2022/11/9_Modern-day-marvel-Gautam-Buddha-University-by-CP-Kukreja-architects-transpires-fresh-vibe-and-ancient-wisdom.jpg?lossy=1&resize=1920%2C1357&ssl=1&strip=all", "https://images.lifestyleasia.com/wp-content/uploads/sites/7/2022/11/03131617/1-inside-image-816-x-576-horizontal.jpeg", "https://hawmagazine.com/wp-content/uploads/2023/11/DSF8939-croped-1.jpg"]'::jsonb),
      (6, 'Tech Symposium 2025', 'Events', '2025', '2025-01-22', '["https://www.gbu.ac.in/Content/gbudata/incubation/Incubation_Pic9.jpg", "https://www.ic3ecsbhi.com/dsf8951%20copy.jpeg"]'::jsonb),
      (7, 'Robotics Workshop & Expo', 'Academic', '2024', '2024-08-10', '["https://www.ux4g.gov.in/assets/img/awareness-workshop/gbu-19-11-24/900x1.webp", "https://static.toiimg.com/thumb/msid-104795413%2Cwidth-1280%2Cheight-720%2Cresizemode-72/104795413.jpg"]'::jsonb),
      (8, 'Faculty Development Program 2024', 'Academic', '2024', '2024-12-12', '["https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=600&q=80"]'::jsonb);
      INSERT INTO tenders
        (
        id,
        title,
        description,
        reference_no,
        category,
        tender_type,
        published_date,
        closing_date,
        document_url,
        is_active
        )
      VALUES
        (
          1,
          'Supply of IT Equipment and Software Licenses',
          'Procurement of desktops, networking hardware, and software licenses for the academic block.',
          'GBU/TND/2026/001',
          'Information Technology',
          'RFQ',
          '2026-04-01',
          '2026-05-10',
          '/documents/tender-001.pdf',
          TRUE
        ),
        (
          2,
          'Construction of Water Treatment Facility',
          'Design, construction, and commissioning of a campus water treatment plant.',
          'GBU/TND/2026/002',
          'Infrastructure',
          'RFP',
          '2026-03-20',
          '2026-04-05',
          '/documents/tender-002.pdf',
          TRUE
        ),
        (
          3,
          'AMC for HVAC Systems',
          'Annual maintenance contract for HVAC units across hostels and teaching blocks.',
          'GBU/TND/2026/003',
          'Maintenance',
          'RFE',
          '2026-01-10',
          '2026-02-15',
          '/documents/tender-003.pdf',
          TRUE
        );

      INSERT INTO recruitments
        (
        id,
        title,
        description,
        reference_no,
        category,
        tab_id,
        published_date,
        closing_date,
        is_active
        )
      VALUES
        (
          1,
          'Advertisement of Professors',
          'Inviting applications for Professor positions across multiple schools.',
          'GBU/Admn/2026/01',
          'teaching',
          'professors',
          '2026-04-10',
          '2026-05-31',
          TRUE
        ),
        (
          2,
          'Advertisement of Associate Professors',
          'Applications invited for Associate Professor roles in engineering and sciences.',
          'GBU/Admn/2026/02',
          'teaching',
          'associate',
          '2026-04-11',
          '2026-06-05',
          TRUE
        ),
        (
          3,
          'Advertisement for Assistants',
          'Recruitment notice for non-teaching assistant roles.',
          'GBU/Admn/2026/03',
          'non-teaching',
          'assistants',
          '2026-04-12',
          '2026-05-20',
          TRUE
        ),
        (
          4,
          'Advertisement for Research Interns',
          'Openings for project and research interns under sponsored projects.',
          'GBU/Admn/2026/04',
          'project-research',
          'interns',
          '2026-04-12',
          '2026-05-25',
          TRUE
        ),
        (
          5,
          'Advertisement of Workers',
          'Engagement notice for support and operations workers.',
          'GBU/Admn/2026/05',
          'others',
          'workers',
          '2026-04-13',
          '2026-05-15',
          TRUE
        ),
        (
          6,
          'Archived Professor Recruitment 2023',
          'Archived teaching recruitment for Professor positions.',
          'GBU/Admn/2023/01',
          'teaching',
          'professors',
          '2023-01-10',
          '2023-01-20',
          TRUE
        ),
        (
          7,
          'Archived Associate Recruitment 2022',
          'Archived teaching recruitment for Associate Professor positions.',
          'GBU/Admn/2022/05',
          'teaching',
          'associate',
          '2022-08-01',
          '2022-08-12',
          TRUE
        ),
        (
          8,
          'Archived Staff Recruitment 2021',
          'Archived non-teaching staff recruitment cycle.',
          'GBU/Admn/2021/12',
          'non-teaching',
          'assistants',
          '2021-11-20',
          '2021-12-05',
          TRUE
        );

      INSERT INTO recruitment_documents
        (
        recruitment_id,
        name,
        document_type,
        file_url,
        description,
        sort_order,
        is_active
        )
      VALUES
        (1, 'Extension Notice', 'notice', '/documents/recruitments/2026-professors-extension.pdf', 'Official extension notification', 1, TRUE),
        (1, 'Detailed Advertisement', 'advertisement', '/documents/recruitments/2026-professors-detail.pdf', 'Complete job advertisement', 2, TRUE),
        (1, 'Application Form (PDF)', 'application-pdf', '/documents/recruitments/2026-professors-form.pdf', 'Downloadable application form', 3, TRUE),
        (2, 'Detailed Advertisement', 'advertisement', '/documents/recruitments/2026-associate-detail.pdf', 'Associate Professor recruitment advertisement', 1, TRUE),
        (2, 'Application Form (Word)', 'application-word', '/documents/recruitments/2026-associate-form.docx', 'Editable application form', 2, TRUE),
        (3, 'Detailed Advertisement', 'advertisement', '/documents/recruitments/2026-assistants-detail.pdf', 'Assistant recruitment advertisement', 1, TRUE),
        (3, 'Application Form (PDF)', 'application-pdf', '/documents/recruitments/2026-assistants-form.pdf', 'Assistant application form', 2, TRUE),
        (4, 'Detailed Advertisement', 'advertisement', '/documents/recruitments/2026-interns-detail.pdf', 'Research intern recruitment details', 1, TRUE),
        (4, 'Application Form (Word)', 'application-word', '/documents/recruitments/2026-interns-form.docx', 'Intern application form', 2, TRUE),
        (5, 'Detailed Advertisement', 'advertisement', '/documents/recruitments/2026-workers-detail.pdf', 'Worker recruitment details', 1, TRUE),
        (6, 'Archive Notice', 'archive', '/documents/recruitments/2023-professors-archive.pdf', 'Archived recruitment notice', 1, TRUE),
        (7, 'Archive Notice', 'archive', '/documents/recruitments/2022-associate-archive.pdf', 'Archived recruitment notice', 1, TRUE),
        (8, 'Archive Notice', 'archive', '/documents/recruitments/2021-staff-archive.pdf', 'Archived recruitment notice', 1, TRUE);

      INSERT INTO users
        (name, email, role, password_hash, is_active, email_verified)
      VALUES
        (
          'Super Admin',
          'admin@gbu.ac.in',
          'super_admin',
          '$2a$12$dEzir0NPhvUD3RZ5QAzeSO2213TvpwDlvBcMwtaRqLkQi484bAJ3e',
          TRUE,
          TRUE
        ),
        (
          'School User',
          'school@gbu.ac.in',
          'school',
          '$2a$12$eJxabWOjjEIk3ew/4cTOieuB8Lriq8CG7wxz2z/QD24cb5en1dFb2',
          TRUE,
          TRUE
        ),
        (
          'Faculty User',
          'faculty@gbu.ac.in',
          'faculty',
          '$2a$12$EBWLo4rfeBJMD9LEkqCyZu/tuZNWyMYLVn1yNcwKMxnXV0g5HPlN.',
          TRUE,
          TRUE
        );

      SELECT setval(
  pg_get_serial_sequence('events', 'id'),
  COALESCE((SELECT MAX(id) FROM events), 1),
  true
);

      SELECT setval(
  pg_get_serial_sequence('media_gallery', 'id'),
  COALESCE((SELECT MAX(id) FROM media_gallery), 1),
  true
);

      SELECT setval(
  pg_get_serial_sequence('tenders', 'id'),
  COALESCE((SELECT MAX(id) FROM tenders), 1),
  true
);

      SELECT setval(
  pg_get_serial_sequence('recruitments', 'id'),
  COALESCE((SELECT MAX(id) FROM recruitments), 1),
  true
);

      SELECT setval(
  pg_get_serial_sequence('recruitment_documents', 'id'),
  COALESCE((SELECT MAX(id) FROM recruitment_documents), 1),
  true
);

      SELECT setval(
  pg_get_serial_sequence('users', 'id'),
  COALESCE((SELECT MAX(id) FROM users), 1),
  true
);

      SELECT setval(
  pg_get_serial_sequence('auth_refresh_tokens', 'id'),
  COALESCE((SELECT MAX(id) FROM auth_refresh_tokens), 1),
  true
);

      SELECT setval(
  pg_get_serial_sequence('password_reset_otps', 'id'),
  COALESCE((SELECT MAX(id) FROM password_reset_otps), 1),
  true
);

      SELECT setval(
  pg_get_serial_sequence('newsletters', 'id'),
  COALESCE((SELECT MAX(id) FROM newsletters), 0) + 1,
  false
);

      -- =====================================
      -- PERMISSIONS FOR BACKEND APP USER
      -- =====================================
      -- Keep this role name aligned with DATABASE_URL username.
      DO $$
      BEGIN
        IF EXISTS (SELECT 1
        FROM pg_roles
        WHERE rolname = 'gbu-user') THEN
        GRANT USAGE ON SCHEMA public TO "gbu-user";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "gbu-user";
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "gbu-user";
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "gbu-user";
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO "gbu-user";
      ELSE
    RAISE NOTICE 'Role "gbu-user" not found. Create it or update grant role in schema.sql.';
      END
      IF;
END $$;

      -- =====================================
      -- CHECK DATA
      -- =====================================
      SELECT COUNT(*) AS notices_count
      FROM notices;
      SELECT COUNT(*) AS news_count
      FROM news;
      SELECT COUNT(*) AS events_count
      FROM events;
      SELECT COUNT(*) AS media_gallery_count
      FROM media_gallery;
      SELECT COUNT(*) AS newsletters_count
      FROM newsletters;
      SELECT COUNT(*) AS tenders_count
      FROM tenders;
      SELECT COUNT(*) AS recruitments_count
      FROM recruitments;
      SELECT COUNT(*) AS recruitment_documents_count
      FROM recruitment_documents;
      SELECT COUNT(*) AS users_count
      FROM users;
      SELECT COUNT(*) AS auth_refresh_tokens_count
      FROM auth_refresh_tokens;
      SELECT COUNT(*) AS password_reset_otps_count
      FROM password_reset_otps;

      COMMIT;