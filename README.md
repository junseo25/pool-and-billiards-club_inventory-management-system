# UVA Pool Club Inventory Management System

A responsive inventory and checkout application for the University of Virginia Pool and Billiards Club. Approved club executives sign in to manage shared equipment, member records, and loan activity.

## Features

- **Equipment inventory:** Add and remove cases, shafts, butts, and accessories; search and sort the inventory.
- **Cue identification:** Playing, break, and jump use is available for shafts and butts. Serial numbers use a type prefix and cue suffix, such as `SH-123-P` (playing shaft), `BU-123-B` (break butt), and `SH-123-J` (jump shaft). Cases and accessories use a type prefix only.
- **Issue and return:** Record equipment checkouts and returns from the dedicated handoff workspace or the inventory list.
- **Member directory:** Add and edit contact details and class year. Assigned equipment remains connected to the member record.
- **Roster import:** Import a CSV file or sync a link-accessible Google Sheet. Imports update matching members without removing members absent from the sheet.
- **Settings:** Select light or dark appearance and customize the club name and season label.

## Technology

- React, TypeScript, and Vite for the client application.
- Supabase Auth for email/password sign-in.
- Supabase Postgres for shared inventory, members, and activity.
- Row-level security (RLS) policies that require both an authenticated session and an approved executive access record.

## Supabase setup

1. Create a Supabase project for the club.
2. In the Supabase SQL Editor, run [`supabase/schema.sql`](supabase/schema.sql). It creates the tables and RLS policies.
3. In **Authentication → Providers**, enable email/password sign-in and disable public sign-ups. Invite each executive from **Authentication → Users** and have them set a password.
4. Add each invited user to the executive allowlist. In the SQL Editor, replace the example address and run:

	```sql
	insert into public.executive_access (user_id, email)
	select id, email
	from auth.users
	where lower(email) = lower('executive@virginia.edu')
	on conflict (user_id) do update set email = excluded.email;
	```

5. Copy `.env.example` to `.env.local` and fill in the project URL and public anon key from the Supabase project API settings:

	```env
	VITE_SUPABASE_URL=https://your-project.supabase.co
	VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
	```

6. Install dependencies and start the app as described below.

The app intentionally has no self-service sign-up. Adding someone to Supabase Auth alone does not grant access; they must also have a row in `executive_access`. The SQL schema does not grant browser clients permission to add themselves to that allowlist.

## Run locally

**Requirements:** Node.js and npm.

```sh
npm ci
npm run dev
```

Vite prints the local URL, usually `http://localhost:5173/`. Without valid Supabase environment variables, the app shows setup instructions instead of loading local or sample records.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server. |
| `npm run build` | Type-check and create the production build in `dist/`. |
| `npm run preview` | Preview the production build locally. |
| `npm run lint` | Run Oxlint. |

## Data model and access

The database contains four tables:

- `executive_access` maps approved Supabase Auth user IDs to executive accounts.
- `members` stores member names and contact details.
- `equipment` stores equipment and its current member assignment.
- `activity_log` stores checkout, return, and removal events.

All approved executives share the same club records. RLS checks the signed-in user against `executive_access` on every data request. The client uses only the Supabase public anon key; never put a Supabase `service_role` key in this repository or in browser code.

Auth sessions persist across browser sessions. Operational records live in Supabase, so approved users see the same data across devices. Appearance, club name, season label, and the saved Sheet URL are client preferences and remain in that browser profile.

## Google Sheets

The current sync reads a CSV export in the browser. The sheet must allow **Anyone with the link (Viewer)** access or be published to the web; anyone with the link can therefore read that sheet. Private-sheet OAuth is not implemented. CSV uploads are also supported and are saved to the secured Supabase members table.

Supported headers include `Name` (or `Full name`, `Member`, or `Member name`), or `First name` and `Last name`, plus optional `Email`, `Phone`, and `Year` fields.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/App.tsx` | Authenticated application views and inventory/member workflows. |
| `src/lib/supabase.ts` | Supabase client configuration. |
| `src/App.css` | Responsive interface and light/dark themes. |
| `src/index.css` | Global typography and design tokens. |
| `supabase/schema.sql` | Database tables, access allowlist, grants, and RLS policies. |
| `.env.example` | Required client environment variable names; safe template only. |
