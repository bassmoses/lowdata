import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      network: 'src/network/index.ts',
      forms: 'src/forms/index.ts',
      media: 'src/media/index.ts',
      react: 'src/react/index.ts',
      vue: 'src/vue/index.ts',
      svelte: 'src/svelte/index.ts',
      angular: 'src/angular/index.ts',
      solid: 'src/solid/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2019',
    platform: 'neutral',
    splitting: false,
    treeshake: true,
    minify: false,
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.js' };
    },
  },
  // Script-tag build of the core client (no React) for bandwidth-constrained
  // consumers without a bundler — referenced by the `unpkg`/`jsdelivr` fields.
  {
    entry: { lowdata: 'src/index.ts' },
    format: ['iife'],
    globalName: 'Lowdata',
    platform: 'browser',
    target: 'es2019',
    sourcemap: true,
    minify: true,
    dts: false,
    clean: false,
  },
]);
