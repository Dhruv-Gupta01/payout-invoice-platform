-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('FLAGGED', 'QUEUED', 'PROCESSING', 'GENERATED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('AADHAAR', 'PAN', 'PHOTO', 'BANK_PROOF', 'NDA');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING_REVIEW', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NotificationEvent" AS ENUM ('INVOICE_GENERATED', 'DOCUMENT_VERIFIED', 'DOCUMENT_REJECTED', 'BANK_UNLOCKED', 'INVOICE_DECLINED', 'DOCUMENT_REUPLOADED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SENT', 'FAILED');

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "contactNo" TEXT,
    "pan" TEXT,
    "beneficiaryName" TEXT,
    "accountNo" TEXT,
    "bankName" TEXT,
    "ifsc" TEXT,
    "passwordHash" TEXT,
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "bankLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SheetRow" (
    "id" TEXT NOT NULL,
    "resourceEmail" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "projectName" TEXT NOT NULL,
    "batch" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "hours" DECIMAL(65,30) NOT NULL,
    "rate" DECIMAL(65,30) NOT NULL,
    "computedAmount" DECIMAL(65,30) NOT NULL,
    "sheetAmount" DECIMAL(65,30),
    "rawData" JSONB NOT NULL,
    "removedFromSheet" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SheetRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "sheetRowId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "amountInWords" TEXT,
    "invoiceDate" TIMESTAMP(3),
    "driveFileId" TEXT,
    "driveDocUrl" TEXT,
    "generationStatus" "GenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "declineReason" TEXT,
    "actionedAt" TIMESTAMP(3),
    "flagReason" TEXT,
    "flagAcknowledgedBy" TEXT,
    "flagAcknowledgedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "docType" "DocumentType" NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "rejectionReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankUnlockLog" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "unlockedById" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "reLockedAt" TIMESTAMP(3),

    CONSTRAINT "BankUnlockLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "eventType" "NotificationEvent" NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "relatedType" TEXT NOT NULL,
    "relatedId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "NotificationStatus" NOT NULL DEFAULT 'SENT',
    "errorMessage" TEXT,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_email_key" ON "Resource"("email");

-- CreateIndex
CREATE INDEX "Resource_email_idx" ON "Resource"("email");

-- CreateIndex
CREATE INDEX "SheetRow_resourceEmail_idx" ON "SheetRow"("resourceEmail");

-- CreateIndex
CREATE UNIQUE INDEX "SheetRow_resourceEmail_projectName_batch_month_key" ON "SheetRow"("resourceEmail", "projectName", "batch", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNo_key" ON "Invoice"("invoiceNo");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_sheetRowId_key" ON "Invoice"("sheetRowId");

-- CreateIndex
CREATE INDEX "Invoice_resourceId_idx" ON "Invoice"("resourceId");

-- CreateIndex
CREATE INDEX "Invoice_generationStatus_idx" ON "Invoice"("generationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Document_resourceId_docType_key" ON "Document"("resourceId", "docType");

-- CreateIndex
CREATE INDEX "BankUnlockLog_resourceId_idx" ON "BankUnlockLog"("resourceId");

-- AddForeignKey
ALTER TABLE "SheetRow" ADD CONSTRAINT "SheetRow_resourceEmail_fkey" FOREIGN KEY ("resourceEmail") REFERENCES "Resource"("email") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_sheetRowId_fkey" FOREIGN KEY ("sheetRowId") REFERENCES "SheetRow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankUnlockLog" ADD CONSTRAINT "BankUnlockLog_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankUnlockLog" ADD CONSTRAINT "BankUnlockLog_unlockedById_fkey" FOREIGN KEY ("unlockedById") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
