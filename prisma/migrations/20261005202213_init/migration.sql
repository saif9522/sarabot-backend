-- CreateTable
CREATE TABLE "Account" (
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
    CONSTRAINT "Account_workingBotId_fkey" FOREIGN KEY ("workingBotId") REFERENCES "Bot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Account_offHoursBotId_fkey" FOREIGN KEY ("offHoursBotId") REFERENCES "Bot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT NOT NULL DEFAULT '',
    "knowledge" TEXT NOT NULL DEFAULT '',
    "welcomeMessage" TEXT NOT NULL DEFAULT '',
    "fallbackMessage" TEXT NOT NULL DEFAULT 'Thanks for your message! Our team will reply shortly.',
    "useProducts" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "KeywordRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "matchType" TEXT NOT NULL DEFAULT 'contains',
    "reply" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "KeywordRule_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "name" TEXT,
    "botPaused" BOOLEAN NOT NULL DEFAULT false,
    "needsHuman" BOOLEAN NOT NULL DEFAULT false,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT NOT NULL DEFAULT '',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Contact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentBy" TEXT NOT NULL,
    "externalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "price" REAL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "description" TEXT NOT NULL DEFAULT '',
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "imageUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_accountId_waId_key" ON "Contact"("accountId", "waId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_externalId_key" ON "Message"("externalId");

-- CreateIndex
CREATE INDEX "Message_contactId_createdAt_idx" ON "Message"("contactId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_name_key" ON "ProductCategory"("name");
