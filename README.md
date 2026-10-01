# UVA Pool Club Inventory Management System

A browser-based inventory and checkout tool for the University of Virginia Pool and Billiards Club. Executive members can track club equipment, manage member details, and record equipment handoffs.

## Features

- **Equipment inventory:** Add and remove cases, shafts, butts, and accessories. Search and sort the equipment list by its key fields.
- **Cue identification:** Playing, break, and jump cues can be distinguished for shafts and butts. New serial numbers receive a type prefix and cue-role suffix, for example `SH-123-P` for a playing shaft or `BU-123-J` for a jump butt. Cases and accessories do not receive cue-role suffixes.
- **Issue and return:** Record checkouts to club members and returns through a dedicated workspace or the equipment list. Handoffs are recorded in activity history.
- **Member directory:** Add and edit member names, email addresses, phone numbers, and class years. The directory also shows each member's assigned equipment.
- **Roster import:** Import members from a Google Sheets link or a CSV file. Sheet columns can include `Name` (or `First name` and `Last name`), `Email`, `Phone`, and `Year`.
- **Settings:** Choose light or dark appearance and set the club name and season label.

## Run locally

**Requirements:** Node.js and npm.

From the repository root, install dependencies and start the development server:

```sh
npm ci
npm run dev
```

Vite prints the local URL in the terminal, usually `http://localhost:5173/`.

## Project commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local development server. |
| `npm run build` | Type-check the app and create a production build in `dist/`. |
| `npm run preview` | Preview the production build locally. |
| `npm run lint` | Run Oxlint. |

## Repository layout

| Path | Contents |
| --- | --- |
| `src/App.tsx` | Application views, inventory and member workflows, and local persistence. |
| `src/App.css` | Dashboard, forms, responsive layout, and theme styles. |
| `src/index.css` | Global typography and design tokens. |
| `src/main.tsx` | React application entry point. |
| `public/` | Static assets served by Vite. |

## Google Sheets access

The browser reads a CSV export from the supplied Google Sheets link. The sheet must be available through **General access: Anyone with the link (Viewer)** or published to the web. A private sheet redirects to Google sign-in and cannot be read by this client-only app. Use the CSV file importer for a manual import, or add Google authentication and a secured backend to support private sheets.

Roster sync matches imported members by email when available, otherwise by name. Matching records are updated without changing their member IDs, so equipment assignments remain linked. Members absent from the imported sheet are not automatically deleted.

## Data storage and privacy

Equipment, members, activity history, and settings are stored in the current browser profile using `localStorage`. They are not written to the Git repository or sent to an application database. Data is therefore local to that browser and does not automatically sync between executives or devices.

The GitHub repository is private, which limits access to the source code to repository collaborators. This does not add user accounts or shared data storage to the app. Also, a Google Sheet configured for link access can be read by anyone who has its link.

For shared, confidential club records, the application needs authenticated users and a secured server-side database; private Google Sheets access additionally needs Google authentication. Do not treat browser-local storage as a shared or access-controlled database.
{
