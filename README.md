# World of Ash

An interactive blog and map project built with [Astro](https://astro.build) and [Svelte](https://svelte.dev).

## 🚀 Features

- **Interactive Maps**: Built with MapLibre GL and D3.
- **Weather Visualization**: Historical weather data visualization with timeline controls.
- **Blog**: MDX-powered content.
- **Performance**: Optimized for speed with Astro's island architecture.

## 🛠️ Tech Stack

- **Framework**: Astro 5
- **UI Components**: Svelte 5
- **Maps**: MapLibre GL JS, D3.js
- **Hosting**: AWS Amplify (Serverless/Lambda)
- **Package Manager**: pnpm

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `pnpm install`            | Installs dependencies                            |
| `pnpm dev`                | Starts local dev server at `localhost:4321`      |
| `pnpm build`              | Build your production site to `.amplify-hosting` |
| `pnpm preview`            | Preview your build locally, before deploying     |
| `pnpm astro ...`          | Run CLI commands like `astro add`, `astro check` |

## 🚀 Project Structure

```text
├── public/          # Static assets
├── src/
│   ├── components/  # Astro and Svelte components
│   ├── content/     # Markdown/MDX content collections
│   ├── layouts/     # Page layouts
│   ├── pages/       # File-based routing
│   └── styles/      # Global styles
├── astro.config.mjs # Astro configuration
├── amplify.yml      # AWS Amplify build settings
└── package.json
```

## ☁️ Deployment

This project is configured for deployment on **AWS Amplify**.
The build output is set to `.amplify-hosting` to support server-side features via AWS Lambda.

```bash
pnpm run build
```
