import { GenerationStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

// LLD §2.4
// Response 200: [{
//   id, invoiceNo, projectName, batch, amount, invoiceDate,
//   generationStatus, amountConfirmationStatus, approvalStatus,
//   driveDocUrl, declineReason, actionedAt
// }]
type InvoiceWithSheetRow = Prisma.InvoiceGetPayload<{ include: { sheetRow: true } }>;

// gateDriveDocUrl: true for the resource-facing listing — withholds the
// document link until gate 1 (amountConfirmationStatus) is CONFIRMED (LLD
// §0.9). Admin's view is never gated this way.
function toListItem(invoice: InvoiceWithSheetRow, gateDriveDocUrl: boolean) {
  const withheld = gateDriveDocUrl && invoice.amountConfirmationStatus !== "CONFIRMED";
  return {
    id: invoice.id,
    invoiceNo: invoice.invoiceNo,
    projectName: invoice.sheetRow.projectName,
    batch: invoice.sheetRow.batch,
    amount: Number(invoice.amount),
    invoiceDate: invoice.invoiceDate,
    generationStatus: invoice.generationStatus,
    amountConfirmationStatus: invoice.amountConfirmationStatus,
    approvalStatus: invoice.approvalStatus,
    driveDocUrl: withheld ? null : invoice.driveDocUrl,
    declineReason: invoice.declineReason,
    actionedAt: invoice.actionedAt,
  };
}

// GET /admin/invoices?resourceId=&status=
// `status` is interpreted as generationStatus (LLD §0.8 — flagged).
export async function listAdminInvoices(filters: { resourceId?: string; status?: GenerationStatus }) {
  const invoices = await prisma.invoice.findMany({
    where: {
      ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
      ...(filters.status ? { generationStatus: filters.status } : {}),
    },
    include: { sheetRow: true },
    orderBy: { createdAt: "desc" },
  });
  return invoices.map((invoice) => toListItem(invoice, false));
}

// Exposed for reuse by GET /admin/resources/:id (LLD §2.5), whose
// `invoices` field is specified as "same shape as §2.4" (admin's ungated view).
export function toAdminInvoiceListItem(invoice: InvoiceWithSheetRow) {
  return toListItem(invoice, false);
}

// GET /resource/invoices — always scoped to session.
export async function listResourceInvoices(resourceId: string) {
  const invoices = await prisma.invoice.findMany({
    where: { resourceId },
    include: { sheetRow: true },
    orderBy: { createdAt: "desc" },
  });
  return invoices.map((invoice) => toListItem(invoice, true));
}
