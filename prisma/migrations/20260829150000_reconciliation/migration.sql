-- AlterEnum
ALTER TYPE "NotificationEvent" ADD VALUE 'INVOICE_NOT_PAID';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "paidAt" TIMESTAMP(3);

