#!/usr/bin/env node
/**
 * Bureau CLI (open core): serve / start / session, plus whatever `--plugin` /
 * `BUREAU_PLUGINS` load. See cli.ts for the dispatch.
 */

import { loadWorkspaceEnv, runCli } from "./cli.js"

loadWorkspaceEnv(import.meta.url)

void runCli(process.argv.slice(2), { metaUrl: import.meta.url })
