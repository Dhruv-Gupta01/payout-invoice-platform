import { Router } from "express";
import multer from "multer";
import { GenerationStatus } from "@prisma/client";
import { AppDependencies } from "../dependencies";
import { asyncHandler } from "../lib/asyncHandler";
import { runSync } from "./syncService";
import {
  generateInvoices,
  acknowledgeFlag,
  getBatchStatus,
  retryInvoice,
  InvoiceNotFailedError,
  reprocessInvoice,
  AmountNotRejectedError,
  regenerateDocument,
  InvoiceNotGeneratedError,
  ResourceNotReadyError,
  reopenInvoice,
  InvoiceNotDeclinedError,
} from "./invoiceGenerationService";
import { verifyDocument, rejectDocument } from "./documentReviewService";
import { unlockBank } from "./bankUnlockService";
import { sendInvite } from "./inviteService";
import {
  runReconciliation,
  markInvoicePaid,
  ReconciliationFileFormatError,
  InvoiceNotEligibleError,
} from "./reconciliationService";
import { listDocuments } from "../resource/documentService";
import { listAdminInvoices } from "../invoices/invoiceListingService";
import { listResources, getResourceDetail } from "./resourceListingService";
import { listSheetRows } from "./sheetRowListingService";

const upload = multer({ storage: multer.memoryStorage() });

// Other admin resource-detail endpoints (LLD §2.5) are added in a later
// phase, test-first.
export function createAdminRouter(deps: AppDependencies): Router {
  const router = Router();

  router.post("/sync", asyncHandler(async (_req, res) => {
    const result = await runSync(deps.sheetsProvider);
    res.status(200).json(result);
  }));

  router.get("/invoices", asyncHandler(async (req, res) => {
    const result = await listAdminInvoices({
      resourceId: typeof req.query.resourceId === "string" ? req.query.resourceId : undefined,
      status: typeof req.query.status === "string" ? (req.query.status as GenerationStatus) : undefined,
    });
    res.status(200).json(result);
  }));

  router.post("/invoices/generate", asyncHandler(async (req, res) => {
    const { sheetRowIds } = req.body ?? {};
    const result = await generateInvoices(sheetRowIds ?? [], deps.jobQueue);
    res.status(200).json(result);
  }));

  router.post("/invoices/:invoiceId/acknowledge-flag", asyncHandler(async (req, res) => {
    try {
      const result = await acknowledgeFlag(req.params.invoiceId, req.session.userId!, deps.jobQueue);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof ResourceNotReadyError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  }));

  router.get("/invoices/status/:batchId", asyncHandler(async (req, res) => {
    const result = await getBatchStatus(req.params.batchId);
    res.status(200).json(result);
  }));

  router.post("/invoices/:invoiceId/retry", asyncHandler(async (req, res) => {
    try {
      const result = await retryInvoice(req.params.invoiceId, deps.jobQueue);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof InvoiceNotFailedError) {
        return res.status(400).json({ error: "Invoice is not in a FAILED state" });
      }
      throw err;
    }
  }));

  router.post("/invoices/:invoiceId/reprocess", asyncHandler(async (req, res) => {
    try {
      const result = await reprocessInvoice(req.params.invoiceId, deps.jobQueue, deps.driveProvider);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof AmountNotRejectedError) {
        return res.status(400).json({ error: "Invoice's amount confirmation is not in a REJECTED state" });
      }
      throw err;
    }
  }));

  router.post("/invoices/:invoiceId/regenerate-document", asyncHandler(async (req, res) => {
    try {
      const result = await regenerateDocument(req.params.invoiceId, deps.driveProvider, deps.docsProvider);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof InvoiceNotGeneratedError) {
        return res.status(400).json({ error: "Invoice has not been generated yet" });
      }
      throw err;
    }
  }));

  router.post("/invoices/:invoiceId/reopen", asyncHandler(async (req, res) => {
    try {
      const result = await reopenInvoice(req.params.invoiceId, deps.emailProvider);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof InvoiceNotDeclinedError) {
        return res.status(400).json({ error: "Invoice is not in a DECLINED state" });
      }
      throw err;
    }
  }));

  router.post("/documents/:id/verify", asyncHandler(async (req, res) => {
    const result = await verifyDocument(req.params.id, req.session.userId!, deps.emailProvider, deps.jobQueue);
    res.status(200).json(result);
  }));

  router.post("/documents/:id/reject", asyncHandler(async (req, res) => {
    const { reason } = req.body ?? {};
    const result = await rejectDocument(req.params.id, req.session.userId!, reason, deps.emailProvider);
    res.status(200).json(result);
  }));

  router.get("/sheet-rows", asyncHandler(async (_req, res) => {
    const result = await listSheetRows();
    res.status(200).json(result);
  }));

  router.get("/resources", asyncHandler(async (_req, res) => {
    const result = await listResources();
    res.status(200).json(result);
  }));

  router.get("/resources/:id", asyncHandler(async (req, res) => {
    const result = await getResourceDetail(req.params.id);
    res.status(200).json(result);
  }));

  router.post("/resources/:id/unlock-bank", asyncHandler(async (req, res) => {
    const result = await unlockBank(req.params.id, req.session.userId!, deps.emailProvider);
    res.status(200).json(result);
  }));

  router.post("/resources/:id/send-invite", asyncHandler(async (req, res) => {
    const result = await sendInvite(req.params.id, deps.emailProvider);
    res.status(200).json(result);
  }));

  router.get("/resources/:id/documents", asyncHandler(async (req, res) => {
    const result = await listDocuments(req.params.id);
    res.status(200).json(result);
  }));

  router.post("/reconciliation", upload.single("file"), asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file" });
    }
    try {
      const result = await runReconciliation(req.file.buffer, deps.emailProvider);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof ReconciliationFileFormatError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  }));

  router.post("/invoices/:invoiceId/mark-paid", asyncHandler(async (req, res) => {
    try {
      const result = await markInvoicePaid(req.params.invoiceId);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof InvoiceNotEligibleError) {
        return res.status(400).json({ error: "Invoice is not eligible to be marked paid" });
      }
      throw err;
    }
  }));

  return router;
}
