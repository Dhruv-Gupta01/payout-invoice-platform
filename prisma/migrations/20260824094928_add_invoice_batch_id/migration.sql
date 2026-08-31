-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "batchId" TEXT;

-- CreateIndex
CREATE INDEX "Invoice_batchId_idx" ON "Invoice"("batchId");
