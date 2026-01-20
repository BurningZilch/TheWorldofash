// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, passthroughImageService } from 'astro/config';

import sentry from '@sentry/astro';
import spotlightjs from '@spotlightjs/astro';
import svelte from "@astrojs/svelte";

import awsAmplify from 'astro-aws-amplify';

// https://astro.build/config
export default defineConfig({
    site: 'https://example.com',
    output: 'server',
    adapter: awsAmplify(),
    image: {
        service: passthroughImageService()
    },
    integrations: [
        mdx(),
        sitemap(),
        sentry(),
        // Only load Spotlight in dev mode
        process.env.NODE_ENV === 'development' ? spotlightjs() : null,
        svelte()
    ].filter(Boolean),
});
