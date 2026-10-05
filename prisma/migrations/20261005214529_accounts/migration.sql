-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "autoAssign" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "User" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Plan" (
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
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "planId" TEXT,
    "planName" TEXT NOT NULL,
    "chatLimit" INTEGER,
    "chatsUsed" INTEGER NOT NULL DEFAULT 0,
    "numbersLimit" INTEGER NOT NULL,
    "agentsLimit" INTEGER NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "amountPaid" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "note" TEXT NOT NULL DEFAULT '',
    "activatedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Subscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
    "workspaceId" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "phone" TEXT,
    "botEnabled" BOOLEAN NOT NULL DEFAULT true,
    "workingBotId" TEXT,
    "offHoursBotId" TEXT,
    "workDays" TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
    "workStart" TEXT NOT NULL DEFAULT '09:00',
    "workEnd" TEXT NOT NULL DEFAULT '18:00',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Account_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Account_workingBotId_fkey" FOREIGN KEY ("workingBotId") REFERENCES "Bot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Account_offHoursBotId_fkey" FOREIGN KEY ("offHoursBotId") REFERENCES "Bot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Account" ("botEnabled", "createdAt", "id", "label", "offHoursBotId", "phone", "timezone", "workDays", "workEnd", "workStart", "workingBotId") SELECT "botEnabled", "createdAt", "id", "label", "offHoursBotId", "phone", "timezone", "workDays", "workEnd", "workStart", "workingBotId" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE TABLE "new_Bot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "name" TEXT NOT NULL,
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT NOT NULL DEFAULT '',
    "companyName" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "industry" TEXT NOT NULL DEFAULT '',
    "assistantName" TEXT NOT NULL DEFAULT '',
    "primaryGoal" TEXT NOT NULL DEFAULT '',
    "supportEmail" TEXT NOT NULL DEFAULT '',
    "websiteUrl" TEXT NOT NULL DEFAULT '',
    "phoneNumbers" TEXT NOT NULL DEFAULT '',
    "knowledge" TEXT NOT NULL DEFAULT '',
    "welcomeMessage" TEXT NOT NULL DEFAULT '',
    "fallbackMessage" TEXT NOT NULL DEFAULT 'Thanks for your message! Our team will reply shortly.',
    "useProducts" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Bot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Bot" ("aiEnabled", "assistantName", "companyName", "createdAt", "fallbackMessage", "id", "industry", "instructions", "knowledge", "location", "name", "phoneNumbers", "primaryGoal", "supportEmail", "updatedAt", "useProducts", "websiteUrl", "welcomeMessage") SELECT "aiEnabled", "assistantName", "companyName", "createdAt", "fallbackMessage", "id", "industry", "instructions", "knowledge", "location", "name", "phoneNumbers", "primaryGoal", "supportEmail", "updatedAt", "useProducts", "websiteUrl", "welcomeMessage" FROM "Bot";
DROP TABLE "Bot";
ALTER TABLE "new_Bot" RENAME TO "Bot";
CREATE TABLE "new_Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "name" TEXT,
    "assignedToId" TEXT,
    "botPaused" BOOLEAN NOT NULL DEFAULT false,
    "needsHuman" BOOLEAN NOT NULL DEFAULT false,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT NOT NULL DEFAULT '',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Contact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Contact_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Contact" ("accountId", "botPaused", "firstSeenAt", "id", "lastMessageAt", "messageCount", "name", "needsHuman", "optedOut", "tags", "waId") SELECT "accountId", "botPaused", "firstSeenAt", "id", "lastMessageAt", "messageCount", "name", "needsHuman", "optedOut", "tags", "waId" FROM "Contact";
DROP TABLE "Contact";
ALTER TABLE "new_Contact" RENAME TO "Contact";
CREATE UNIQUE INDEX "Contact_accountId_waId_key" ON "Contact"("accountId", "waId");
CREATE TABLE "new_Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "price" REAL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "description" TEXT NOT NULL DEFAULT '',
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "imageUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Product_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Product" ("categoryId", "createdAt", "currency", "description", "id", "imageUrl", "inStock", "name", "price", "sku") SELECT "categoryId", "createdAt", "currency", "description", "id", "imageUrl", "inStock", "name", "price", "sku" FROM "Product";
DROP TABLE "Product";
ALTER TABLE "new_Product" RENAME TO "Product";
CREATE TABLE "new_ProductCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "name" TEXT NOT NULL,
    CONSTRAINT "ProductCategory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ProductCategory" ("id", "name") SELECT "id", "name" FROM "ProductCategory";
DROP TABLE "ProductCategory";
ALTER TABLE "new_ProductCategory" RENAME TO "ProductCategory";
CREATE UNIQUE INDEX "ProductCategory_workspaceId_name_key" ON "ProductCategory"("workspaceId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Subscription_workspaceId_startsAt_idx" ON "Subscription"("workspaceId", "startsAt");
