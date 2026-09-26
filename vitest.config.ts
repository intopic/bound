import { configDefaults, defineConfig } from 'vitest/config';

// integrations/* are packages of their own, tested in their own folders with their own dependencies.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'integrations/**'] } });
