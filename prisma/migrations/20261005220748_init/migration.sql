-- CreateTable
CREATE TABLE "PasswordReset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordReset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Plan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "chatLimit" INTEGER,
    "durationDays" INTEGER NOT NULL,
    "price" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "numbersLimit" INTEGER NOT NULL DEFAULT 1,
    "agentsLimit" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trialForSignup" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Plan" ("active", "agentsLimit", "chatLimit", "createdAt", "currency", "description", "durationDays", "id", "name", "numbersLimit", "price", "sortOrder") SELECT "active", "agentsLimit", "chatLimit", "createdAt", "currency", "description", "durationDays", "id", "name", "numbersLimit", "price", "sortOrder" FROM "Plan";
DROP TABLE "Plan";
ALTER TABLE "new_Plan" RENAME TO "Plan";
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL DEFAULT '',
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "workspaceId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "seeUnassigned" BOOLEAN NOT NULL DEFAULT true,
    "lastAssignedAt" DATETIME,
    "lastLoginAt" DATETIME,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_User" ("active", "createdAt", "email", "id", "lastAssignedAt", "lastLoginAt", "mobile", "name", "passwordHash", "role", "seeUnassigned", "workspaceId") SELECT "active", "createdAt", "email", "id", "lastAssignedAt", "lastLoginAt", "mobile", "name", "passwordHash", "role", "seeUnassigned", "workspaceId" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");
