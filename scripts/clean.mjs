#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const outputDirectory = fileURLToPath(new URL('../dist', import.meta.url));

await rm(outputDirectory, {
  force: true,
  recursive: true,
});
