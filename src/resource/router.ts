import { Router } from "express";
import multer from "multer";
import { AppDependencies } from "../dependencies";
import { asyncHandler } from "../lib/asyncHandler";
import { completeOnboarding, OnboardingAlreadyCompletedError } from "./onboardingService";
import { parseDocTypeParam, uploadDocument, listDocuments } from "./documentService";
import { updateProfile, getProfile, ProfileLockedError } from "./profileService";
import { listResourceInvoices } from "../invoices/invoiceListingService";
import {
  approveInvoice,
  declineInvoice,
  confirmAmount,
  rejectAmount,
  NotYourInvoiceError,
  AmountNotConfirmedError,
} from "../invoices/invoiceActionService";

const upload = multer({ storage: multer.memoryStorage() });

export function createResourceRouter(deps: AppDependencies): Router {
  const router = Router();

  router.get("/profile", asyncHandler(async (req, res) => {
    const result = await getProfile(req.session.userId!);
    res.status(200).json(result);
  }));

  router.get("/invoices", asyncHandler(async (req, res) => {
    const result = await listResourceInvoices(req.session.userId!);
    res.status(200).json(result);
  }));

  router.post("/onboarding", asyncHandler(async (req, res) => {
    try {
      const result = await completeOnboarding(req.session.userId!, req.body ?? {}, deps.jobQueue);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof OnboardingAlreadyCompletedError) {
        return res.status(403).json({ error: "Onboarding already completed" });
      }
      throw err;
    }
  }));

  router.get("/documents", asyncHandler(async (req, res) => {
    const result = await listDocuments(req.session.userId!);
    res.status(200).json(result);
  }));

  router.post("/documents/:type", upload.single("file"), asyncHandler(async (req, res) => {
    const docType = parseDocTypeParam(req.params.type);
    if (!docType || !req.file) {
      return res.status(400).json({ error: "Invalid document type or missing file" });
    }
    const result = await uploadDocument(
      req.session.userId!,
      docType,
      req.file.originalname,
      req.file.buffer,
      deps.driveProvider,
      deps.emailProvider
    );
    res.status(200).json(result);
  }));

  router.put("/profile", asyncHandler(async (req, res) => {
    try {
      const result = await updateProfile(req.session.userId!, req.body ?? {});
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof ProfileLockedError) {
        return res.status(403).json({ error: "Details are locked. Ask your admin to unlock them." });
      }
      throw err;
    }
  }));

  router.post("/invoices/:invoiceId/confirm-amount", asyncHandler(async (req, res) => {
    try {
      const result = await confirmAmount(req.params.invoiceId, req.session.userId!);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof NotYourInvoiceError) {
        return res.status(403).json({ error: "Not your invoice" });
      }
      throw err;
    }
  }));

  router.post("/invoices/:invoiceId/reject-amount", asyncHandler(async (req, res) => {
    try {
      const { reason } = req.body ?? {};
      const result = await rejectAmount(req.params.invoiceId, req.session.userId!, reason, deps.emailProvider);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof NotYourInvoiceError) {
        return res.status(403).json({ error: "Not your invoice" });
      }
      throw err;
    }
  }));

  router.post("/invoices/:invoiceId/approve", asyncHandler(async (req, res) => {
    try {
      const result = await approveInvoice(req.params.invoiceId, req.session.userId!);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof NotYourInvoiceError) {
        return res.status(403).json({ error: "Not your invoice" });
      }
      if (err instanceof AmountNotConfirmedError) {
        return res.status(403).json({ error: "Confirm your payout amount first" });
      }
      throw err;
    }
  }));

  router.post("/invoices/:invoiceId/decline", asyncHandler(async (req, res) => {
    try {
      const { reason } = req.body ?? {};
      const result = await declineInvoice(req.params.invoiceId, req.session.userId!, reason, deps.emailProvider);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof NotYourInvoiceError) {
        return res.status(403).json({ error: "Not your invoice" });
      }
      if (err instanceof AmountNotConfirmedError) {
        return res.status(403).json({ error: "Confirm your payout amount first" });
      }
      throw err;
    }
  }));

  return router;
}
