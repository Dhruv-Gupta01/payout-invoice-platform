import { prisma } from "../lib/prisma";
import { listDocuments } from "../resource/documentService";
import { toAdminInvoiceListItem } from "../invoices/invoiceListingService";

// LLD §2.5
// GET /admin/resources
// Response 200: [{ id, name, email, totalInvoices, pending, approved, declined, pendingDocuments: boolean }]
//
// The LLD fixes the summary shape to exactly {pending, approved, declined}
// but the model has more granular states than that (two gates —
// AmountConfirmationStatus and ApprovalStatus — plus pre-generation
// GenerationStatus). Flagging the bucket definition used here rather than
// deciding silently:
//   - approved  = approvalStatus === "APPROVED"
//   - declined  = approvalStatus === "DECLINED" OR amountConfirmationStatus
//                 === "REJECTED" (the resource said no at either gate — same
//                 parallel treatment already used for notifications, see
//                 AMOUNT_REJECTED / INVOICE_DECLINED)
//   - pending   = totalInvoices - approved - declined (everything else: not
//                 yet generated, gate 1 pending, gate 2 pending)
// pendingDocuments: true if the resource has any Document with status
// PENDING_REVIEW (awaiting admin action) — not "not yet uploaded", which
// isn't a tracked state.
export async function listResources() {
  const resources = await prisma.resource.findMany({
    include: {
      invoices: { select: { approvalStatus: true, amountConfirmationStatus: true } },
      documents: { select: { status: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return resources.map((resource) => {
    const totalInvoices = resource.invoices.length;
    const approved = resource.invoices.filter((inv) => inv.approvalStatus === "APPROVED").length;
    const declined = resource.invoices.filter(
      (inv) => inv.approvalStatus === "DECLINED" || inv.amountConfirmationStatus === "REJECTED"
    ).length;
    const pending = totalInvoices - approved - declined;
    const pendingDocuments = resource.documents.some((doc) => doc.status === "PENDING_REVIEW");

    return {
      id: resource.id,
      name: resource.name,
      email: resource.email,
      totalInvoices,
      pending,
      approved,
      declined,
      pendingDocuments,
    };
  });
}

// LLD §2.5 / §0.25
// GET /admin/resources/:id
// Response 200: {
//   id, name, email, address, contactNo, pan,
//   beneficiaryName, accountNo, bankName, ifsc,
//   bankLocked, onboardingCompleted,
//   accountActivated,   // true once passwordHash is set (§0.25)
//   inviteExpiresAt,     // null if never invited or already accepted (§0.25)
//   invoices: [...],   // same shape as §2.4
//   documents: [...]   // same shape as §2.7
// }
export async function getResourceDetail(resourceId: string) {
  const resource = await prisma.resource.findUniqueOrThrow({
    where: { id: resourceId },
    include: { invoices: { include: { sheetRow: true }, orderBy: { createdAt: "desc" } } },
  });
  const documents = await listDocuments(resourceId);

  return {
    id: resource.id,
    name: resource.name,
    email: resource.email,
    address: resource.address,
    contactNo: resource.contactNo,
    pan: resource.pan,
    beneficiaryName: resource.beneficiaryName,
    accountNo: resource.accountNo,
    bankName: resource.bankName,
    ifsc: resource.ifsc,
    bankLocked: resource.bankLocked,
    onboardingCompleted: resource.onboardingCompleted,
    accountActivated: resource.passwordHash !== null,
    inviteExpiresAt: resource.inviteTokenExpiresAt,
    invoices: resource.invoices.map((invoice) => toAdminInvoiceListItem(invoice)),
    documents,
  };
}
