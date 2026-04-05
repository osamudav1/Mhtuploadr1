# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Telegram Bot

A Telegram bot is integrated into the API server (`artifacts/api-server/src/bot.ts`). It:
- Accepts `.mht` / `.mhtml` files (manga chapter files saved from browser)
- Extracts images in sequential order from the MIME multipart format
- Converts images to PDF using pdfkit + sharp
- Sends the PDF back to the user via Telegram

**Bot token**: `TELEGRAM_BOT_TOKEN` secret is required (already configured)

**Bot commands**:
- `/start` — Welcome message
- `/help` — Usage instructions
- Send a `.mht` document — Bot processes and returns a PDF

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
