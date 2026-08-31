/*
  Warnings:

  - Added the required column `resourceName` to the `SheetRow` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "SheetRow" ADD COLUMN     "resourceName" TEXT NOT NULL;
