import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
    type: 'content',
    // Type-check frontmatter using a schema
    schema: ({ image }) => z.object({
        title: z.string(),
        description: z.string().optional(),
        // Transform string to Date object
        pubDate: z.coerce.date(),
        updatedDate: z.coerce.date().optional(),
        heroImage: image().optional(),
        tags: z.array(z.string()).optional(),
        author: z.string().optional(),
        // Handling extra fields seen in frontmatter
        thumbnailimg: image().optional(),
        shareimg: image().optional(),
    }),
});

const project = defineCollection({
    type: 'content',
    schema: ({ image }) => z.object({
        title: z.string(),
        description: z.string().optional(),
        pubDate: z.coerce.date(),
        updatedDate: z.coerce.date().optional(),
        heroImage: image().optional(),
        tags: z.array(z.string()).optional(),
        // Handling extra fields seen in frontmatter
        thumbnailimg: image().optional(),
        shareimg: image().optional(),
    }),
});

export const collections = { blog, project };
