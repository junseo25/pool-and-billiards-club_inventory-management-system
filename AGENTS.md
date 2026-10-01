# Repository Guidelines

## Project Structure & Module Organization

This React/TypeScript application manages UVA Pool Club equipment, members, loans, and history. `src/App.tsx` coordinates authentication and workflows; `src/components/` contains reusable UI, and `src/lib/` holds Supabase configuration and roster, phone, membership, and history logic. Styles live in `src/App.css` and `src/index.css`; assets belong in `src/assets/` or `public/`. Database definitions are in `supabase/schema.sql`, upgrades in `supabase/migrations/`, and invitation handling in `supabase/functions/invite-member/`. Tests live in `tests/`. `dist/` is generated output.

## Build, Test, and Development Commands

Use Node.js 24, matching the GitHub Pages workflow.

- `npm ci`: install dependencies from the lockfile.
- `npm run dev`: start Vite locally.
- `npm run build`: run TypeScript checks and generate `dist/`.
- `npm run preview`: serve the production build locally.
- `npm run lint`: run Oxlint with React and TypeScript rules.
- `npm test`: run `tests/*.test.mjs` with Node's built-in test runner.

## Coding Style & Naming Conventions

Follow existing TypeScript style: two-space indentation, single quotes, and no trailing statement semicolons. Use PascalCase for components and component filenames (for example, `MemberDirectory.tsx`), camelCase for functions and variables, and descriptive lowercase utility filenames. Use type-only imports where appropriate. Preserve React hook rules and accessible button labels. Follow surrounding CSS and SQL conventions; no dedicated formatter is configured.

## Testing Guidelines

Tests use `node:test`, `node:assert/strict`, and PGlite for isolated PostgreSQL behavior. Name files `tests/<feature>.test.mjs`. Add regression coverage for changed business logic, authorization, roster matching, loan safeguards, and migrations. No numeric coverage threshold is configured. Run tests, lint, and build before submitting code changes. For UI changes, check narrow layouts and both themes manually.

## Commit & Pull Request Guidelines

Recent commits use concise imperative subjects, such as `Add member deletion with loan and history safeguards`; no conventional-commit prefix is required. Keep changes focused. PRs should describe behavior changes, report validation, link relevant issues, and include screenshots for visual changes. Explain required migration steps. Pushes to `main` trigger GitHub Pages deployment.

## Security & Configuration

Copy `.env.example` to `.env.local` for the Supabase URL and public anon key. Keep service-role credentials out of frontend code and commits. Preserve executive-access checks and row-level security. For database changes, update the fresh-install schema and add a migration named like `20261001_delete_members.sql`; document application order in `README.md`.
