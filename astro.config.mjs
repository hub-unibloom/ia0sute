import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://ai.sensacional.site',
  output: 'server',
  adapter: cloudflare({
    imageService: 'cloudflare',
  }),
  trailingSlash: 'ignore',
  build: {
    inlineStylesheets: 'always',
  },
});
