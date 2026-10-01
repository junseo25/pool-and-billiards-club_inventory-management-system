# UVA Pool Club Inventory Management System

A responsive inventory and checkout application for the University of Virginia Pool and Billiards Club. Approved club executives sign in to manage shared equipment, member records, and loan activity.

## Features

- **Equipment inventory:** Add and remove cases, shafts, butts, and accessories; search and sort the inventory.
- **Cue identification:** Playing, break, and jump use is available for shafts and butts. Serial numbers use a type prefix and cue suffix, such as `SH-123-P` (playing shaft), `BU-123-B` (break butt), and `SH-123-J` (jump shaft). Cases and accessories use a type prefix only.
- **Issue and return:** Record equipment checkouts and returns from the dedicated handoff workspace or the inventory list.
- **Member directory:** Add and edit contact details and class year. Assigned equipment remains connected to the member record.
- **Roster import:** Import a CSV or Excel (.xlsx) file or sync a link-accessible Google Sheet. Imports update matching members without removing members absent from the sheet.
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
4. Invited accounts are automatically added to executive access by the database trigger. For an existing project, run `supabase/migrations/20261001_approve_invited_executives.sql` once in the SQL Editor. It also approves previously invited accounts.

5. Copy `.env.example` to `.env.local` and fill in the project URL and public anon key from the Supabase project API settings:

	```env
	VITE_SUPABASE_URL=https://your-project.supabase.co
	VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
	```

6. Install dependencies and start the app as described below.

The app intentionally has no self-service sign-up. Sending a Supabase administrator invitation grants executive access automatically. Accounts created without an invitation do not receive access. The SQL schema does not grant browser clients permission to add themselves to that allowlist.

## Invitation links

### Executive profiles, invitations, and merging

After the earlier migrations, run `supabase/migrations/20261001_profiles_invitations_merges.sql` in the SQL Editor. Existing and new executives are prompted once after signing in for their full name and U.S. phone number. The database links their account to a matching roster email or name-plus-phone record and carries over equipment loans. Ambiguous matches can be reviewed and merged from Members. Phone fields format as `(434) 555-0123` while typing.

Members have an **Invite** button beside **Edit**. Sending an invitation grants executive access. The button requires an email and is disabled for members with an existing account. Email errors, including Supabase rate limits, are shown inline. Invitations are sent through the `invite-member` Edge Function; no admin credential goes into the browser. Configure custom SMTP for invitations to club members.

Deploy the function from this repository using the Supabase CLI (requires access to the club project):

```sh
supabase login
supabase functions deploy invite-member --project-ref vhpduyfewrtnvpdnmnsf
supabase secrets set APP_URL=https://junseo25.github.io/pool-and-billiards-club_inventory-management-system/ --project-ref vhpduyfewrtnvpdnmnsf
```

The hosted function uses Supabase's provided `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. It verifies the caller with Supabase Auth and checks `executive_access` before sending. Set the hosted app address as the Auth Site URL, and also allow `https://junseo25.github.io/pool-and-billiards-club_inventory-management-system/?setup=password` in Auth Redirect URLs. Keep the invitation email link as `{{ .ConfirmationURL }}`.

Inside **Edit member**, select **Merge duplicate**, choose the member record to keep, review the preview, and confirm **Merge members**. The retained member's populated contact fields stay; empty fields are filled from the duplicate. Loans and the login link transfer in one transaction. Two different login accounts cannot be merged. Historical activity entries stay unchanged.

In Supabase **Authentication → URL Configuration**, set **Site URL** to the app's address (for local development, `http://localhost:5173/`). Add that address to the allowed redirect URLs too. For GitHub Pages, use `https://junseo25.github.io/pool-and-billiards-club_inventory-management-system/` after deploying the updated app.

Keep the Invite user email template's link pointed at `{{ .ConfirmationURL }}`. From **Authentication → Users**, invite the executive by email; the database automatically adds their account to `executive_access`. Opening the invitation establishes a session and displays the password setup form before the inventory workspace. Password recovery links also display this form. If a custom redirect drops the invite fragment's `type`, use the app URL with `?setup=password` and allow that redirect URL in Supabase.

Invitations can be sent from the Members tab through the deployed Edge Function, or from the Supabase dashboard. The browser app does not contain an admin key. Public sign-ups should stay disabled.

## Local development

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

Existing projects must run `supabase/migrations/20261001_approve_invited_executives.sql`, then `supabase/migrations/20261001_executive_roster.sql` in the Supabase SQL Editor before using this version. New projects can run the updated `supabase/schema.sql`.

Approved executives are automatically added to the member directory, including existing executive accounts when the migration runs. An existing member with the same email is linked instead of creating another record. When an invited account has no full name, its email username is used until the roster import or an executive edits the name.

Imports support public Google Sheets CSV exports, CSV uploads, and Excel `.xlsx` uploads (the first nonempty visible worksheet). Save older `.xls` files as `.xlsx` first. Email matching ignores case and surrounding spaces. Name-plus-phone matching ignores extra spaces and phone punctuation, including the US +1 prefix. Repeated matching rows update one record; blank imported fields preserve existing contact details and class year. Ambiguous matches stop the import without partial writes, and names alone do not merge people with different contacts. Equipment loans and executive account links remain attached to the same member ID.

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
