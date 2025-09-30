# Repository Guidelines

## Project Structure & Module Organization
The Astro app lives under `src/`. Route-facing pages belong in `src/pages`, while reusable UI sits in `src/components` (Astro) and `src/components/*.svelte` for interactive blocks. Shared layouts (`src/layouts`), scoped styles (`src/styles`), and static assets (`src/assets`, `public/`) keep concerns separated. Markdown and MDX entries live in `src/content`; update `content.config.ts` when introducing new collections. Built artifacts are emitted to `dist/` by `astro build`.

## Build, Test, and Development Commands
Install dependencies with `pnpm install` (pnpm 10+ is expected). Use `pnpm dev` for a hot-reloading dev server, and `pnpm build` to produce the static bundle that matches Amplify's `amplify.yml`. Run `pnpm preview` to smoke-test the production build locally. For type and integration checks, run `pnpm astro check` before opening a pull request.

## Coding Style & Naming Conventions
Stick to 2-space indentation across Astro, Svelte, and JSON files. Name Astro components in PascalCase (`LatestPostCard.astro`) and keep route files kebab-cased (`blog/[slug].astro`). Co-locate CSS in `src/styles` and prefer utility classes already defined there. Favor descriptive prop names and use TypeScript definitions in `src/consts.ts` or local `.d.ts` files when typing new data sources.

## Testing Guidelines
Automated tests are currently lightweight; rely on `pnpm astro check` for content validation and TypeScript diagnostics. When adding tests, place them beside the feature (e.g. `WeatherMap.test.ts`) and mirror the file name. Aim for meaningful coverage of data transforms and critical components such as `WeatherMap.svelte`. Document manual verification steps in the pull request when backend integrations change.

## Commit & Pull Request Guidelines
Commits to date are short; switch to clear, imperative summaries (`Add weather layer toggle`) and keep related changes together. Reference linked issues in the body when applicable. Pull requests should explain the change, list any new commands or migrations, and include screenshots or GIFs for UI updates. Confirm `pnpm build` passes before requesting review.

## Content & Configuration Tips
Add new posts or pages as MDX under `src/content` and register frontmatter fields in `content.config.ts` for schema safety. Update SEO defaults in `src/consts.ts` and shared metadata in `src/components/BaseHead.astro`. Secrets belong in `.env`; never commit keys, and rely on Amplify to manage environment variables in deployment.
