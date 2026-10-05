#!/usr/bin/env node
/**
 * Create a Super Admin, or reset the password of an existing one.
 *
 *   npm run create-admin -- you@example.com "YourStrongPassword"
 *
 * Run it from the backend folder. The backend does not need to be stopped.
 */
const fs = require('fs');
const path = require('path');
const { randomBytes, scrypt } = require('crypto');

// Load backend/.env so DATABASE_URL is available.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Same format the backend uses: scrypt$<salt>$<hash>
function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scrypt(pw, salt, 64, (err, hash) => (err ? reject(err) : resolve(`scrypt$${salt.toString('base64')}$${hash.toString('base64')}`)));
  });
}

async function main() {
  const [emailArg, password, ...nameParts] = process.argv.slice(2);
  const email = (emailArg || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) {
    console.error('Usage: npm run create-admin -- you@example.com "YourStrongPassword" [Your Name]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('The password must be at least 8 characters.');
    process.exit(1);
  }
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const name = nameParts.join(' ').trim() || 'Super Admin';
    const passwordHash = await hashPassword(password);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.role !== 'superadmin') {
      console.error(`${email} already belongs to a customer (${existing.role}). Use a different email for the Super Admin.`);
      process.exit(1);
    }
    if (existing) {
      await prisma.user.update({ where: { email }, data: { passwordHash, active: true } });
      console.log(`Password reset for Super Admin ${email}.`);
    } else {
      await prisma.user.create({ data: { email, name, role: 'superadmin', passwordHash } });
      console.log(`Super Admin created: ${email}`);
    }
    console.log('Sign in at http://localhost:3100/login');
  } catch (e) {
    if (/no such table|does not exist/i.test(String(e.message))) {
      console.error('The database tables are missing. Run first:  npx prisma migrate dev --name accounts');
    } else {
      console.error('Failed:', e.message);
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
main();
