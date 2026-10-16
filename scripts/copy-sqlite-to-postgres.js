#!/usr/bin/env node
/**
 * Copy everything from the old SQLite file into the new PostgreSQL (Supabase) database.
 *
 *   1. Point DATABASE_URL / DIRECT_URL in .env at Supabase
 *   2. npx prisma migrate dev --name init        (creates the empty tables)
 *   3. npm run copy-data                          (default file: prisma/chat.db)
 *      npm run copy-data -- path/to/other.db
 *
 * Needs Node.js 22.5 or newer (uses the built-in node:sqlite). Safe to re-run: rows that
 * already exist are skipped. The SQLite file is only read, never changed.
 */
const fs = require('fs');
const path = require('path');

/** Parents before children, so foreign keys are satisfied. */
const ORDER = ['Workspace', 'User', 'Plan', 'Subscription', 'Bot', 'Flow', 'FlowStep', 'Account', 'Contact', 'Message',
  'ProductCategory', 'Product', 'PasswordReset', 'Setting', 'Payment'];

function convert(value, field) {
  if (value === null || value === undefined) return value;
  switch (field.type) {
    case 'Boolean': return value === true || value === 1 || value === '1' || value === 'true';
    case 'DateTime': {
      const d = typeof value === 'number' || /^\d+$/.test(String(value)) ? new Date(Number(value)) : new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    case 'Int': return Math.trunc(Number(value));
    case 'Float': return Number(value);
    default: return value;
  }
}

/** Copy all known tables. `db` is a node:sqlite DatabaseSync; `models` come from Prisma's DMMF. */
async function copyAll(db, prisma, models, log = console.log) {
  const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  const summary = {};
  for (const name of ORDER) {
    const model = models.find((m) => m.name === name);
    if (!model || !existing.has(name)) continue;
    const cols = new Set(db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name));
    const scalars = model.fields.filter((f) => f.kind === 'scalar' && cols.has(f.name));
    const rows = db.prepare(`SELECT * FROM "${name}"`).all();
    const delegate = prisma[name.charAt(0).toLowerCase() + name.slice(1)];
    let copied = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500).map((r) => Object.fromEntries(scalars.map((f) => [f.name, convert(r[f.name], f)])));
      const res = await delegate.createMany({ data: batch, skipDuplicates: true });
      copied += res.count;
    }
    summary[name] = { found: rows.length, copied };
    log(`${name.padEnd(16)} ${String(rows.length).padStart(6)} found, ${String(copied).padStart(6)} copied`);
  }
  return summary;
}

async function main() {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'prisma', 'chat.db'));
  if (!fs.existsSync(file)) {
    console.error(`SQLite file not found: ${file}\nPass the path: npm run copy-data -- path/to/chat.db`);
    process.exit(1);
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    console.error('This needs Node.js 22.5 or newer (built-in SQLite). Check with: node --version');
    process.exit(1);
  }
  const { PrismaClient, Prisma } = require('@prisma/client');
  const prisma = new PrismaClient();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    console.log(`Copying from ${file}\n`);
    await copyAll(db, prisma, Prisma.dmmf.datamodel.models);
    console.log('\nDone. Start the backend with: npm run start:dev');
  } catch (e) {
    console.error('\nCopy failed:', e.message);
    if (/does not exist/i.test(e.message)) console.error('Create the tables first: npx prisma migrate dev --name init');
    process.exit(1);
  } finally {
    db.close();
    await prisma.$disconnect();
  }
}

if (require.main === module) main();
module.exports = { copyAll, convert };
