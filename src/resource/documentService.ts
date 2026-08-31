import { DocumentType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { DriveProvider } from "../providers/DriveProvider";
import { EmailProvider } from "../providers/EmailProvider";
import { notify } from "../notifications/notifier";

// LLD §2.7: type = aadhaar|pan|photo|bank_proof|nda in the URL, mapped to
// the DocumentType enum.
const DOC_TYPE_PARAM_MAP: Record<string, DocumentType> = {
  aadhaar: "AADHAAR",
  pan: "PAN",
  photo: "PHOTO",
  bank_proof: "BANK_PROOF",
  nda: "NDA",
};

export function parseDocTypeParam(param: string): DocumentType | null {
  return DOC_TYPE_PARAM_MAP[param] ?? null;
}

// LLD §2.7
// POST /resource/documents/:type
// Response 200: { docType, status: "PENDING_REVIEW", uploadedAt }
//
// Document has @@unique([resourceId, docType]) — "one active document per
// type; re-upload overwrites this row" (LLD §1 comment) — so this is an
// upsert, resetting review state on every (re-)upload.
//
// HLD §5.4/§7: re-upload after a REJECTED status notifies "the admin" —
// unspecified which one when there are several; this notifies whichever
// admin rejected it (the prior reviewedById), the only admin identity
// already on the record. Flagged as an assumption, not a specified behavior.
export async function uploadDocument(
  resourceId: string,
  docType: DocumentType,
  fileName: string,
  fileContent: Buffer,
  driveProvider: DriveProvider,
  emailProvider: EmailProvider
) {
  const existing = await prisma.document.findUnique({ where: { resourceId_docType: { resourceId, docType } } });

  const fileUrl = await driveProvider.uploadFile(fileName, fileContent);
  const uploadedAt = new Date();

  const doc = await prisma.document.upsert({
    where: { resourceId_docType: { resourceId, docType } },
    create: { resourceId, docType, fileUrl, status: "PENDING_REVIEW", uploadedAt },
    update: {
      fileUrl,
      status: "PENDING_REVIEW",
      rejectionReason: null,
      reviewedById: null,
      reviewedAt: null,
      uploadedAt,
    },
  });

  if (existing?.status === "REJECTED" && existing.reviewedById) {
    const rejectingAdmin = await prisma.adminUser.findUnique({ where: { id: existing.reviewedById } });
    if (rejectingAdmin) {
      await notify(emailProvider, "DOCUMENT_REUPLOADED", rejectingAdmin.email, "document", doc.id);
    }
  }

  return { docType: doc.docType, status: doc.status, uploadedAt: doc.uploadedAt };
}

// LLD §2.7
// GET /resource/documents
// GET /admin/resources/:id/documents
// Response 200: [{ id, docType, fileUrl, status, rejectionReason, reviewedAt, uploadedAt }]
// id added per §0.22 — POST /admin/documents/:id/verify and /reject need a
// specific Document id, which this list didn't previously expose.
export async function listDocuments(resourceId: string) {
  const documents = await prisma.document.findMany({
    where: { resourceId },
    orderBy: { docType: "asc" },
  });
  return documents.map((doc) => ({
    id: doc.id,
    docType: doc.docType,
    fileUrl: doc.fileUrl,
    status: doc.status,
    rejectionReason: doc.rejectionReason,
    reviewedAt: doc.reviewedAt,
    uploadedAt: doc.uploadedAt,
  }));
}
