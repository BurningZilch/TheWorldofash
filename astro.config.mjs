// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

import sentry from '@sentry/astro';
import spotlightjs from '@spotlightjs/astro';
import svelte from "@astrojs/svelte";

import node from '@astrojs/node';

// https://astro.build/config
export default defineConfig({
    site: 'https://example.com',
    output: 'server',
    adapter: node({
        mode: 'standalone'
    }),
    integrations: [mdx(), sitemap(), sentry(), spotlightjs(), svelte()],
});
