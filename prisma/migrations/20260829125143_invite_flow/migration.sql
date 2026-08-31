-- AlterEnum
ALTER TYPE "NotificationEvent" ADD VALUE 'INVITE_SENT';

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "inviteToken" TEXT,
ADD COLUMN     "inviteTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Resource_inviteToken_key" ON "Resource"("inviteToken");

