-- CreateEnum
CREATE TYPE "AmountConfirmationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- AlterEnum
BEGIN;
CREATE TYPE "NotificationEvent_new" AS ENUM ('PAYOUT_GENERATED', 'DOCUMENT_VERIFIED', 'DOCUMENT_REJECTED', 'BANK_UNLOCKED', 'INVOICE_DECLINED', 'DOCUMENT_REUPLOADED', 'AMOUNT_REJECTED');
ALTER TABLE "NotificationLog" ALTER COLUMN "eventType" TYPE "NotificationEvent_new" USING ("eventType"::text::"NotificationEvent_new");
ALTER TYPE "NotificationEvent" RENAME TO "NotificationEvent_old";
ALTER TYPE "NotificationEvent_new" RENAME TO "NotificationEvent";
DROP TYPE "NotificationEvent_old";
COMMIT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "amountConfirmationStatus" "AmountConfirmationStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "amountConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "amountRejectionReason" TEXT;

